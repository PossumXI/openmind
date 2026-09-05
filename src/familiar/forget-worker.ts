import type { QueryFn } from "../deeplake-schema.js";
import { eraseSessionEventCache } from "../hooks/session-event-cache.js";
import { sqlIdent, sqlStr } from "../utils/sql.js";
import { sha256DigestCanonical } from "./canonicalize.js";
import {
  finalizeFamiliarForget,
  type FamiliarForgetFinalization,
  type FamiliarForgetSurfaceResult,
} from "./forgetting.js";
import type { FamiliarPayloadVault } from "./payload-vault.js";
import {
  assertFamiliarPromotionCommitV1,
  type FamiliarPromotionCommitV1,
} from "./promotion-store.js";
import type { Digest } from "./types.js";

export type FamiliarProjectionErasureAdapter = {
  erase(commit: FamiliarPromotionCommitV1): Promise<FamiliarForgetSurfaceResult>;
};

export type FamiliarControlledForgetWorkerInput = {
  commit: FamiliarPromotionCommitV1;
  vault: FamiliarPayloadVault;
  query: QueryFn;
  sessionsTableName: string;
  actorRef: string;
  reasonDigest: Digest;
  policyEpoch: number;
  invalidatedDerivedDigests?: readonly Digest[];
  graphProjection?: FamiliarProjectionErasureAdapter;
  summaryProjection?: FamiliarProjectionErasureAdapter;
  createdAt?: string;
};

function text(value: string): string {
  return `'${sqlStr(value)}'`;
}

function verificationDigest(value: unknown): Digest {
  return sha256DigestCanonical({
    kind: "arobi.familiar-erasure-verification",
    version: 1,
    ...((value ?? {}) as Record<string, unknown>),
  });
}

async function eraseLegacySourceEmbedding(args: {
  query: QueryFn;
  sessionsTableName: string;
  commit: FamiliarPromotionCommitV1;
}): Promise<FamiliarForgetSurfaceResult> {
  const table = sqlIdent(args.sessionsTableName);
  try {
    await args.query(
      `UPDATE "${table}" SET message_embedding = NULL WHERE id = ${text(args.commit.sourceEventId)}`,
    );
    const rows = (await args.query(
      `SELECT id, message_embedding FROM "${table}" WHERE id = ${text(args.commit.sourceEventId)} LIMIT 2`,
    )) as Array<Record<string, unknown>>;
    if (rows.length > 1) {
      return {
        surface: "EMBEDDING_INDEX",
        state: "FAILED",
        detail: "Multiple legacy session rows matched the promotion sourceEventId; embedding erasure is ambiguous.",
      };
    }
    const embedding = rows[0]?.message_embedding;
    if (
      rows.length === 1 &&
      embedding !== null &&
      embedding !== undefined &&
      !(Array.isArray(embedding) && embedding.length === 0)
    ) {
      return {
        surface: "EMBEDDING_INDEX",
        state: "FAILED",
        detail: "The source session embedding remained readable after the scoped NULL update.",
      };
    }
    return {
      surface: "EMBEDDING_INDEX",
      state: "VERIFIED",
      verificationDigest: verificationDigest({
        surface: "EMBEDDING_INDEX",
        sourceEventId: args.commit.sourceEventId,
        tenantId: args.commit.tenantId,
        familiarId: args.commit.familiarId,
        identityEpoch: args.commit.identityEpoch,
        state: rows.length === 0 ? "SOURCE_EVENT_ABSENT" : "EMBEDDING_ABSENT",
      }),
      detail:
        rows.length === 0
          ? "The historical source event is absent from this sessions table, so no live vector embedding remains there."
          : "The historical source event remains for audit, but its semantic embedding is absent from the live sessions table.",
    };
  } catch (error) {
    return {
      surface: "EMBEDDING_INDEX",
      state: "FAILED",
      detail: `The legacy source embedding could not be erased and verified: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function eraseLiveCache(commit: FamiliarPromotionCommitV1): FamiliarForgetSurfaceResult {
  const result = eraseSessionEventCache(commit.sourceSessionId ?? "");
  if (result.state === "FAILED") {
    return { surface: "LIVE_CACHE", state: "FAILED", detail: result.detail };
  }
  if (result.state === "NOT_APPLICABLE") {
    return {
      surface: "LIVE_CACHE",
      state: "NOT_APPLICABLE",
      detail: result.detail,
    };
  }
  return {
    surface: "LIVE_CACHE",
    state: "VERIFIED",
    verificationDigest: verificationDigest({
      surface: "LIVE_CACHE",
      sourceSessionId: commit.sourceSessionId ?? null,
      sourceEventId: commit.sourceEventId,
      tenantId: commit.tenantId,
      familiarId: commit.familiarId,
      identityEpoch: commit.identityEpoch,
      state: "SESSION_CACHE_ABSENT",
    }),
    detail: result.detail,
  };
}

function missingProjectionAdapter(surface: "GRAPH_PROJECTION" | "SUMMARY_PROJECTION"):
  FamiliarForgetSurfaceResult {
  return {
    surface,
    state: "FAILED",
    detail:
      `${surface} erasure adapter is not wired. Arobi will not claim forgetting until derived-lineage deletion is executable and verified.`,
  };
}

async function runProjectionAdapter(
  surface: "GRAPH_PROJECTION" | "SUMMARY_PROJECTION",
  adapter: FamiliarProjectionErasureAdapter | undefined,
  commit: FamiliarPromotionCommitV1,
): Promise<FamiliarForgetSurfaceResult> {
  if (!adapter) return missingProjectionAdapter(surface);
  try {
    const result = await adapter.erase(commit);
    if (result.surface !== surface) {
      return {
        surface,
        state: "FAILED",
        detail: `${surface} erasure adapter returned evidence for a different surface (${result.surface}).`,
      };
    }
    return result;
  } catch (error) {
    return {
      surface,
      state: "FAILED",
      detail: `${surface} erasure adapter failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Execute every currently-known Arobi-controlled forgetting surface and then
 * delegate final truth-state construction to finalizeFamiliarForget(). Missing
 * graph/summary adapters deliberately keep the result INCOMPLETE.
 */
export async function runControlledFamiliarForget(
  input: FamiliarControlledForgetWorkerInput,
): Promise<{
  surfaces: FamiliarForgetSurfaceResult[];
  finalization: FamiliarForgetFinalization;
}> {
  assertFamiliarPromotionCommitV1(input.commit);

  const canonicalPayload = await input.vault.erase(input.commit);
  const embedding = await eraseLegacySourceEmbedding({
    query: input.query,
    sessionsTableName: input.sessionsTableName,
    commit: input.commit,
  });
  const graph = await runProjectionAdapter(
    "GRAPH_PROJECTION",
    input.graphProjection,
    input.commit,
  );
  const summary = await runProjectionAdapter(
    "SUMMARY_PROJECTION",
    input.summaryProjection,
    input.commit,
  );
  const cache = eraseLiveCache(input.commit);

  const surfaces: FamiliarForgetSurfaceResult[] = [
    canonicalPayload,
    embedding,
    graph,
    summary,
    cache,
  ];
  const finalization = finalizeFamiliarForget({
    memory: input.commit.memory,
    actorRef: input.actorRef,
    reasonDigest: input.reasonDigest,
    policyEpoch: input.policyEpoch,
    surfaces,
    invalidatedDerivedDigests: input.invalidatedDerivedDigests,
    createdAt: input.createdAt,
  });
  return { surfaces, finalization };
}
