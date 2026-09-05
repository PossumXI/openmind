import { randomUUID } from "node:crypto";
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

const TOMBSTONE_KEYS = new Set([
  "id",
  "type",
  "forgotten",
  "original_event_digest",
  "familiar_promotion_commit_id",
  "session_id",
  "timestamp",
  "original_type",
]);

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

function isBoundSuppressionTombstone(
  value: Record<string, unknown>,
  commit: FamiliarPromotionCommitV1,
): boolean {
  if (Object.keys(value).some((key) => !TOMBSTONE_KEYS.has(key))) return false;
  return value.id === commit.sourceEventId &&
    value.type === "familiar_memory_forgotten_source" &&
    value.forgotten === true &&
    value.original_event_digest === commit.sourceEventDigest &&
    value.familiar_promotion_commit_id === commit.commitId;
}

function failed(detail: string): FamiliarSourceSuppressionResult {
  return {
    embedding: { surface: "EMBEDDING_INDEX", state: "FAILED", detail },
    summary: { surface: "SUMMARY_PROJECTION", state: "FAILED", detail },
  };
}

/**
 * Replace the exact legacy source event with a non-secret audit tombstone and
 * place the exact per-session wiki summary into regeneration HOLD.
 *
 * First execution proves the source row against promotion.sourceEventDigest.
 * Retried execution accepts only the exact bounded Arobi tombstone for the same
 * promotion/digest, then normalizes it again. This keeps the operation retryable
 * if a later graph gate or forget-ledger append fails after source suppression.
 *
 * Summary HOLD is also materialized when a summary row does not yet exist. The
 * ordinary writer enforces the HOLD both at read time and inside UPDATE/INSERT
 * predicates, closing the stale-writer TOCTOU window.
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
      `SELECT id, message, message_embedding, author, project, path, creation_date FROM "${sessionTable}" ` +
        `WHERE id = ${text(args.commit.sourceEventId)} LIMIT 2`,
    )) as Array<Record<string, unknown>>;

    if (sourceRows.length !== 1) {
      return failed(sourceRows.length === 0
        ? "The promoted source event is absent, so its canonical digest and suppression lineage cannot be re-verified."
        : "Multiple session rows matched the promoted sourceEventId; source suppression is ambiguous.");
    }

    const row = sourceRows[0];
    const original = parseMessage(row.message);
    if (!original) return failed("The promoted source session row does not contain parseable canonical event JSON.");
    if (original.id !== args.commit.sourceEventId) return failed("The source row id and embedded event id disagree.");

    const alreadySuppressed = isBoundSuppressionTombstone(original, args.commit);
    const originalSessionId = safeSessionId(original.session_id);
    if (
      args.commit.sourceSessionId !== undefined &&
      originalSessionId !== args.commit.sourceSessionId
    ) {
      return failed("The source event session id does not match the authoritative promotion commit.");
    }

    if (!alreadySuppressed) {
      if (original.type === "familiar_memory_forgotten_source") {
        return failed("The source row contains a suppression tombstone that is not bound to this promotion/digest.");
      }
      const originalDigest = sha256DigestCanonical(original);
      if (originalDigest !== args.commit.sourceEventDigest) {
        return failed("The canonical source event digest does not match the authoritative promotion commit.");
      }
    }

    const tombstone = {
      id: args.commit.sourceEventId,
      type: "familiar_memory_forgotten_source",
      forgotten: true,
      original_event_digest: args.commit.sourceEventDigest,
      familiar_promotion_commit_id: args.commit.commitId,
      ...(originalSessionId ? { session_id: originalSessionId } : {}),
      ...(safeTimestamp(original.timestamp) ? { timestamp: safeTimestamp(original.timestamp) } : {}),
      ...(safeOriginalType(alreadySuppressed ? original.original_type : original.type)
        ? { original_type: safeOriginalType(alreadySuppressed ? original.original_type : original.type) }
        : {}),
    } as const;
    const tombstoneDigest = sha256DigestCanonical(tombstone);
    const tombstoneBytes = Buffer.byteLength(JSON.stringify(tombstone), "utf8");

    // Always normalize the tombstone and NULL the embedding, including retries.
    await args.query(
      `UPDATE "${sessionTable}" SET message = ${jsonLiteral(tombstone)}, ` +
        `message_embedding = NULL, size_bytes = ${tombstoneBytes}, ` +
        `description = ${text("familiar-memory-forgotten-source")}, ` +
        `last_update_date = ${text(now)} WHERE id = ${text(args.commit.sourceEventId)}`,
    );

    const verifiedRows = (await args.query(
      `SELECT id, message, message_embedding, author, project FROM "${sessionTable}" ` +
        `WHERE id = ${text(args.commit.sourceEventId)} LIMIT 2`,
    )) as Array<Record<string, unknown>>;
    if (verifiedRows.length !== 1) {
      return failed("The source event tombstone could not be uniquely read back after suppression.");
    }
    const verified = verifiedRows[0];
    const verifiedMessage = parseMessage(verified.message);
    if (
      !verifiedMessage ||
      !isBoundSuppressionTombstone(verifiedMessage, args.commit) ||
      sha256DigestCanonical(verifiedMessage) !== tombstoneDigest ||
      !isEmbeddingAbsent(verified.message_embedding)
    ) {
      return failed("The source event tombstone or embedding suppression failed read-back verification.");
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
        "The exact digest-bound source event is a normalized audit tombstone and its live semantic embedding is absent.",
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

    const sourceSessionId = args.commit.sourceSessionId ?? safeSessionId(verifiedMessage.session_id);
    const author = typeof verified.author === "string" ? verified.author.trim() : "";
    const project = typeof verified.project === "string" ? verified.project.trim() : "";
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
    const summaryFile = `${sourceSessionId}.md`;
    const memoryTable = sqlIdent(args.memoryTableName);
    const holdUpdate =
      `UPDATE "${memoryTable}" SET summary = '', summary_embedding = NULL, size_bytes = 0, ` +
      `description = ${text(FAMILIAR_FORGET_HOLD_DESCRIPTION)}, ` +
      `last_update_date = ${text(now)} WHERE path = ${text(summaryPath)}`;

    // First close an existing summary/placeholder.
    await args.query(holdUpdate);
    let summaries = (await args.query(
      `SELECT path, summary, summary_embedding, description FROM "${memoryTable}" ` +
        `WHERE path = ${text(summaryPath)} LIMIT 2`,
    )) as Array<Record<string, unknown>>;

    // If no row exists, materialize a HOLD row so a writer that began before
    // suppression cannot later INSERT a stale summary into an empty path.
    if (summaries.length === 0) {
      await args.query(
        `INSERT INTO "${memoryTable}" ` +
          `(id, path, filename, summary, summary_embedding, author, mime_type, size_bytes, project, description, agent, plugin_version, creation_date, last_update_date) ` +
          `SELECT ${text(randomUUID())}, ${text(summaryPath)}, ${text(summaryFile)}, '', NULL, ${text(author)}, ` +
          `'text/markdown', 0, ${text(project)}, ${text(FAMILIAR_FORGET_HOLD_DESCRIPTION)}, ` +
          `${text("arobi_fmp_forget")}, '', ${text(now)}, ${text(now)} ` +
          `WHERE NOT EXISTS (SELECT 1 FROM "${memoryTable}" WHERE path = ${text(summaryPath)})`,
      );
    }

    // Repeat the HOLD update after the conditional insert to catch a stale
    // writer that raced a normal row into the path between our first UPDATE and
    // materialization attempt. New uploadSummary mutations carry their own HOLD
    // predicates, so they cannot overwrite this state afterward.
    await args.query(holdUpdate);
    summaries = (await args.query(
      `SELECT path, summary, summary_embedding, description FROM "${memoryTable}" ` +
        `WHERE path = ${text(summaryPath)} LIMIT 2`,
    )) as Array<Record<string, unknown>>;

    if (summaries.length !== 1) {
      return {
        embedding,
        summary: {
          surface: "SUMMARY_PROJECTION",
          state: "FAILED",
          detail: summaries.length === 0
            ? "The exact session summary HOLD row could not be materialized."
            : "Multiple wiki summary rows matched the exact source session path.",
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
    return failed(`Source/summary suppression could not be verified: ${error instanceof Error ? error.message : String(error)}`);
  }
}
