import { sha256DigestCanonical } from "./canonicalize.js";
import {
  assertFamiliarMemoryCandidateV1,
  type FamiliarMemoryCandidateV1,
} from "./candidate.js";
import {
  assertFamiliarMemoryArtifactV1,
  assertMemoryMutationReceiptV1,
  isDigest,
} from "./validate.js";
import type {
  Digest,
  FamiliarMemoryArtifactV1,
  FamiliarMemoryClass,
  MemoryMutationReceiptV1,
  MemorySupportState,
} from "./types.js";

export type FamiliarPromotionPlanInput = {
  candidate: unknown;
  memoryId: string;
  /** Explicit classification at promotion time; defaults to candidate proposal. */
  memoryClass?: FamiliarMemoryClass;
  /** Trusted OriginLabel digest resolved outside familiar memory. */
  originLabelDigest: Digest;
  /** Additional canonical evidence supporting the promotion/classification. */
  evidenceDigests?: readonly Digest[];
  actorRef: string;
  reasonDigest: Digest;
  policyEpoch: number;
  mayInform?: boolean;
  expiresAt?: string;
  createdAt?: string;
};

export type FamiliarPromotionPlan = {
  candidate: FamiliarMemoryCandidateV1;
  candidateDigest: Digest;
  memory: FamiliarMemoryArtifactV1;
  memoryDigest: Digest;
  mutation: MemoryMutationReceiptV1;
  mutationDigest: Digest;
};

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`FMP promotion requires non-empty ${label}`);
  return normalized;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`FMP promotion ${label} must be a non-negative safe integer`);
  }
  return value;
}

function uniqueDigests(values: readonly Digest[], label: string): Digest[] {
  const seen = new Set<string>();
  const out: Digest[] = [];
  for (const value of values) {
    if (!isDigest(value)) throw new Error(`FMP promotion ${label} contains an invalid digest`);
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function initialSupportState(candidate: FamiliarMemoryCandidateV1): MemorySupportState {
  // Promotion does not upgrade trust. Tool observations begin OBSERVED; all
  // other captured candidate classes begin ASSERTED until independent evidence
  // later corroborates/corrects/quarantines them through explicit mutation.
  return candidate.trustClass === "OBSERVED" ? "OBSERVED" : "ASSERTED";
}

/**
 * Build the two canonical artifacts required to promote one capture candidate:
 * a v1 familiar-memory artifact and an append-only PROMOTE mutation receipt.
 *
 * This function deliberately does not persist them because two independent
 * INSERT calls would create a partial-state hazard. The persistence/transaction
 * phase must commit the memory + mutation atomically before reporting promotion
 * durable.
 *
 * Security invariants:
 * - tenant/familiar/identity scope comes only from the validated candidate;
 * - content digest comes only from the captured candidate;
 * - trust class is preserved and cannot be upgraded at promotion;
 * - `mayAuthorize` is structurally false;
 * - a trusted OriginLabel digest is mandatory and distinct from remembering an
 *   actor/approval string inside the captured content.
 */
export function buildFamiliarPromotionPlan(
  input: FamiliarPromotionPlanInput,
): FamiliarPromotionPlan {
  assertFamiliarMemoryCandidateV1(input.candidate);
  const candidate = input.candidate;
  const memoryId = nonEmpty(input.memoryId, "memoryId");
  const actorRef = nonEmpty(input.actorRef, "actorRef");
  nonNegativeInteger(input.policyEpoch, "policyEpoch");
  if (!isDigest(input.originLabelDigest)) {
    throw new Error("FMP promotion requires a valid trusted originLabelDigest");
  }
  if (!isDigest(input.reasonDigest)) {
    throw new Error("FMP promotion requires a valid reasonDigest");
  }

  const candidateDigest = sha256DigestCanonical(candidate);
  const createdAt = input.createdAt ?? new Date().toISOString();
  const evidenceDigests = uniqueDigests(input.evidenceDigests ?? [], "evidenceDigests");
  const sourceArtifacts = uniqueDigests(
    [candidateDigest, candidate.originDigest, ...evidenceDigests],
    "sourceArtifacts",
  );

  const memory: FamiliarMemoryArtifactV1 = {
    kind: "arobi.familiar-memory",
    version: 1,
    memoryId,
    familiarId: candidate.familiarId,
    tenantId: candidate.tenantId,
    identityEpoch: candidate.identityEpoch,
    memoryClass: input.memoryClass ?? candidate.proposedClass,
    contentDigest: candidate.contentDigest,
    originLabelDigest: input.originLabelDigest,
    sourceArtifacts,
    transformationChain: [],
    trustClass: candidate.trustClass,
    supportState: initialSupportState(candidate),
    mayInform: input.mayInform ?? true,
    mayAuthorize: false,
    revision: 1,
    createdAt,
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
  };
  assertFamiliarMemoryArtifactV1(memory);
  const memoryDigest = sha256DigestCanonical(memory);

  const mutation: MemoryMutationReceiptV1 = {
    kind: "arobi.familiar-memory-mutation",
    version: 1,
    mutationId: `promote:${candidate.candidateId}:${memoryId}`,
    familiarId: candidate.familiarId,
    tenantId: candidate.tenantId,
    identityEpoch: candidate.identityEpoch,
    operation: "PROMOTE",
    actorRef,
    reasonDigest: input.reasonDigest,
    policyEpoch: input.policyEpoch,
    previousDigests: [candidateDigest],
    nextDigest: memoryDigest,
    evidenceDigests: uniqueDigests(
      [candidate.originDigest, input.originLabelDigest, ...evidenceDigests],
      "mutation evidenceDigests",
    ),
    createdAt,
  };
  assertMemoryMutationReceiptV1(mutation);
  const mutationDigest = sha256DigestCanonical(mutation);

  return {
    candidate,
    candidateDigest,
    memory,
    memoryDigest,
    mutation,
    mutationDigest,
  };
}
