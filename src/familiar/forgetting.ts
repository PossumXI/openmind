import { sha256DigestCanonical } from "./canonicalize.js";
import {
  assertFamiliarMemoryArtifactV1,
  assertMemoryMutationReceiptV1,
  assertMemoryTombstoneReceiptV1,
  isDigest,
} from "./validate.js";
import type {
  ControlledErasureState,
  ControlledErasureSurfaceV1,
  Digest,
  FamiliarMemoryArtifactV1,
  MemoryMutationReceiptV1,
  MemoryTombstoneReceiptV1,
} from "./types.js";

export const AROBI_CONTROLLED_FORGET_SURFACES = [
  "CANONICAL_PAYLOAD",
  "EMBEDDING_INDEX",
  "GRAPH_PROJECTION",
  "SUMMARY_PROJECTION",
  "LIVE_CACHE",
] as const;

export type ArobiControlledForgetSurface =
  (typeof AROBI_CONTROLLED_FORGET_SURFACES)[number];

export type FamiliarForgetSurfaceResult = ControlledErasureSurfaceV1 & {
  surface: string;
};

export type FamiliarForgetFinalizeInput = {
  memory: unknown;
  actorRef: string;
  reasonDigest: Digest;
  policyEpoch: number;
  /** Every Arobi-controlled surface must be represented exactly once. */
  surfaces: readonly FamiliarForgetSurfaceResult[];
  /** Derived artifacts invalidated because they depended on the forgotten memory. */
  invalidatedDerivedDigests?: readonly Digest[];
  createdAt?: string;
};

export type FamiliarForgetIncomplete = {
  state: "INCOMPLETE";
  memoryDigest: Digest;
  missingSurfaces: string[];
  failedSurfaces: string[];
  unverifiableSurfaces: string[];
  reasonCodes: string[];
};

export type FamiliarForgetComplete = {
  state: "VERIFIED";
  memoryDigest: Digest;
  mutation: MemoryMutationReceiptV1;
  mutationDigest: Digest;
  tombstone: MemoryTombstoneReceiptV1;
  tombstoneDigest: Digest;
};

export type FamiliarForgetFinalization = FamiliarForgetIncomplete | FamiliarForgetComplete;

const VALID_STATES = new Set<ControlledErasureState>([
  "VERIFIED",
  "FAILED",
  "NOT_APPLICABLE",
  "OUTSIDE_CONTROL",
]);

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`FMP forgetting requires non-empty ${label}`);
  return normalized;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`FMP forgetting ${label} must be a non-negative safe integer`);
  }
  return value;
}

function uniqueDigests(values: readonly Digest[], label: string, rejectDuplicates = true): Digest[] {
  const out: Digest[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!isDigest(value)) throw new Error(`FMP forgetting ${label} contains an invalid digest`);
    if (seen.has(value)) {
      if (rejectDuplicates) throw new Error(`FMP forgetting ${label} contains a duplicate digest`);
      continue;
    }
    seen.add(value);
    out.push(value);
  }
  return out;
}

function validateSurfaceResults(
  surfaces: readonly FamiliarForgetSurfaceResult[],
): Map<string, FamiliarForgetSurfaceResult> {
  const bySurface = new Map<string, FamiliarForgetSurfaceResult>();
  for (const [index, result] of surfaces.entries()) {
    const surface = nonEmpty(result.surface, `surfaces[${index}].surface`);
    if (bySurface.has(surface)) {
      throw new Error(`FMP forgetting contains duplicate surface result: ${surface}`);
    }
    if (!VALID_STATES.has(result.state)) {
      throw new Error(`FMP forgetting surface ${surface} has unsupported state ${String(result.state)}`);
    }
    if (result.verificationDigest !== undefined && !isDigest(result.verificationDigest)) {
      throw new Error(`FMP forgetting surface ${surface} has invalid verificationDigest`);
    }
    if (result.state === "VERIFIED" && !result.verificationDigest) {
      throw new Error(`FMP forgetting surface ${surface} requires verificationDigest when VERIFIED`);
    }
    if (result.state === "NOT_APPLICABLE" && !result.detail?.trim()) {
      throw new Error(`FMP forgetting surface ${surface} requires detail when NOT_APPLICABLE`);
    }
    bySurface.set(surface, { ...result, surface });
  }
  return bySurface;
}

/**
 * Finalize a controlled forget only when every Arobi-controlled retrieval
 * surface has an explicit non-failing result. A controlled surface may not be
 * reported OUTSIDE_CONTROL; that state is reserved for genuinely external
 * surfaces that Arobi cannot erase directly.
 *
 * Until this function returns VERIFIED, callers must not persist a FORGET
 * mutation/tombstone or claim the memory is forgotten.
 */
export function finalizeFamiliarForget(
  input: FamiliarForgetFinalizeInput,
): FamiliarForgetFinalization {
  assertFamiliarMemoryArtifactV1(input.memory);
  const memory: FamiliarMemoryArtifactV1 = input.memory;
  const actorRef = nonEmpty(input.actorRef, "actorRef");
  nonNegativeInteger(input.policyEpoch, "policyEpoch");
  if (!isDigest(input.reasonDigest)) throw new Error("FMP forgetting requires valid reasonDigest");

  const memoryDigest = sha256DigestCanonical(memory);
  const bySurface = validateSurfaceResults(input.surfaces);
  const missingSurfaces = AROBI_CONTROLLED_FORGET_SURFACES.filter(
    (surface) => !bySurface.has(surface),
  );
  const failedSurfaces: string[] = [];
  const unverifiableSurfaces: string[] = [];

  for (const surface of AROBI_CONTROLLED_FORGET_SURFACES) {
    const result = bySurface.get(surface);
    if (!result) continue;
    if (result.state === "FAILED") failedSurfaces.push(surface);
    if (result.state === "OUTSIDE_CONTROL") unverifiableSurfaces.push(surface);
  }

  if (missingSurfaces.length || failedSurfaces.length || unverifiableSurfaces.length) {
    const reasonCodes: string[] = [];
    if (missingSurfaces.length) reasonCodes.push("CONTROLLED_SURFACE_RESULT_MISSING");
    if (failedSurfaces.length) reasonCodes.push("CONTROLLED_SURFACE_ERASURE_FAILED");
    if (unverifiableSurfaces.length) reasonCodes.push("CONTROLLED_SURFACE_MARKED_OUTSIDE_CONTROL");
    return {
      state: "INCOMPLETE",
      memoryDigest,
      missingSurfaces: [...missingSurfaces],
      failedSurfaces: [...failedSurfaces].sort(),
      unverifiableSurfaces: [...unverifiableSurfaces].sort(),
      reasonCodes,
    };
  }

  const createdAt = input.createdAt ?? new Date().toISOString();
  const invalidatedDerivedDigests = uniqueDigests(
    input.invalidatedDerivedDigests ?? [],
    "invalidatedDerivedDigests",
  );
  const surfaceEvidenceDigests = uniqueDigests(
    input.surfaces
      .map((surface) => surface.verificationDigest)
      .filter((value): value is Digest => value !== undefined),
    "surface verification evidence",
    false,
  );

  const mutation: MemoryMutationReceiptV1 = {
    kind: "arobi.familiar-memory-mutation",
    version: 1,
    mutationId: `forget:${memory.memoryId}:${memory.revision}:${memoryDigest.slice(-16)}`,
    familiarId: memory.familiarId,
    tenantId: memory.tenantId,
    identityEpoch: memory.identityEpoch,
    operation: "FORGET",
    actorRef,
    reasonDigest: input.reasonDigest,
    policyEpoch: input.policyEpoch,
    previousDigests: [memoryDigest],
    evidenceDigests: surfaceEvidenceDigests,
    createdAt,
  };
  assertMemoryMutationReceiptV1(mutation);
  const mutationDigest = sha256DigestCanonical(mutation);

  const tombstone: MemoryTombstoneReceiptV1 = {
    kind: "arobi.familiar-memory-tombstone",
    version: 1,
    tombstoneId: `tombstone:${memory.memoryId}:${memory.revision}:${memoryDigest.slice(-16)}`,
    memoryId: memory.memoryId,
    forgottenDigest: memoryDigest,
    familiarId: memory.familiarId,
    tenantId: memory.tenantId,
    identityEpoch: memory.identityEpoch,
    mutationReceiptDigest: mutationDigest,
    surfaces: input.surfaces.map((surface) => ({ ...surface })),
    invalidatedDerivedDigests,
    createdAt,
  };
  assertMemoryTombstoneReceiptV1(tombstone);
  const tombstoneDigest = sha256DigestCanonical(tombstone);

  return {
    state: "VERIFIED",
    memoryDigest,
    mutation,
    mutationDigest,
    tombstone,
    tombstoneDigest,
  };
}
