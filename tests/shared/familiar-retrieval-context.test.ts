import { describe, expect, it } from "vitest";
import {
  recordRetrievedContextUse,
  sha256DigestCanonical,
  type FamiliarMemoryArtifactV1,
  type FamiliarRetrievalResult,
} from "../../src/familiar/index.js";

const D1 = `sha256:${"1".repeat(64)}` as const;
const D2 = `sha256:${"2".repeat(64)}` as const;
const D3 = `sha256:${"3".repeat(64)}` as const;
const D4 = `sha256:${"4".repeat(64)}` as const;
const NOW = "2026-09-04T12:00:00.000Z";

function memory(overrides: Partial<FamiliarMemoryArtifactV1> = {}): FamiliarMemoryArtifactV1 {
  return {
    kind: "arobi.familiar-memory",
    version: 1,
    memoryId: "memory-1",
    familiarId: "familiar-1",
    tenantId: "tenant-1",
    identityEpoch: 3,
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

function candidate(value: FamiliarMemoryArtifactV1 = memory()): FamiliarRetrievalResult {
  return {
    artifactDigest: sha256DigestCanonical(value),
    memory: value,
  };
}

function input(overrides: Record<string, unknown> = {}) {
  const first = candidate();
  return {
    tenantId: "tenant-1",
    familiarId: "familiar-1",
    identityEpoch: 3,
    purpose: { kind: "deploy-review" },
    proposal: { action: "repo.apply_patch", target: "file-a" },
    familiarContinuityDigest: D4,
    retrieved: [first],
    opened: [first.artifactDigest],
    reliedUpon: [first.artifactDigest],
    rejectedOrConflicting: [],
    receiptId: "receipt-1",
    createdAt: "2026-09-04T12:05:00.000Z",
    ...overrides,
  };
}

describe("FMP retrieval -> context-use evidence", () => {
  it("derives the retrieved set from actual structured retrieval results", async () => {
    const result = await recordRetrievedContextUse(input());
    expect(result.receipt.retrieved).toEqual([input().retrieved[0].artifactDigest]);
    expect(result.receipt.opened).toEqual(result.receipt.retrieved);
    expect(result.receipt.reliedUpon).toEqual(result.receipt.retrieved);
    expect(result.receipt.proposalDigest).toBe(
      sha256DigestCanonical({ action: "repo.apply_patch", target: "file-a" }),
    );
    expect(result.receiptDigest).toBe(sha256DigestCanonical(result.receipt));
  });

  it("rejects opened/reliance/rejected claims not present in the actual retrieval result", async () => {
    await expect(
      recordRetrievedContextUse(input({ opened: [D1] })),
    ).rejects.toThrow(/opened digest was not present/);

    await expect(
      recordRetrievedContextUse(input({ reliedUpon: [D1] })),
    ).rejects.toThrow(/reliedUpon digest was not present/);

    await expect(
      recordRetrievedContextUse(input({ rejectedOrConflicting: [D1] })),
    ).rejects.toThrow(/rejectedOrConflicting digest was not present/);
  });

  it("rejects cross-tenant, cross-familiar, and stale-epoch retrieval candidates", async () => {
    await expect(
      recordRetrievedContextUse(input({ retrieved: [candidate(memory({ tenantId: "tenant-2" }))] })),
    ).rejects.toThrow(/crosses tenant scope/);
    await expect(
      recordRetrievedContextUse(input({ retrieved: [candidate(memory({ familiarId: "familiar-2" }))] })),
    ).rejects.toThrow(/crosses familiar scope/);
    await expect(
      recordRetrievedContextUse(input({ retrieved: [candidate(memory({ identityEpoch: 2 }))] })),
    ).rejects.toThrow(/crosses identity epoch/);
  });

  it("rejects a candidate whose advertised digest does not match the canonical memory", async () => {
    const bad = candidate();
    bad.artifactDigest = D1;
    await expect(recordRetrievedContextUse(input({ retrieved: [bad] }))).rejects.toThrow(
      /digest does not match canonical memory/,
    );
  });

  it("persists only after a valid receipt is built and checks the storage digest", async () => {
    const calls: unknown[] = [];
    const sink = {
      async writeContextUse(value: unknown) {
        calls.push(value);
        return { rowId: "row-1", digest: sha256DigestCanonical(value) };
      },
    };
    const result = await recordRetrievedContextUse(input(), sink);
    expect(calls).toHaveLength(1);
    expect(result.persistence?.rowId).toBe("row-1");
    expect(result.persistence?.digest).toBe(result.receiptDigest);
  });

  it("fails closed when storage reports a digest inconsistent with the exact receipt", async () => {
    const sink = {
      async writeContextUse() {
        return { rowId: "row-bad", digest: D1 };
      },
    };
    await expect(recordRetrievedContextUse(input(), sink)).rejects.toThrow(
      /persisted context-use digest does not match/,
    );
  });
});
