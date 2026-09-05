import type { QueryFn } from "../deeplake-schema.js";
import { FAMILIAR_FORGET_HOLD_DESCRIPTION } from "../hooks/upload-summary.js";
import { sqlIdent, sqlStr } from "../utils/sql.js";
import { sha256DigestCanonical } from "./canonicalize.js";
import type { FamiliarForgetSurfaceResult } from "./forgetting.js";
import {
  assertFamiliarPromotionCommitV1,
  type FamiliarPromotionCommitV1,
} from "./promotion-store.js";
import type { Digest } from "./types.js";

export type FamiliarSourceSuppressionResult = {
  embedding: FamiliarForgetSurfaceResult;
  summary: FamiliarForgetSurfaceResult;
  sourceTombstoneDigest?: Digest;
  summaryPath?: string;
};

function text(value: string): string {
  return `'${sqlStr(value)}'`;
}

function jsonLiteral(value: unknown): string {
  // Session message JSON is stored as JSONB. Match the capture path's JSON
  // literal rule: escape SQL single quotes only; do not run JSON through the
  // generic backslash escaper because that would alter JSON semantics.
  return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
}

function digestEvidence(value: unknown): Digest {
  return sha256DigestCanonical({
    kind: "arobi.familiar-erasure-verification",
    version: 1,
    ...((value ?? {}) as Record<string, unknown>),
  });
}

function parseMessage(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function isEmbeddingAbsent(value: unknown): boolean {
  return value === null || value === undefined || (Array.isArray(value) && value.length === 0);
}

function safeOriginalType(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 80) : undefined;
}

function safeTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return Number.isFinite(Date.parse(value)) ? value : undefined;
}

function safeSessionId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Replace the exact legacy source event with a non-secret audit tombstone and
 * place the exact per-session wiki summary into regeneration HOLD.
 *
 * This function is intentionally strict:
 * - the source row must be unique;
 * - its canonical JSON digest must equal promotion.sourceEventDigest;
 * - event id/session binding must match the promotion;
 * - only safe chronology/type metadata survives the source rewrite;
 * - the summary path is derived from the source row's author + trusted session
 *   id, never from fuzzy text or semantic matching;
 * - the held summary is emptied and its embedding nulled, then read back.
 *
 * `uploadSummary()` treats FAMILIAR_FORGET_HOLD_DESCRIPTION as a hard write
 * barrier, preventing an in-flight wiki worker from racing stale plaintext back
 * into the summary after this operation completes.
 */
export async function suppressFamiliarSourceAndSummary(args: {
  query: QueryFn;
  sessionsTableName: string;
  memoryTableName?: string;
  commit: FamiliarPromotionCommitV1;
  now?: string;
}): Promise<FamiliarSourceSuppressionResult> {
  assertFamiliarPromotionCommitV1(args.commit);
  const sessionTable = sqlIdent(args.sessionsTableName);
  const now = args.now ?? new Date().toISOString();

  try {
    const sourceRows = (await args.query(
      `SELECT id, message, message_embedding, author, path, creation_date FROM "${sessionTable}" ` +
        `WHERE id = ${text(args.commit.sourceEventId)} LIMIT 2`,
    )) as Array<Record<string, unknown>>;

    if (sourceRows.length !== 1) {
      const detail = sourceRows.length === 0
        ? "The promoted source event is absent, so its canonical digest and summary lineage cannot be re-verified."
        : "Multiple session rows matched the promoted sourceEventId; source suppression is ambiguous.";
      return {
        embedding: { surface: "EMBEDDING_INDEX", state: "FAILED", detail },
        summary: { surface: "SUMMARY_PROJECTION", state: "FAILED", detail },
      };
    }

    const row = sourceRows[0];
    const original = parseMessage(row.message);
    if (!original) {
      const detail = "The promoted source session row does not contain parseable canonical event JSON.";
      return {
        embedding: { surface: "EMBEDDING_INDEX", state: "FAILED", detail },
        summary: { surface: "SUMMARY_PROJECTION", state: "FAILED", detail },
      };
    }
    if (original.id !== args.commit.sourceEventId) {
      const detail = "The source row id and embedded event id disagree.";
      return {
        embedding: { surface: "EMBEDDING_INDEX", state: "FAILED", detail },
        summary: { surface: "SUMMARY_PROJECTION", state: "FAILED", detail },
      };
    }
    const originalDigest = sha256DigestCanonical(original);
    if (originalDigest !== args.commit.sourceEventDigest) {
      const detail = "The canonical source event digest does not match the authoritative promotion commit.";
      return {
        embedding: { surface: "EMBEDDING_INDEX", state: "FAILED", detail },
        summary: { surface: "SUMMARY_PROJECTION", state: "FAILED", detail },
      };
    }

    const originalSessionId = safeSessionId(original.session_id);
    if (
      args.commit.sourceSessionId !== undefined &&
      originalSessionId !== args.commit.sourceSessionId
    ) {
      const detail = "The source event session id does not match the authoritative promotion commit.";
      return {
        embedding: { surface: "EMBEDDING_INDEX", state: "FAILED", detail },
        summary: { surface: "SUMMARY_PROJECTION", state: "FAILED", detail },
      };
    }

    const tombstone = {
      id: args.commit.sourceEventId,
      type: "familiar_memory_forgotten_source",
      forgotten: true,
      original_event_digest: args.commit.sourceEventDigest,
      familiar_promotion_commit_id: args.commit.commitId,
      ...(originalSessionId ? { session_id: originalSessionId } : {}),
      ...(safeTimestamp(original.timestamp) ? { timestamp: safeTimestamp(original.timestamp) } : {}),
      ...(safeOriginalType(original.type) ? { original_type: safeOriginalType(original.type) } : {}),
    } as const;
    const tombstoneDigest = sha256DigestCanonical(tombstone);
    const tombstoneBytes = Buffer.byteLength(JSON.stringify(tombstone), "utf8");

    await args.query(
      `UPDATE "${sessionTable}" SET message = ${jsonLiteral(tombstone)}, ` +
        `message_embedding = NULL, size_bytes = ${tombstoneBytes}, ` +
        `description = ${text("familiar-memory-forgotten-source")}, ` +
        `last_update_date = ${text(now)} WHERE id = ${text(args.commit.sourceEventId)}`,
    );

    const verifiedRows = (await args.query(
      `SELECT id, message, message_embedding, author FROM "${sessionTable}" ` +
        `WHERE id = ${text(args.commit.sourceEventId)} LIMIT 2`,
    )) as Array<Record<string, unknown>>;
    if (verifiedRows.length !== 1) {
      const detail = "The source event tombstone could not be uniquely read back after suppression.";
      return {
        embedding: { surface: "EMBEDDING_INDEX", state: "FAILED", detail },
        summary: { surface: "SUMMARY_PROJECTION", state: "FAILED", detail },
      };
    }
    const verified = verifiedRows[0];
    const verifiedMessage = parseMessage(verified.message);
    if (
      !verifiedMessage ||
      verifiedMessage.type !== "familiar_memory_forgotten_source" ||
      verifiedMessage.forgotten !== true ||
      verifiedMessage.original_event_digest !== args.commit.sourceEventDigest ||
      verifiedMessage.familiar_promotion_commit_id !== args.commit.commitId ||
      !isEmbeddingAbsent(verified.message_embedding)
    ) {
      const detail = "The source event tombstone or embedding suppression failed read-back verification.";
      return {
        embedding: { surface: "EMBEDDING_INDEX", state: "FAILED", detail },
        summary: { surface: "SUMMARY_PROJECTION", state: "FAILED", detail },
      };
    }

    const embedding: FamiliarForgetSurfaceResult = {
      surface: "EMBEDDING_INDEX",
      state: "VERIFIED",
      verificationDigest: digestEvidence({
        surface: "EMBEDDING_INDEX",
        sourceEventId: args.commit.sourceEventId,
        sourceEventDigest: args.commit.sourceEventDigest,
        sourceTombstoneDigest: tombstoneDigest,
        state: "SOURCE_TOMBSTONED_EMBEDDING_ABSENT",
      }),
      detail:
        "The exact digest-bound source event was replaced by an audit tombstone and its live semantic embedding is absent.",
    };

    if (!args.memoryTableName?.trim()) {
      return {
        embedding,
        summary: {
          surface: "SUMMARY_PROJECTION",
          state: "FAILED",
          detail: "No memoryTableName was supplied, so the exact session summary cannot be placed into regeneration HOLD.",
        },
        sourceTombstoneDigest: tombstoneDigest,
      };
    }
    const sourceSessionId = args.commit.sourceSessionId ?? originalSessionId;
    const author = typeof verified.author === "string" ? verified.author.trim() : "";
    if (!sourceSessionId || !author) {
      return {
        embedding,
        summary: {
          surface: "SUMMARY_PROJECTION",
          state: "FAILED",
          detail: "The exact summary path cannot be derived because source session id or author is unavailable.",
        },
        sourceTombstoneDigest: tombstoneDigest,
      };
    }

    const summaryPath = `/summaries/${author}/${sourceSessionId}.md`;
    const memoryTable = sqlIdent(args.memoryTableName);
    await args.query(
      `UPDATE "${memoryTable}" SET summary = '', summary_embedding = NULL, size_bytes = 0, ` +
        `description = ${text(FAMILIAR_FORGET_HOLD_DESCRIPTION)}, ` +
        `last_update_date = ${text(now)} WHERE path = ${text(summaryPath)}`,
    );
    const summaries = (await args.query(
      `SELECT path, summary, summary_embedding, description FROM "${memoryTable}" ` +
        `WHERE path = ${text(summaryPath)} LIMIT 2`,
    )) as Array<Record<string, unknown>>;

    if (summaries.length > 1) {
      return {
        embedding,
        summary: {
          surface: "SUMMARY_PROJECTION",
          state: "FAILED",
          detail: "Multiple wiki summary rows matched the exact source session path.",
        },
        sourceTombstoneDigest: tombstoneDigest,
        summaryPath,
      };
    }
    if (summaries.length === 0) {
      return {
        embedding,
        summary: {
          surface: "SUMMARY_PROJECTION",
          state: "NOT_APPLICABLE",
          detail: "No persisted wiki summary exists for the exact source session; the source event remains tombstoned against future generation.",
        },
        sourceTombstoneDigest: tombstoneDigest,
        summaryPath,
      };
    }

    const summaryRow = summaries[0];
    if (
      summaryRow.summary !== "" ||
      !isEmbeddingAbsent(summaryRow.summary_embedding) ||
      summaryRow.description !== FAMILIAR_FORGET_HOLD_DESCRIPTION
    ) {
      return {
        embedding,
        summary: {
          surface: "SUMMARY_PROJECTION",
          state: "FAILED",
          detail: "The exact wiki summary did not enter empty, embedding-free regeneration HOLD state.",
        },
        sourceTombstoneDigest: tombstoneDigest,
        summaryPath,
      };
    }

    return {
      embedding,
      summary: {
        surface: "SUMMARY_PROJECTION",
        state: "VERIFIED",
        verificationDigest: digestEvidence({
          surface: "SUMMARY_PROJECTION",
          summaryPath,
          sourceEventId: args.commit.sourceEventId,
          sourceEventDigest: args.commit.sourceEventDigest,
          sourceTombstoneDigest: tombstoneDigest,
          state: "SUMMARY_EMPTY_EMBEDDING_ABSENT_REGENERATION_HELD",
        }),
        detail:
          "The exact source-session wiki summary is empty, embedding-free, and held against stale regeneration while the underlying source event is a digest-bound audit tombstone.",
      },
      sourceTombstoneDigest: tombstoneDigest,
      summaryPath,
    };
  } catch (error) {
    const detail = `Source/summary suppression could not be verified: ${error instanceof Error ? error.message : String(error)}`;
    return {
      embedding: { surface: "EMBEDDING_INDEX", state: "FAILED", detail },
      summary: { surface: "SUMMARY_PROJECTION", state: "FAILED", detail },
    };
  }
}
