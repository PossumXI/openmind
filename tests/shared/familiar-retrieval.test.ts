import { describe, expect, it } from "vitest";
import {
  retrieveFamiliarMemories,
  sha256DigestCanonical,
  type FamiliarMemoryArtifactV1,
  type FamiliarRetrievalCandidate,
} from "../../src/familiar/index.js";

const D1 = `sha256:${"1".repeat(64)}` as const;
const D2 = `sha256:${"2".repeat(64)}` as const;
const D3 = `sha256:${"3".repeat(64)}` as const;
const NOW = "2026-09-04T12:00:00.000Z";

function memory(overrides: Partial<FamiliarMemoryArtifactV1> = {}): FamiliarMemoryArtifactV1 {
  return {
    kind: "arobi.familiar-memory",
    version: 1,
    memoryId: "memory-1",
    familiarId: "familiar-1",
    tenantId: "tenant-1",
    identityEpoch: 2,
    memoryClass: "EVIDENCE",
    contentDigest: D1,
    originLabelDigest: D2,
    sourceArtifacts: [D3],
    transformationChain: [],
    trustClass: "VERIFIED_SYSTEM",
    supportState: "CORROBORATED",
    mayInform: true,
    mayAuthorize: false,
    revision: 1,
    createdAt: NOW,
    ...overrides,
  };
}

const policy = {
  tenantId: "tenant-1",
  familiarId: "familiar-1",
  identityEpoch: 2,
  allowedSupportStates: ["CORROBORATED", "OBSERVED"] as const,
  allowedTrustClasses: ["VERIFIED_SYSTEM", "OPERATOR_AUTHORED"] as const,
  now: "2026-09-04T12:05:00.000Z",
};

describe("FMP scope-first retrieval", () => {
  it("rechecks tenant/familiar and identity epoch before invoking the ranker", async () => {
    const seenByRanker: FamiliarRetrievalCandidate[][] = [];
    const source = {
      async readCurrentMemories() {
        return [
          memory(),
          memory({ memoryId: "wrong-tenant", tenantId: "tenant-2" }),
          memory({ memoryId: "wrong-familiar", familiarId: "familiar-2" }),
          memory({ memoryId: "old-epoch", identityEpoch: 1 }),
        ];
      },
    };

    const result = await retrieveFamiliarMemories(source, policy, (candidates) => {
      seenByRanker.push([...candidates]);
      return candidates.map((candidate) => ({ artifactDigest: candidate.artifactDigest, score: 1 }));
    });

    expect(seenByRanker).toHaveLength(1);
    expect(seenByRanker[0].map((candidate) => candidate.memory.memoryId)).toEqual(["memory-1"]);
    expect(result.map((candidate) => candidate.memory.memoryId)).toEqual(["memory-1"]);
  });

  it("filters support, trust, mayInform, class, and expiry before ranking", async () => {
    const source = {
      async readCurrentMemories() {
        return [
          memory({ memoryId: "ok" }),
          memory({ memoryId: "contested", supportState: "CONTESTED" }),
          memory({ memoryId: "untrusted", trustClass: "EXTERNAL_UNTRUSTED" }),
          memory({ memoryId: "cannot-inform", mayInform: false }),
          memory({ memoryId: "wrong-class", memoryClass: "PREFERENCE" }),
          memory({ memoryId: "expired", expiresAt: "2026-09-04T11:59:59.000Z" }),
        ];
      },
    };

    const result = await retrieveFamiliarMemories(
      source,
      { ...policy, allowedMemoryClasses: ["EVIDENCE"] },
      (candidates) => candidates.map((candidate) => ({ artifactDigest: candidate.artifactDigest, score: 5 })),
    );

    expect(result.map((candidate) => candidate.memory.memoryId)).toEqual(["ok"]);
  });

  it("rejects ranker output for an artifact outside the scoped candidate set", async () => {
    const source = { async readCurrentMemories() { return [memory()]; } };

    await expect(
      retrieveFamiliarMemories(source, policy, () => [
        { artifactDigest: `sha256:${"f".repeat(64)}`, score: 1 },
      ]),
    ).rejects.toThrow(/outside the scoped candidate set/);
  });

  it("rejects duplicate and non-finite rank results", async () => {
    const item = memory();
    const digest = sha256DigestCanonical(item);
    const source = { async readCurrentMemories() { return [item]; } };

    await expect(
      retrieveFamiliarMemories(source, policy, () => [
        { artifactDigest: digest, score: 2 },
        { artifactDigest: digest, score: 1 },
      ]),
    ).rejects.toThrow(/duplicate artifact digest/);

    await expect(
      retrieveFamiliarMemories(source, policy, () => [
        { artifactDigest: digest, score: Number.NaN },
      ]),
    ).rejects.toThrow(/non-finite score/);
  });

  it("uses deterministic recency ordering when no derived ranker is supplied", async () => {
    const source = {
      async readCurrentMemories() {
        return [
          memory({ memoryId: "older", createdAt: "2026-09-04T10:00:00.000Z" }),
          memory({ memoryId: "newer", createdAt: "2026-09-04T11:00:00.000Z" }),
        ];
      },
    };

    const result = await retrieveFamiliarMemories(source, policy);
    expect(result.map((candidate) => candidate.memory.memoryId)).toEqual(["newer", "older"]);
    expect(result.every((candidate) => candidate.memory.mayAuthorize === false)).toBe(true);
  });
});
