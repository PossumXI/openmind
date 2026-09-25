import { describe, expect, it } from "vitest";
import { sha256DigestCanonical } from "../../src/familiar/canonicalize.js";
import { buildContextUseReceiptV11, type ContextBoundaryInput } from "../../src/familiar/context-boundary.js";
import {
  adaptFamiliarContextUseToMemoryPlane,
  arobiOriginLabelV1Digest,
  arobiOriginTransformationIsMonotone,
  familiarTaintCanClaimOrigin,
  validateArobiOriginLabelV1,
  type ArobiOriginLabelV1,
  type ArobiOriginSourceClass,
} from "../../src/familiar/memory-plane-adapter.js";
import * as familiar from "../../src/familiar/index.js";
import type { ContextUseReceiptV1, Digest } from "../../src/familiar/types.js";

const digest = (char: string): Digest => `sha256:${char.repeat(64)}` as Digest;

/*
 * Golden vectors computed with Immaculate origin/main 9ca84c4
 * (apps/harness/src/memory-security.ts originLabelV1Digest, which is
 * canonicalEffectDigest("arobi/origin-label/v1", ...)). If either side changes
 * its canonicalization, domain or field set, these fail instead of the two
 * repos drifting apart silently.
 */
const GOLDEN_FULL_LABEL: ArobiOriginLabelV1 = {
  schemaVersion: "arobi.origin-label.v1",
  sourceClass: "OPERATOR_TRUSTED",
  contentActivityClass: "PASSIVE",
  producerIdentityDigest: digest("1"),
  tenantScopeDigest: digest("a"),
  trustDomainDigest: digest("b"),
  captureMethodDigest: digest("c"),
  // Duplicate and unsorted on purpose: both sides normalize before hashing.
  parentOriginDigests: [digest("e"), digest("d"), digest("e")],
  propagationPolicyDigest: digest("f"),
};
const GOLDEN_FULL_DIGEST = "sha256:614801331ad14ef75272260763aedcf7b973dd0510640a5cfcb2546549b10fcd";

const GOLDEN_MINIMAL_LABEL: ArobiOriginLabelV1 = {
  schemaVersion: "arobi.origin-label.v1",
  sourceClass: "MODEL_DERIVED",
  contentActivityClass: "UNKNOWN",
  tenantScopeDigest: digest("2"),
  trustDomainDigest: digest("3"),
  captureMethodDigest: digest("4"),
  parentOriginDigests: [],
  propagationPolicyDigest: digest("5"),
};
const GOLDEN_MINIMAL_DIGEST = "sha256:3ae7c529cf9841a33ae742a8b55fa8c8b80b303fae2df177aa6369fb16a56f5b";

/** Immaculate originLabelV1Digest of the label the adapter builds for adapterInput(DERIVED receipt). */
const GOLDEN_ADAPTER_DERIVED_DIGEST = "sha256:eb5d46568c94c8a9203b91966667a8bfca18e3d4dffd30b0778c5d5adce75a2a";

const ORIGIN_CLASSES: readonly ArobiOriginSourceClass[] = [
  "SYSTEM_CANONICAL",
  "OPERATOR_TRUSTED",
  "USER_CONTROLLED",
  "TOOL_OBSERVED",
  "EXTERNAL_UNTRUSTED",
  "MODEL_DERIVED",
];

const parentReceipt: ContextUseReceiptV1 = {
  kind: "arobi.familiar-context-use",
  version: 1,
  receiptId: "context-use-parent-memory-plane",
  familiarId: "familiar-1",
  tenantId: "tenant-a",
  identityEpoch: 41,
  purposeDigest: sha256DigestCanonical({ purpose: "memory-plane-adapter" }),
  retrieved: [],
  opened: [],
  reliedUpon: [],
  rejectedOrConflicting: [],
  proposalDigest: sha256DigestCanonical({ proposal: "effect-memory-plane" }),
  familiarContinuityDigest: sha256DigestCanonical({ continuity: 41 }),
  createdAt: "2026-09-15T20:00:00.000Z",
};

function boundary(overrides: Partial<ContextBoundaryInput> = {}): ContextBoundaryInput {
  return {
    parentReceipt,
    authorityEpoch: 41,
    sourceCompartment: "MEMORY_RECALL",
    destinationCompartment: "PARENT_AGENT",
    rawContentCrossed: false,
    sanitizer: { identity: "context-sanitizer", version: "1.2.0", status: "VALID" },
    validator: {
      identity: "memory-schema-validator",
      version: "1.0.0",
      status: "VALID",
      schemaDigest: sha256DigestCanonical({ schema: "admitted-memory-context-v1" }),
    },
    taintClass: "DERIVED",
    crossedValue: { factId: "memory-17", valueDigest: "bounded" },
    freshUntil: "2026-09-15T21:00:00.000Z",
    downstreamEffectIds: ["effect-1"],
    highRiskPath: true,
    receiptId: "context-boundary-memory-plane",
    createdAt: "2026-09-15T20:01:00.000Z",
    ...overrides,
  };
}

function adapterInput(receipt: ReturnType<typeof buildContextUseReceiptV11>) {
  return {
    receipt,
    tenantScopeDigest: sha256DigestCanonical({ tenant: "tenant-a" }),
    trustDomainDigest: sha256DigestCanonical({ trustDomain: "arobi-memory" }),
    captureMethodDigest: sha256DigestCanonical({ capture: "familiar-context-boundary-v1.1" }),
    propagationPolicyDigest: sha256DigestCanonical({ policy: "origin-monotone-v1" }),
    parentOriginDigests: [sha256DigestCanonical({ origin: "parent-1" })],
  };
}

describe("Familiar -> Arobi Memory Plane compatibility adapter", () => {
  it("is exported from the Familiar package entry point", () => {
    expect(familiar.adaptFamiliarContextUseToMemoryPlane).toBe(adaptFamiliarContextUseToMemoryPlane);
    expect(familiar.arobiOriginLabelV1Digest).toBe(arobiOriginLabelV1Digest);
    expect(familiar.validateArobiOriginLabelV1).toBe(validateArobiOriginLabelV1);
    expect(familiar.arobiOriginTransformationIsMonotone).toBe(arobiOriginTransformationIsMonotone);
    expect(familiar.familiarTaintCanClaimOrigin).toBe(familiarTaintCanClaimOrigin);
  });

  it("MEMORY-ORIGIN-LAUNDER-01 maps derived Familiar context to MODEL_DERIVED", () => {
    const receipt = buildContextUseReceiptV11(boundary({ taintClass: "DERIVED" }));
    const evidence = adaptFamiliarContextUseToMemoryPlane(adapterInput(receipt));
    expect(evidence.originLabel.sourceClass).toBe("MODEL_DERIVED");
    expect(evidence.originLabel.contentActivityClass).toBe("PASSIVE");
    expect(evidence.originLabelDigest).toBe(arobiOriginLabelV1Digest(evidence.originLabel));
    expect(evidence.originLabelDigest).toBe(GOLDEN_ADAPTER_DERIVED_DIGEST);
    expect(evidence.sourceClassBasis).toBe("FAMILIAR_TAINT_MAPPING");
    expect(evidence.admissibleForMemorySelection).toBe(true);
  });

  it("active content stays EXTERNAL_UNTRUSTED and is not admitted through a held boundary", () => {
    const receipt = buildContextUseReceiptV11(boundary({ taintClass: "ACTIVE_CONTENT" }));
    const evidence = adaptFamiliarContextUseToMemoryPlane(adapterInput(receipt));
    expect(evidence.originLabel.sourceClass).toBe("EXTERNAL_UNTRUSTED");
    expect(evidence.originLabel.contentActivityClass).toBe("ACTIVE");
    expect(evidence.boundaryDecision).toBe("HOLD");
    expect(evidence.admissibleForMemorySelection).toBe(false);
  });

  it("TRUSTED does not guess a stronger source origin when the trusted caller omitted provenance", () => {
    const receipt = buildContextUseReceiptV11(boundary({ taintClass: "TRUSTED" }));
    const evidence = adaptFamiliarContextUseToMemoryPlane(adapterInput(receipt));
    expect(evidence.originLabel.sourceClass).toBe("MODEL_DERIVED");
    expect(evidence.originLabel.contentActivityClass).toBe("UNKNOWN");
    expect(evidence.sourceClassBasis).toBe("FAMILIAR_TAINT_MAPPING");
  });

  it.each([
    ["EXTERNAL_UNTRUSTED", "EXTERNAL_UNTRUSTED", "PASSIVE"],
    ["UNKNOWN", "EXTERNAL_UNTRUSTED", "UNKNOWN"],
  ] as const)("%s taint maps to %s/%s", (taintClass, sourceClass, contentActivityClass) => {
    const receipt = buildContextUseReceiptV11(boundary({ taintClass, destinationCompartment: "WORKER_AGENT" }));
    const evidence = adaptFamiliarContextUseToMemoryPlane(adapterInput(receipt));
    expect(evidence.originLabel.sourceClass).toBe(sourceClass);
    expect(evidence.originLabel.contentActivityClass).toBe(contentActivityClass);
    expect(evidence.sourceClassBasis).toBe("FAMILIAR_TAINT_MAPPING");
  });

  it("a trusted caller may explicitly map TRUSTED boundary evidence to an operator origin", () => {
    const receipt = buildContextUseReceiptV11(boundary({ taintClass: "TRUSTED" }));
    const evidence = adaptFamiliarContextUseToMemoryPlane({
      ...adapterInput(receipt),
      trustedSourceClass: "OPERATOR_TRUSTED",
    });
    expect(evidence.originLabel.sourceClass).toBe("OPERATOR_TRUSTED");
    expect(evidence.originLabel.contentActivityClass).toBe("PASSIVE");
    // Recorded as caller-asserted so Memory Plane admission re-resolves it natively.
    expect(evidence.sourceClassBasis).toBe("CALLER_ASSERTED_PROVENANCE");
  });

  it("refuses caller provenance on a non-TRUSTED crossing or an unrecognized provenance class", () => {
    const derived = buildContextUseReceiptV11(boundary({ taintClass: "DERIVED" }));
    expect(() => adaptFamiliarContextUseToMemoryPlane({
      ...adapterInput(derived),
      trustedSourceClass: "SYSTEM_CANONICAL",
    })).toThrow(/FMP_MEMORY_PLANE_ADAPTER_INVALID: trustedSourceClass is only honored/);
    const trusted = buildContextUseReceiptV11(boundary({ taintClass: "TRUSTED" }));
    for (const trustedSourceClass of ["MODEL_DERIVED", "EXTERNAL_UNTRUSTED", "ROOT"]) {
      expect(() => adaptFamiliarContextUseToMemoryPlane({
        ...adapterInput(trusted),
        trustedSourceClass: trustedSourceClass as never,
      })).toThrow(/trustedSourceClass must be a recognized first-party origin class/);
    }
  });

  it("monotone trust helper blocks derived/untrusted elevation", () => {
    expect(familiarTaintCanClaimOrigin("DERIVED", "OPERATOR_TRUSTED")).toBe(false);
    expect(familiarTaintCanClaimOrigin("EXTERNAL_UNTRUSTED", "SYSTEM_CANONICAL")).toBe(false);
    expect(familiarTaintCanClaimOrigin("ACTIVE_CONTENT", "TOOL_OBSERVED")).toBe(false);
    expect(familiarTaintCanClaimOrigin("DERIVED", "MODEL_DERIVED")).toBe(true);
  });

  it("TRUSTED without verified provenance cannot claim a first-party origin", () => {
    expect(familiarTaintCanClaimOrigin("TRUSTED", "SYSTEM_CANONICAL")).toBe(false);
    expect(familiarTaintCanClaimOrigin("TRUSTED", "OPERATOR_TRUSTED")).toBe(false);
    expect(familiarTaintCanClaimOrigin("TRUSTED", "MODEL_DERIVED")).toBe(true);
    expect(familiarTaintCanClaimOrigin("TRUSTED", "EXTERNAL_UNTRUSTED")).toBe(true);
    // With separately verified provenance only that class (or a degradation) may be claimed.
    expect(familiarTaintCanClaimOrigin("TRUSTED", "OPERATOR_TRUSTED", "OPERATOR_TRUSTED")).toBe(true);
    expect(familiarTaintCanClaimOrigin("TRUSTED", "SYSTEM_CANONICAL", "OPERATOR_TRUSTED")).toBe(false);
    expect(() => familiarTaintCanClaimOrigin("DERIVED", "OPERATOR_TRUSTED", "OPERATOR_TRUSTED")).toThrow(
      /only honored for a TRUSTED context crossing/,
    );
  });

  it("origin monotonicity matches Immaculate originTransformationIsMonotone exactly", () => {
    // Immaculate memory-security.test.ts MEMORY-ORIGIN-LAUNDER-01 cases.
    expect(arobiOriginTransformationIsMonotone("EXTERNAL_UNTRUSTED", "MODEL_DERIVED")).toBe(true);
    expect(arobiOriginTransformationIsMonotone("EXTERNAL_UNTRUSTED", "OPERATOR_TRUSTED")).toBe(false);
    expect(arobiOriginTransformationIsMonotone("USER_CONTROLLED", "SYSTEM_CANONICAL")).toBe(false);
    // Full 6x6 table: same class, or degrade to MODEL_DERIVED / EXTERNAL_UNTRUSTED (16 pairs).
    const allowed: string[] = [];
    for (const input of ORIGIN_CLASSES) {
      for (const output of ORIGIN_CLASSES) {
        if (arobiOriginTransformationIsMonotone(input, output)) allowed.push(`${input}->${output}`);
      }
    }
    expect(allowed).toHaveLength(16);
    for (const input of ORIGIN_CLASSES) {
      expect(allowed).toContain(`${input}->${input}`);
      expect(allowed).toContain(`${input}->MODEL_DERIVED`);
      expect(allowed).toContain(`${input}->EXTERNAL_UNTRUSTED`);
    }
  });

  it("OriginLabelV1 digest matches Immaculate golden vectors byte-for-byte", () => {
    expect(arobiOriginLabelV1Digest(GOLDEN_FULL_LABEL)).toBe(GOLDEN_FULL_DIGEST);
    expect(arobiOriginLabelV1Digest(GOLDEN_MINIMAL_LABEL)).toBe(GOLDEN_MINIMAL_DIGEST);
    expect(arobiOriginLabelV1Digest({
      ...GOLDEN_FULL_LABEL,
      parentOriginDigests: [digest("d"), digest("e")],
    })).toBe(GOLDEN_FULL_DIGEST);
    expect(validateArobiOriginLabelV1(GOLDEN_FULL_LABEL)).toEqual([]);
    expect(validateArobiOriginLabelV1(GOLDEN_MINIMAL_LABEL)).toEqual([]);
  });

  it("fails closed on malformed OriginLabelV1 fields with Immaculate reason codes", () => {
    expect(validateArobiOriginLabelV1({
      ...GOLDEN_FULL_LABEL,
      schemaVersion: "arobi.origin-label.v0" as never,
      sourceClass: "ROOT" as never,
      contentActivityClass: "EXECUTABLE" as never,
      producerIdentityDigest: "" as Digest,
      tenantScopeDigest: "tenant-a" as Digest,
      trustDomainDigest: `sha256:${"A".repeat(64)}` as Digest,
      captureMethodDigest: ` ${digest("c")}` as Digest,
      parentOriginDigests: [digest("d"), "" as Digest],
      propagationPolicyDigest: "sha256:abc" as Digest,
    })).toEqual([
      "unsupported_origin_label_schema",
      "origin_label_invalid_source_class",
      "origin_label_invalid_content_activity_class",
      "origin_label_invalid_tenant_scope_digest",
      "origin_label_invalid_trust_domain_digest",
      "origin_label_invalid_capture_method_digest",
      "origin_label_invalid_propagation_policy_digest",
      "origin_label_invalid_producer_identity_digest",
      "origin_label_invalid_parent_digest",
    ]);
    expect(validateArobiOriginLabelV1({
      ...GOLDEN_MINIMAL_LABEL,
      parentOriginDigests: "sha256:not-an-array" as never,
    })).toEqual(["origin_label_invalid_parent_digest"]);
    expect(() => arobiOriginLabelV1Digest({
      ...GOLDEN_MINIMAL_LABEL,
      parentOriginDigests: [` ${digest("d")} ` as Digest],
    })).toThrow(/FMP_INVALID_ORIGIN_LABEL: origin_label_invalid_parent_digest/);
  });

  it.each([
    ["tenantScopeDigest", "origin_label_invalid_tenant_scope_digest"],
    ["trustDomainDigest", "origin_label_invalid_trust_domain_digest"],
    ["captureMethodDigest", "origin_label_invalid_capture_method_digest"],
    ["propagationPolicyDigest", "origin_label_invalid_propagation_policy_digest"],
    ["producerIdentityDigest", "origin_label_invalid_producer_identity_digest"],
  ] as const)("adapter rejects a non-digest %s instead of emitting evidence", (field, reason) => {
    const receipt = buildContextUseReceiptV11(boundary({ taintClass: "DERIVED" }));
    expect(() => adaptFamiliarContextUseToMemoryPlane({
      ...adapterInput(receipt),
      [field]: "not-a-digest",
    })).toThrow(new RegExp(`FMP_INVALID_ORIGIN_LABEL: ${reason}`));
  });

  it("adapter rejects non-digest parent origins and malformed receipts", () => {
    const receipt = buildContextUseReceiptV11(boundary({ taintClass: "DERIVED" }));
    expect(() => adaptFamiliarContextUseToMemoryPlane({
      ...adapterInput(receipt),
      parentOriginDigests: [digest("d"), "" as Digest],
    })).toThrow(/parentOriginDigests must be sha256/);
    expect(() => adaptFamiliarContextUseToMemoryPlane({
      ...adapterInput(receipt),
      parentOriginDigests: digest("d") as never,
    })).toThrow(/parentOriginDigests must be sha256/);
    expect(() => adaptFamiliarContextUseToMemoryPlane(adapterInput({
      ...receipt,
      kind: "arobi.familiar-context-use" as never,
    }))).toThrow(/receipt must be an arobi.familiar-context-use.v1.1 receipt/);
    expect(() => adaptFamiliarContextUseToMemoryPlane(adapterInput({
      ...receipt,
      crossedValueDigest: "sha256:raw" as Digest,
    }))).toThrow(/parentReceiptDigest and crossedValueDigest must be sha256/);
  });

  it("omitting parentOriginDigests yields an empty, still-valid origin lineage", () => {
    const receipt = buildContextUseReceiptV11(boundary({ taintClass: "DERIVED" }));
    const { parentOriginDigests: _omitted, ...withoutParents } = adapterInput(receipt);
    const evidence = adaptFamiliarContextUseToMemoryPlane({ ...withoutParents, producerIdentityDigest: digest("9") });
    expect(evidence.originLabel.parentOriginDigests).toEqual([]);
    expect(evidence.originLabel.producerIdentityDigest).toBe(digest("9"));
    expect(validateArobiOriginLabelV1(evidence.originLabel)).toEqual([]);
  });

  it("adapter evidence carries only digests and bounded metadata, not the crossed raw value", () => {
    const raw = "private-memory-text-that-must-not-be-copied";
    const receipt = buildContextUseReceiptV11(boundary({ crossedValue: raw, taintClass: "DERIVED" }));
    const evidence = adaptFamiliarContextUseToMemoryPlane(adapterInput(receipt));
    expect(JSON.stringify(evidence)).not.toContain(raw);
    expect(evidence.crossedValueDigest).toBe(sha256DigestCanonical(raw));
  });
});
