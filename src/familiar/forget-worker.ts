import type { QueryFn } from "../deeplake-schema.js";
import { eraseSessionEventCache } from "../hooks/session-event-cache.js";
import { sha256DigestCanonical } from "./canonicalize.js";
import type {
  FamiliarForgetCommitStore,
  PersistedFamiliarForgetCommit,
} from "./forget-store.js";
import {
  finalizeFamiliarForget,
  type FamiliarForgetFinalization,
  type FamiliarForgetSurfaceResult,
} from "./forgetting.js";
import { currentOpenMindGraphProjectionAdapter } from "./graph-projection.js";
import type { FamiliarPayloadVault } from "./payload-vault.js";
import {
  assertFamiliarPromotionCommitV1,
  type FamiliarPromotionCommitV1,
} from "./promotion-store.js";
import { suppressFamiliarSourceAndSummary } from "./source-suppression.js";
import type { Digest } from "./types.js";

export type FamiliarProjectionErasureAdapter = {
  erase(commit: FamiliarPromotionCommitV1): Promise<FamiliarForgetSurfaceResult>;
};

export type FamiliarControlledForgetWorkerInput = {
  commit: FamiliarPromotionCommitV1;
  vault: FamiliarPayloadVault;
  query: QueryFn;
  sessionsTableName: string;
  /** Existing OpenMind wiki-summary table. Required to close SUMMARY_PROJECTION. */
  memoryTableName?: string;
  actorRef: string;
  reasonDigest: Digest;
  policyEpoch: number;
  invalidatedDerivedDigests?: readonly Digest[];
  /**
   * Optional replacement for the CURRENT graph-profile classifier.
   *
   * With no override, OpenMind's current `hivemind-codebase-graph` profile is
   * explicitly classified NOT_APPLICABLE because it only ingests repository
   * source/code structure. A future memory/entity/conversation graph MUST pass
   * its own adapter here; it must not silently inherit the codebase result.
   */
  graphProjection?: FamiliarProjectionErasureAdapter;
  /**
   * Optional additional summary-derived surface. This can only narrow the
   * built-in source-session summary result; it cannot replace or bypass it.
   */
  summaryProjection?: FamiliarProjectionErasureAdapter;
  createdAt?: string;
};

export type DurableFamiliarForgetResult = {
  surfaces: FamiliarForgetSurfaceResult[];
  finalization: FamiliarForgetFinalization;
  persistence?: PersistedFamiliarForgetCommit;
};

function verificationDigest(value: unknown): Digest {
  return sha256DigestCanonical({
    kind: "arobi.familiar-erasure-verification",
    version: 1,
    ...((value ?? {}) as Record<string, unknown>),
  });
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

async function runProjectionAdapter(
  surface: "GRAPH_PROJECTION" | "SUMMARY_PROJECTION",
  adapter: FamiliarProjectionErasureAdapter,
  commit: FamiliarPromotionCommitV1,
): Promise<FamiliarForgetSurfaceResult> {
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

async function enforceAdditionalSummaryProjection(args: {
  builtIn: FamiliarForgetSurfaceResult;
  adapter?: FamiliarProjectionErasureAdapter;
  commit: FamiliarPromotionCommitV1;
}): Promise<FamiliarForgetSurfaceResult> {
  if (!args.adapter || args.builtIn.state === "FAILED" || args.builtIn.state === "OUTSIDE_CONTROL") {
    return args.builtIn;
  }
  const supplemental = await runProjectionAdapter(
    "SUMMARY_PROJECTION",
    args.adapter,
    args.commit,
  );
  if (supplemental.state === "FAILED" || supplemental.state === "OUTSIDE_CONTROL") {
    return supplemental;
  }
  if (supplemental.state === "NOT_APPLICABLE") {
    return {
      ...args.builtIn,
      detail: `${args.builtIn.detail ?? "Built-in summary suppression verified."} Supplemental summary projection: ${supplemental.detail}`,
    };
  }
  if (args.builtIn.state !== "VERIFIED" || !args.builtIn.verificationDigest) {
    return args.builtIn;
  }
  if (!supplemental.verificationDigest) {
    return {
      surface: "SUMMARY_PROJECTION",
      state: "FAILED",
      detail: "Supplemental summary projection reported VERIFIED without verificationDigest.",
    };
  }
  return {
    surface: "SUMMARY_PROJECTION",
    state: "VERIFIED",
    verificationDigest: verificationDigest({
      surface: "SUMMARY_PROJECTION",
      builtInVerificationDigest: args.builtIn.verificationDigest,
      supplementalVerificationDigest: supplemental.verificationDigest,
      state: "BUILT_IN_AND_SUPPLEMENTAL_VERIFIED",
    }),
    detail: `${args.builtIn.detail ?? "Built-in summary suppression verified."} ${supplemental.detail ?? "Supplemental summary projection verified."}`,
  };
}

/**
 * Execute every currently-known Arobi-controlled forgetting surface and then
 * delegate final truth-state construction to finalizeFamiliarForget().
 *
 * - source event + source-session wiki summary: built-in digest-bound suppression;
 * - current OpenMind graph: explicit codebase-only NOT_APPLICABLE classifier;
 * - future memory/entity graph: caller must supply a distinct fail-closed adapter;
 * - live cache: session cache removal/absence evidence.
 *
 * No missing/new controlled surface may be converted into a synthetic PASS.
 */
export async function runControlledFamiliarForget(
  input: FamiliarControlledForgetWorkerInput,
): Promise<{
  surfaces: FamiliarForgetSurfaceResult[];
  finalization: FamiliarForgetFinalization;
}> {
  assertFamiliarPromotionCommitV1(input.commit);

  const canonicalPayload = await input.vault.erase(input.commit);
  const sourceSuppression = await suppressFamiliarSourceAndSummary({
    query: input.query,
    sessionsTableName: input.sessionsTableName,
    memoryTableName: input.memoryTableName,
    commit: input.commit,
    now: input.createdAt,
  });
  const embedding = sourceSuppression.embedding;
  const graph = await runProjectionAdapter(
    "GRAPH_PROJECTION",
    input.graphProjection ?? currentOpenMindGraphProjectionAdapter,
    input.commit,
  );
  const summary = await enforceAdditionalSummaryProjection({
    builtIn: sourceSuppression.summary,
    adapter: input.summaryProjection,
    commit: input.commit,
  });
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

/**
 * Execute controlled erasure and append the authoritative forget commit only
 * when every controlled surface has verified/non-failing evidence. INCOMPLETE
 * never writes a tombstone ledger row. If the ledger append itself fails, the
 * error propagates; source suppression is retry-safe because the bounded audit
 * tombstone is an accepted idempotent predecessor on the next run.
 */
export async function runAndCommitControlledFamiliarForget(args: {
  worker: FamiliarControlledForgetWorkerInput;
  forgets: FamiliarForgetCommitStore;
}): Promise<DurableFamiliarForgetResult> {
  const result = await runControlledFamiliarForget(args.worker);
  if (result.finalization.state !== "VERIFIED") return result;
  const persistence = await args.forgets.write({
    promotion: args.worker.commit,
    finalization: result.finalization,
  });
  return { ...result, persistence };
}
