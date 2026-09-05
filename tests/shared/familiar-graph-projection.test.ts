import { describe, expect, it } from "vitest";
import {
  OPENMIND_CURRENT_GRAPH_PROFILE,
  OPENMIND_CURRENT_GRAPH_PROFILE_DIGEST,
  buildFamiliarMemoryCandidate,
  buildFamiliarPromotionCommit,
  buildFamiliarPromotionPlan,
  eraseCurrentOpenMindGraphProjection,
  sha256DigestCanonical,
  type Digest,
} from "../../src/familiar/index.js";

const D1 = `sha256:${"1".repeat(64)}` as Digest;
const D2 = `sha256:${"2".repeat(64)}` as Digest;

function commit() {
  const candidate = buildFamiliarMemoryCandidate({
    tenantId: "tenant-1",
    familiarId: "familiar-1",
    identityEpoch: 1,
    event: {
      id: "event-1",
      type: "user_message",
      session_id: "session-1",
      timestamp: "2026-09-04T20:00:00.000Z",
      content: "context",
    },
  });
  return buildFamiliarPromotionCommit(buildFamiliarPromotionPlan({
    candidate,
    memoryId: "memory-1",
    originLabelDigest: D1,
    actorRef: "principal:operator",
    reasonDigest: D2,
    policyEpoch: 1,
    createdAt: "2026-09-04T20:00:00.000Z",
  }));
}

describe("current OpenMind graph profile", () => {
  it("is digest-bound to the repository-source/codebase-only profile", () => {
    expect(OPENMIND_CURRENT_GRAPH_PROFILE).toMatchObject({
      profile: "hivemind-codebase-graph",
      graphGenerator: "hivemind-graph",
      graphSchemaVersion: 1,
      sourceDomain: "repository-source-files",
      cloudTableFamily: "codebase",
      familiarContentIngestion: false,
    });
    expect(OPENMIND_CURRENT_GRAPH_PROFILE_DIGEST).toBe(
      sha256DigestCanonical(OPENMIND_CURRENT_GRAPH_PROFILE),
    );
  });

  it("returns explicit NOT_APPLICABLE rather than pretending graph erasure occurred", async () => {
    const result = await eraseCurrentOpenMindGraphProjection(commit());
    expect(result.surface).toBe("GRAPH_PROJECTION");
    expect(result.state).toBe("NOT_APPLICABLE");
    expect(result.verificationDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.detail).toContain(OPENMIND_CURRENT_GRAPH_PROFILE_DIGEST);
  });
});
