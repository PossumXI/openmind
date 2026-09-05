import { sha256DigestCanonical } from "./canonicalize.js";
import { isDigest } from "./validate.js";
import {
  FAMILIAR_MEMORY_CLASSES,
  MEMORY_TRUST_CLASSES,
  type Digest,
  type FamiliarMemoryClass,
  type MemoryTrustClass,
} from "./types.js";

export type FamiliarMemoryCandidateV1 = {
  kind: "arobi.familiar-memory-candidate";
  version: 1;
  candidateId: string;
  tenantId: string;
  familiarId: string;
  identityEpoch: number;
  sourceEventId: string;
  sourceSessionId?: string;
  proposedClass: FamiliarMemoryClass;
  trustClass: MemoryTrustClass;
  originDigest: Digest;
  contentDigest: Digest;
  /** Candidate memory can inform later classification but is never authority. */
  mayAuthorize: false;
  promotionState: "CANDIDATE";
  createdAt: string;
};

export type CapturedEventForFamiliarCandidate = {
  id: string;
  type: "user_message" | "assistant_message" | "tool_call";
  session_id?: string;
  timestamp?: string;
  content?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  tool_response?: unknown;
  [key: string]: unknown;
};

export type FamiliarCandidateBuildInput = {
  tenantId: string;
  familiarId: string;
  identityEpoch: number;
  event: CapturedEventForFamiliarCandidate;
  proposedClass?: FamiliarMemoryClass;
};

const MEMORY_CLASS_SET = new Set<string>(FAMILIAR_MEMORY_CLASSES);
const TRUST_CLASS_SET = new Set<string>(MEMORY_TRUST_CLASSES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function assertFamiliarMemoryCandidateV1(
  value: unknown,
): asserts value is FamiliarMemoryCandidateV1 {
  if (!isRecord(value)) throw new Error("FMP candidate must be an object");
  if (value.kind !== "arobi.familiar-memory-candidate" || value.version !== 1) {
    throw new Error("unsupported FMP candidate kind/version");
  }
  for (const key of ["candidateId", "tenantId", "familiarId", "sourceEventId", "createdAt"] as const) {
    if (!nonEmpty(value[key])) throw new Error(`FMP candidate requires non-empty ${key}`);
  }
  if (!Number.isSafeInteger(value.identityEpoch) || (value.identityEpoch as number) < 0) {
    throw new Error("FMP candidate requires a non-negative identityEpoch");
  }
  if (typeof value.proposedClass !== "string" || !MEMORY_CLASS_SET.has(value.proposedClass)) {
    throw new Error("FMP candidate has invalid proposedClass");
  }
  if (typeof value.trustClass !== "string" || !TRUST_CLASS_SET.has(value.trustClass)) {
    throw new Error("FMP candidate has invalid trustClass");
  }
  if (!isDigest(value.originDigest) || !isDigest(value.contentDigest)) {
    throw new Error("FMP candidate requires valid origin/content digests");
  }
  if (value.mayAuthorize !== false) {
    throw new Error("FMP candidate mayAuthorize must be false");
  }
  if (value.promotionState !== "CANDIDATE") {
    throw new Error("FMP candidate promotionState must be CANDIDATE");
  }
  if (value.sourceSessionId !== undefined && !nonEmpty(value.sourceSessionId)) {
    throw new Error("FMP candidate sourceSessionId must be non-empty when present");
  }
  const createdAt = Date.parse(value.createdAt as string);
  if (!Number.isFinite(createdAt)) throw new Error("FMP candidate createdAt must be an ISO timestamp");
}

function trustForCapturedEvent(event: CapturedEventForFamiliarCandidate): MemoryTrustClass {
  switch (event.type) {
    case "user_message":
      return "OPERATOR_AUTHORED";
    case "assistant_message":
      return "DERIVED";
    case "tool_call":
      return "OBSERVED";
  }
}

function contentProjection(event: CapturedEventForFamiliarCandidate): unknown {
  switch (event.type) {
    case "user_message":
    case "assistant_message":
      return event.content ?? null;
    case "tool_call":
      return {
        tool_name: event.tool_name ?? null,
        tool_input: event.tool_input ?? null,
        tool_response: event.tool_response ?? null,
      };
  }
}

/**
 * Derive a bounded FMP candidate from an already-captured, already-redacted
 * event. This adapter intentionally stops at CANDIDATE: classification and
 * promotion into durable protected memory remain separate governed mutations.
 */
export function buildFamiliarMemoryCandidate(
  input: FamiliarCandidateBuildInput,
): FamiliarMemoryCandidateV1 {
  if (!input.tenantId.trim() || !input.familiarId.trim()) {
    throw new Error("FMP candidate requires non-empty tenantId and familiarId");
  }
  if (!Number.isSafeInteger(input.identityEpoch) || input.identityEpoch < 0) {
    throw new Error("FMP candidate requires a non-negative identityEpoch");
  }
  if (!input.event.id?.trim()) throw new Error("FMP candidate requires a captured event id");

  const originDigest = sha256DigestCanonical(input.event);
  const contentDigest = sha256DigestCanonical(contentProjection(input.event));
  const candidate: FamiliarMemoryCandidateV1 = {
    kind: "arobi.familiar-memory-candidate",
    version: 1,
    candidateId: `candidate:${input.event.id}`,
    tenantId: input.tenantId,
    familiarId: input.familiarId,
    identityEpoch: input.identityEpoch,
    sourceEventId: input.event.id,
    ...(input.event.session_id ? { sourceSessionId: input.event.session_id } : {}),
    proposedClass: input.proposedClass ?? "EPISODIC",
    trustClass: trustForCapturedEvent(input.event),
    originDigest,
    contentDigest,
    mayAuthorize: false,
    promotionState: "CANDIDATE",
    createdAt: input.event.timestamp ?? new Date().toISOString(),
  };
  assertFamiliarMemoryCandidateV1(candidate);
  return candidate;
}
