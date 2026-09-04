import { describe, expect, it } from "vitest";
import {
  FamiliarCanonicalizationError,
  FamiliarValidationError,
  assertContextUseReceiptV1,
  assertFamiliarCapsuleV1,
  assertFamiliarMemoryArtifactV1,
  assertMemoryMutationReceiptV1,
  assertSameFamiliarScope,
  canonicalizeFamiliarValue,
  sha256DigestCanonical,
  type FamiliarMemoryArtifactV1,
} from "../../src/familiar/index.js";

const D1 = `sha256:${"1".repeat(64)}` as const;
const D2 = `sha256:${"2".repeat(64)}` as const;
const D3 = `sha256:${"3".repeat(64)}` as const;
const D4 = `sha256:${"4".repeat(64)}` as const;
const D5 = `sha256:${"5".repeat(64)}` as const;
const NOW = "2026-09-04T12:00:00.000Z";

function memory(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "arobi.familiar-memory",
    version: 1,
    memoryId: "memory-1",
    familiarId: "familiar-1",
    tenantId: "tenant-1",
    identityEpoch: 1,
    memoryClass: "PREFERENCE",
    contentDigest: D1,
    originLabelDigest: D2,
    sourceArtifacts: [D3],
    transformationChain: [],
    trustClass: "OPERATOR_AUTHORED",
    supportState: "CORROBORATED",
    mayInform: true,
    mayAuthorize: false,
    revision: 1,
    createdAt: NOW,
    ...overrides,
  };
}

describe("FMP canonicalization", () => {
  it("is stable across object insertion order and nested key order", () => {
    const a = {
      z: 4,
      a: { two: 2, one: 1 },
      m: ["x", { b: true, a: false }],
    };
    const b = {
      m: ["x", { a: false, b: true }],
      a: { one: 1, two: 2 },
      z: 4,
    };

    expect(canonicalizeFamiliarValue(a)).toBe(canonicalizeFamiliarValue(b));
    expect(sha256DigestCanonical(a)).toBe(sha256DigestCanonical(b));
  });

  it("preserves array order as semantically significant", () => {
    expect(sha256DigestCanonical({ sources: [D1, D2] }))
      .not.toBe(sha256DigestCanonical({ sources: [D2, D1] }));
  });

  it("normalizes negative zero to JSON zero", () => {
    expect(canonicalizeFamiliarValue({ n: -0 })).toBe('{"n":0}');
  });

  it("rejects non-finite, unsupported, non-plain, and cyclic values", () => {
    expect(() => canonicalizeFamiliarValue({ n: Number.NaN })).toThrow(FamiliarCanonicalizationError);
    expect(() => canonicalizeFamiliarValue({ x: undefined })).toThrow(FamiliarCanonicalizationError);
    expect(() => canonicalizeFamiliarValue(new Date())).toThrow(FamiliarCanonicalizationError);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalizeFamiliarValue(cyclic)).toThrow(FamiliarCanonicalizationError);
  });
});

describe("FMP memory authority boundary", () => {
  it("accepts a well-formed memory that can inform but cannot authorize", () => {
    const value = memory();
    expect(() => assertFamiliarMemoryArtifactV1(value)).not.toThrow();
  });

  it("rejects a memory that attempts to mint live authority", () => {
    const value = memory({ mayAuthorize: true });
    expect(() => assertFamiliarMemoryArtifactV1(value)).toThrowError(
      expect.objectContaining<FamiliarValidationError>({ code: "FMP_MEMORY_CANNOT_AUTHORIZE" }),
    );
  });

  it("allows AUTHORITY_REFERENCE only as a non-authorizing memory class", () => {
    const value = memory({ memoryClass: "AUTHORITY_REFERENCE", mayAuthorize: false });
    expect(() => assertFamiliarMemoryArtifactV1(value)).not.toThrow();
  });

  it("rejects malformed digests and duplicate provenance", () => {
    expect(() => assertFamiliarMemoryArtifactV1(memory({ contentDigest: "sha256:BAD" })))
      .toThrowError(expect.objectContaining<FamiliarValidationError>({ code: "FMP_INVALID_DIGEST" }));

    expect(() => assertFamiliarMemoryArtifactV1(memory({ sourceArtifacts: [D3, D3] })))
      .toThrowError(expect.objectContaining<FamiliarValidationError>({ code: "FMP_DUPLICATE_DIGEST" }));
  });
});

describe("FMP mutation lineage", () => {
  it("accepts CREATE with no previous digest and a next digest", () => {
    const receipt = {
      kind: "arobi.familiar-memory-mutation",
      version: 1,
      mutationId: "mutation-1",
      familiarId: "familiar-1",
      tenantId: "tenant-1",
      identityEpoch: 1,
      operation: "CREATE",
      actorRef: "principal:operator-1",
      reasonDigest: D1,
      policyEpoch: 2,
      previousDigests: [],
      nextDigest: D2,
      evidenceDigests: [],
      createdAt: NOW,
    };
    expect(() => assertMemoryMutationReceiptV1(receipt)).not.toThrow();
  });

  it("rejects CREATE that pretends to have prior lineage", () => {
    const receipt = {
      kind: "arobi.familiar-memory-mutation",
      version: 1,
      mutationId: "mutation-1",
      familiarId: "familiar-1",
      tenantId: "tenant-1",
      identityEpoch: 1,
      operation: "CREATE",
      actorRef: "principal:operator-1",
      reasonDigest: D1,
      policyEpoch: 2,
      previousDigests: [D2],
      nextDigest: D3,
      evidenceDigests: [],
      createdAt: NOW,
    };
    expect(() => assertMemoryMutationReceiptV1(receipt))
      .toThrowError(expect.objectContaining<FamiliarValidationError>({ code: "FMP_INVALID_MUTATION" }));
  });

  it("requires at least two sources for MERGE", () => {
    const receipt = {
      kind: "arobi.familiar-memory-mutation",
      version: 1,
      mutationId: "mutation-merge",
      familiarId: "familiar-1",
      tenantId: "tenant-1",
      identityEpoch: 1,
      operation: "MERGE",
      actorRef: "agent:memory-worker",
      reasonDigest: D1,
      policyEpoch: 2,
      previousDigests: [D2],
      nextDigest: D3,
      evidenceDigests: [],
      createdAt: NOW,
    };
    expect(() => assertMemoryMutationReceiptV1(receipt))
      .toThrowError(expect.objectContaining<FamiliarValidationError>({ code: "FMP_INVALID_MUTATION" }));
  });

  it("rejects silent cross-tenant, cross-familiar, or cross-epoch transitions", () => {
    const before = memory() as unknown as FamiliarMemoryArtifactV1;

    expect(() => assertSameFamiliarScope(before, memory({ tenantId: "tenant-2" }) as unknown as FamiliarMemoryArtifactV1))
      .toThrowError(expect.objectContaining<FamiliarValidationError>({ code: "FMP_SCOPE_MISMATCH" }));
    expect(() => assertSameFamiliarScope(before, memory({ familiarId: "familiar-2" }) as unknown as FamiliarMemoryArtifactV1))
      .toThrowError(expect.objectContaining<FamiliarValidationError>({ code: "FMP_SCOPE_MISMATCH" }));
    expect(() => assertSameFamiliarScope(before, memory({ identityEpoch: 2 }) as unknown as FamiliarMemoryArtifactV1))
      .toThrowError(expect.objectContaining<FamiliarValidationError>({ code: "FMP_SCOPE_MISMATCH" }));
  });
});

describe("FMP context-use honesty", () => {
  function receipt(overrides: Record<string, unknown> = {}) {
    return {
      kind: "arobi.familiar-context-use",
      version: 1,
      receiptId: "context-1",
      familiarId: "familiar-1",
      tenantId: "tenant-1",
      identityEpoch: 1,
      purposeDigest: D1,
      retrieved: [D2, D3, D4],
      opened: [D2, D3],
      reliedUpon: [D2],
      rejectedOrConflicting: [D3],
      proposalDigest: D4,
      familiarContinuityDigest: D5,
      createdAt: NOW,
      ...overrides,
    };
  }

  it("accepts subset lineage: relied -> opened -> retrieved", () => {
    expect(() => assertContextUseReceiptV1(receipt())).not.toThrow();
  });

  it("rejects claiming reliance on memory that was never opened", () => {
    expect(() => assertContextUseReceiptV1(receipt({ reliedUpon: [D4] })))
      .toThrowError(expect.objectContaining<FamiliarValidationError>({ code: "FMP_CONTEXT_LINEAGE" }));
  });

  it("rejects claiming an opened memory that was never retrieved", () => {
    expect(() => assertContextUseReceiptV1(receipt({ opened: [D5] })))
      .toThrowError(expect.objectContaining<FamiliarValidationError>({ code: "FMP_CONTEXT_LINEAGE" }));
  });
});

describe("FMP capsule portability", () => {
  function capsule(authorityPortable: boolean) {
    return {
      kind: "arobi.familiar-capsule",
      version: 1,
      capsuleId: "capsule-1",
      familiarId: "familiar-1",
      tenantId: "tenant-1",
      identityEpoch: 1,
      manifestDigest: D1,
      continuityDigest: D2,
      selectedMemoryDigests: [D3],
      selectedSkillDigests: [],
      privacyConstraintDigests: [],
      provenanceDigests: [D4],
      authorityPortable,
      createdAt: NOW,
    };
  }

  it("accepts portability of identity/memory without authority", () => {
    expect(() => assertFamiliarCapsuleV1(capsule(false))).not.toThrow();
  });

  it("rejects an imported capsule that claims authority is portable", () => {
    expect(() => assertFamiliarCapsuleV1(capsule(true)))
      .toThrowError(expect.objectContaining<FamiliarValidationError>({ code: "FMP_AUTHORITY_NOT_PORTABLE" }));
  });
});
