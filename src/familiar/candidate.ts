import { sha256DigestCanonical } from "./canonicalize.js";
import type { Digest, FamiliarMemoryClass, MemoryTrustClass } from "./types.js";

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
 * Derive a bounded FMP candidate from an already-captured event. This adapter
 * intentionally stops at CANDIDATE: classification/promotion into durable
 * protected memory remains a separate policy-controlled mutation.
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
  return {
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
}
