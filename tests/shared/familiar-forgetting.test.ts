import { describe, expect, it } from "vitest";
import {
  AROBI_CONTROLLED_FORGET_SURFACES,
  finalizeFamiliarForget,
  type Digest,
  type FamiliarMemoryArtifactV1,
} from "../../src/familiar/index.js";

const D1 = `sha256:${"1".repeat(64)}` as Digest;
const D2 = `sha256:${"2".repeat(64)}` as Digest;
const D3 = `sha256:${"3".repeat(64)}` as Digest;
const NOW = "2026-09-04T21:00:00.000Z";

function memory(): FamiliarMemoryArtifactV1 {
  return {
    kind: "arobi.familiar-memory",
    version: 1,
    memoryId: "memory-1",
    tenantId: "tenant-1",
    familiarId: "familiar-1",
    identityEpoch: 4,
    memoryClass: "EPISODIC",
    contentDigest: D1,
    originLabelDigest: D2,
    sourceArtifacts: [D3],
    transformationChain: [],
    trustClass: "OPERATOR_AUTHORED",
    supportState: "ASSERTED",
    mayInform: true,
    mayAuthorize: false,
    revision: 1,
    createdAt: NOW,
  };
}

function verifiedSurfaces() {
  return AROBI_CONTROLLED_FORGET_SURFACES.map((surface, index) => ({
    surface,
    state: "VERIFIED" as const,
    verificationDigest: `sha256:${String(index + 4).repeat(64)}` as Digest,
  }));
}

describe("FMP controlled forgetting", () => {
  it("does not issue a FORGET mutation or tombstone while a controlled surface result is missing", () => {
    const surfaces = verifiedSurfaces().filter((surface) => surface.surface !== "LIVE_CACHE");
    const result = finalizeFamiliarForget({
      memory: memory(),
      actorRef: "principal:operator-1",
      reasonDigest: D3,
      policyEpoch: 7,
      surfaces,
      createdAt: NOW,
    });

    expect(result.state).toBe("INCOMPLETE");
    if (result.state !== "INCOMPLETE") throw new Error("expected incomplete forgetting");
    expect(result.missingSurfaces).toContain("LIVE_CACHE");
    expect(result.reasonCodes).toContain("CONTROLLED_SURFACE_RESULT_MISSING");
    expect("tombstone" in result).toBe(false);
  });

  it("does not claim forgetting when a controlled vector/index erasure fails", () => {
    const surfaces = verifiedSurfaces().map((surface) =>
      surface.surface === "EMBEDDING_INDEX"
        ? { ...surface, state: "FAILED" as const, verificationDigest: undefined }
        : surface,
    );
    const result = finalizeFamiliarForget({
      memory: memory(),
      actorRef: "principal:operator-1",
      reasonDigest: D3,
      policyEpoch: 7,
      surfaces,
      createdAt: NOW,
    });

    expect(result.state).toBe("INCOMPLETE");
    if (result.state !== "INCOMPLETE") throw new Error("expected incomplete forgetting");
    expect(result.failedSurfaces).toContain("EMBEDDING_INDEX");
    expect(result.reasonCodes).toContain("CONTROLLED_SURFACE_ERASURE_FAILED");
  });

  it("rejects marking an Arobi-controlled live surface OUTSIDE_CONTROL", () => {
    const surfaces = verifiedSurfaces().map((surface) =>
      surface.surface === "LIVE_CACHE"
        ? { ...surface, state: "OUTSIDE_CONTROL" as const, verificationDigest: undefined }
        : surface,
    );
    const result = finalizeFamiliarForget({
      memory: memory(),
      actorRef: "principal:operator-1",
      reasonDigest: D3,
      policyEpoch: 7,
      surfaces,
      createdAt: NOW,
    });

    expect(result.state).toBe("INCOMPLETE");
    if (result.state !== "INCOMPLETE") throw new Error("expected incomplete forgetting");
    expect(result.unverifiableSurfaces).toContain("LIVE_CACHE");
  });

  it("allows explicitly external surfaces to remain OUTSIDE_CONTROL while every Arobi-controlled surface is verified", () => {
    const result = finalizeFamiliarForget({
      memory: memory(),
      actorRef: "principal:operator-1",
      reasonDigest: D3,
      policyEpoch: 7,
      surfaces: [
        ...verifiedSurfaces(),
        {
          surface: "THIRD_PARTY_BACKUP",
          state: "OUTSIDE_CONTROL",
          detail: "Provider retention is outside Arobi-controlled storage surfaces.",
        },
      ],
      invalidatedDerivedDigests: [D2],
      createdAt: NOW,
    });

    expect(result.state).toBe("VERIFIED");
    if (result.state !== "VERIFIED") throw new Error("expected verified forgetting");
    expect(result.mutation.operation).toBe("FORGET");
    expect(result.tombstone.forgottenDigest).toBe(result.memoryDigest);
    expect(result.tombstone.mutationReceiptDigest).toBe(result.mutationDigest);
    expect(result.tombstone.surfaces.find((surface) => surface.surface === "THIRD_PARTY_BACKUP")?.state)
      .toBe("OUTSIDE_CONTROL");
  });

  it("requires concrete verification evidence for a VERIFIED surface", () => {
    const surfaces = verifiedSurfaces();
    surfaces[0] = { ...surfaces[0], verificationDigest: undefined as unknown as Digest };
    expect(() =>
      finalizeFamiliarForget({
        memory: memory(),
        actorRef: "principal:operator-1",
        reasonDigest: D3,
        policyEpoch: 7,
        surfaces,
        createdAt: NOW,
      }),
    ).toThrow(/verificationDigest/);
  });

  it("deduplicates a shared verification artifact referenced by multiple controlled surfaces", () => {
    const shared = `sha256:${"9".repeat(64)}` as Digest;
    const surfaces = verifiedSurfaces().map((surface) => ({ ...surface, verificationDigest: shared }));
    const result = finalizeFamiliarForget({
      memory: memory(),
      actorRef: "principal:operator-1",
      reasonDigest: D3,
      policyEpoch: 7,
      surfaces,
      createdAt: NOW,
    });

    expect(result.state).toBe("VERIFIED");
    if (result.state !== "VERIFIED") throw new Error("expected verified forgetting");
    expect(result.mutation.evidenceDigests).toEqual([shared]);
  });
});
