import { describe, expect, it } from "vitest";
import {
  buildFamiliarMemoryCandidate,
  buildFamiliarPromotionPlan,
  sha256DigestCanonical,
  type Digest,
} from "../../src/familiar/index.js";

const D1 = `sha256:${"1".repeat(64)}` as Digest;
const D2 = `sha256:${"2".repeat(64)}` as Digest;
const NOW = "2026-09-04T20:00:00.000Z";

function userCandidate() {
  return buildFamiliarMemoryCandidate({
    tenantId: "tenant-1",
    familiarId: "familiar-1",
    identityEpoch: 4,
    event: {
      id: "event-user-1",
      type: "user_message",
      session_id: "session-1",
      timestamp: NOW,
      content: "Remember that production changes require review",
    },
  });
}

function toolCandidate() {
  return buildFamiliarMemoryCandidate({
    tenantId: "tenant-1",
    familiarId: "familiar-1",
    identityEpoch: 4,
    event: {
      id: "event-tool-1",
      type: "tool_call",
      session_id: "session-1",
      timestamp: NOW,
      tool_name: "status",
      tool_response: "healthy",
    },
  });
}

describe("FMP candidate promotion plan", () => {
  it("preserves candidate scope/content/trust and produces append-only PROMOTE lineage", () => {
    const candidate = userCandidate();
    const plan = buildFamiliarPromotionPlan({
      candidate,
      memoryId: "memory-1",
      memoryClass: "PREFERENCE",
      originLabelDigest: D1,
      actorRef: "principal:operator-1",
      reasonDigest: D2,
      policyEpoch: 3,
      createdAt: NOW,
    });

    expect(plan.memory.tenantId).toBe(candidate.tenantId);
    expect(plan.memory.familiarId).toBe(candidate.familiarId);
    expect(plan.memory.identityEpoch).toBe(candidate.identityEpoch);
    expect(plan.memory.contentDigest).toBe(candidate.contentDigest);
    expect(plan.memory.trustClass).toBe("OPERATOR_AUTHORED");
    expect(plan.memory.supportState).toBe("ASSERTED");
    expect(plan.memory.mayAuthorize).toBe(false);
    expect(plan.memory.originLabelDigest).toBe(D1);
    expect(plan.mutation.operation).toBe("PROMOTE");
    expect(plan.mutation.previousDigests).toEqual([sha256DigestCanonical(candidate)]);
    expect(plan.mutation.nextDigest).toBe(plan.memoryDigest);
  });

  it("does not upgrade an observed tool candidate beyond OBSERVED at promotion", () => {
    const plan = buildFamiliarPromotionPlan({
      candidate: toolCandidate(),
      memoryId: "memory-observation",
      originLabelDigest: D1,
      actorRef: "agent:memory-worker",
      reasonDigest: D2,
      policyEpoch: 3,
      createdAt: NOW,
    });

    expect(plan.memory.trustClass).toBe("OBSERVED");
    expect(plan.memory.supportState).toBe("OBSERVED");
    expect(plan.memory.mayAuthorize).toBe(false);
  });

  it("allows AUTHORITY_REFERENCE classification only as non-authorizing memory", () => {
    const plan = buildFamiliarPromotionPlan({
      candidate: userCandidate(),
      memoryId: "memory-authority-reference",
      memoryClass: "AUTHORITY_REFERENCE",
      originLabelDigest: D1,
      actorRef: "principal:operator-1",
      reasonDigest: D2,
      policyEpoch: 3,
      createdAt: NOW,
    });

    expect(plan.memory.memoryClass).toBe("AUTHORITY_REFERENCE");
    expect(plan.memory.mayAuthorize).toBe(false);
  });

  it("requires a trusted OriginLabel digest instead of treating candidate event provenance as authority identity", () => {
    expect(() =>
      buildFamiliarPromotionPlan({
        candidate: userCandidate(),
        memoryId: "memory-1",
        originLabelDigest: "sha256:bad" as Digest,
        actorRef: "principal:operator-1",
        reasonDigest: D2,
        policyEpoch: 3,
        createdAt: NOW,
      }),
    ).toThrow(/trusted originLabelDigest/);
  });

  it("deduplicates supporting evidence without losing candidate/event lineage", () => {
    const candidate = userCandidate();
    const candidateDigest = sha256DigestCanonical(candidate);
    const plan = buildFamiliarPromotionPlan({
      candidate,
      memoryId: "memory-1",
      originLabelDigest: D1,
      evidenceDigests: [D1, D2, D2],
      actorRef: "principal:operator-1",
      reasonDigest: D2,
      policyEpoch: 3,
      createdAt: NOW,
    });

    expect(plan.memory.sourceArtifacts).toContain(candidateDigest);
    expect(plan.memory.sourceArtifacts).toContain(candidate.originDigest);
    expect(new Set(plan.memory.sourceArtifacts).size).toBe(plan.memory.sourceArtifacts.length);
    expect(new Set(plan.mutation.evidenceDigests).size).toBe(plan.mutation.evidenceDigests.length);
  });
});
