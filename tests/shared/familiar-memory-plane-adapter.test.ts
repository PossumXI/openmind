import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FamiliarCanonicalizationError,
  canonicalizeFamiliarValue,
  sha256DigestCanonical,
  sha256DomainDigestCanonical,
} from "../../src/familiar/canonicalize.js";
import {
  buildContextUseReceiptV11,
  contextUseReceiptV11Digest,
  type ContextBoundaryInput,
  type ContextUseReceiptV11,
} from "../../src/familiar/context-boundary.js";
import {
  FAMILIAR_MEMORY_PLANE_EVIDENCE_LIMITS,
  FAMILIAR_MEMORY_PLANE_EVIDENCE_V1_DIGEST_DOMAIN,
  adaptFamiliarContextUseToMemoryPlane,
  arobiOriginLabelV1Digest,
  arobiOriginTransformationIsMonotone,
  familiarTaintCanClaimOrigin,
  validateArobiOriginLabelV1,
  type ArobiOriginLabelV1,
  type ArobiOriginSourceClass,
  type FamiliarMemoryPlaneAdapterInput,
} from "../../src/familiar/memory-plane-adapter.js";
import * as familiar from "../../src/familiar/index.js";
import type { ContextUseReceiptV1, Digest } from "../../src/familiar/types.js";
import { FamiliarValidationError } from "../../src/familiar/validate.js";

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

/**
 * evidenceDigest of adapterInput(DERIVED receipt), computed with Immaculate
 * evidence-lineage canonicalEffectDigest("arobi/familiar-memory-plane-evidence/v1", core)
 * (apps/harness/src/evidence-lineage.ts, unchanged at Immaculate main 85d3d33).
 */
const GOLDEN_ADAPTER_DERIVED_EVIDENCE_DIGEST = "sha256:d9dbcbe388b47779852d8c86ed085861376ce66183e5b76dc6035e4d2c6029c3";

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

/** Inside the receipt's freshness window (createdAt 20:01, freshUntil 21:00). */
const FRESH_AT = "2026-09-15T20:30:00.000Z";

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

function adapterInput(receipt: ContextUseReceiptV11): FamiliarMemoryPlaneAdapterInput {
  return {
    receipt,
    tenantScopeDigest: sha256DigestCanonical({ tenant: "tenant-a" }),
    trustDomainDigest: sha256DigestCanonical({ trustDomain: "arobi-memory" }),
    captureMethodDigest: sha256DigestCanonical({ capture: "familiar-context-boundary-v1.1" }),
    propagationPolicyDigest: sha256DigestCanonical({ policy: "origin-monotone-v1" }),
    parentOriginDigests: [sha256DigestCanonical({ origin: "parent-1" })],
    evaluatedAt: FRESH_AT,
  };
}

function derivedReceipt(overrides: Partial<ContextBoundaryInput> = {}): ContextUseReceiptV11 {
  return buildContextUseReceiptV11(boundary({ taintClass: "DERIVED", ...overrides }));
}

/** Asserts the adapter fails with a FamiliarValidationError (not a TypeError) carrying `code`. */
function expectAdapterError(input: FamiliarMemoryPlaneAdapterInput, code: string, message: RegExp): void {
  let thrown: unknown;
  try {
    adaptFamiliarContextUseToMemoryPlane(input);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(FamiliarValidationError);
  expect((thrown as FamiliarValidationError).code).toBe(code);
  expect((thrown as Error).message).toMatch(message);
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
    const receipt = derivedReceipt();
    const evidence = adaptFamiliarContextUseToMemoryPlane(adapterInput(receipt));
    expect(evidence.originLabel.sourceClass).toBe("MODEL_DERIVED");
    expect(evidence.originLabel.contentActivityClass).toBe("PASSIVE");
    expect(evidence.originLabelDigest).toBe(arobiOriginLabelV1Digest(evidence.originLabel));
    expect(evidence.originLabelDigest).toBe(GOLDEN_ADAPTER_DERIVED_DIGEST);
    expect(evidence.sourceClassBasis).toBe("FAMILIAR_TAINT_MAPPING");
    expect(evidence.admissibleForMemorySelection).toBe(true);
  });

  it("evidenceDigest is the domain-separated digest Immaculate canonicalEffectDigest computes", () => {
    const { evidenceDigest, ...core } = adaptFamiliarContextUseToMemoryPlane(adapterInput(derivedReceipt()));
    expect(evidenceDigest).toBe(GOLDEN_ADAPTER_DERIVED_EVIDENCE_DIGEST);
    const independent = `sha256:${createHash("sha256")
      .update(`${FAMILIAR_MEMORY_PLANE_EVIDENCE_V1_DIGEST_DOMAIN}\n${canonicalizeFamiliarValue(core)}`, "utf8")
      .digest("hex")}`;
    expect(evidenceDigest).toBe(independent);
    expect(evidenceDigest).not.toBe(sha256DigestCanonical(core));
  });

  it("sha256DomainDigestCanonical follows canonicalEffectDigest and refuses an ambiguous domain", () => {
    // canonicalEffectDigest JSON round-trips first, so undefined fields do not change the digest.
    expect(sha256DomainDigestCanonical("arobi/test/v1", { a: 1, b: undefined })).toBe(
      sha256DomainDigestCanonical("arobi/test/v1", { a: 1 }),
    );
    expect(sha256DomainDigestCanonical("arobi/test/v1", { a: 1 })).not.toBe(
      sha256DomainDigestCanonical("arobi/other/v1", { a: 1 }),
    );
    for (const domain of ["", "arobi/test/v1\n{}", 7]) {
      expect(() => sha256DomainDigestCanonical(domain as never, { a: 1 })).toThrow(FamiliarCanonicalizationError);
    }
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
      producerIdentityDigest: digest("7"),
    });
    expect(evidence.originLabel.sourceClass).toBe("OPERATOR_TRUSTED");
    expect(evidence.originLabel.contentActivityClass).toBe("PASSIVE");
    expect(evidence.originLabel.producerIdentityDigest).toBe(digest("7"));
    // Recorded as caller-asserted so Memory Plane admission re-resolves it natively.
    expect(evidence.sourceClassBasis).toBe("CALLER_ASSERTED_PROVENANCE");
  });

  it("refuses a caller-asserted first-party origin that does not name its producer", () => {
    const receipt = buildContextUseReceiptV11(boundary({ taintClass: "TRUSTED" }));
    expectAdapterError(
      { ...adapterInput(receipt), trustedSourceClass: "SYSTEM_CANONICAL" },
      "FMP_MEMORY_PLANE_ADAPTER_INVALID",
      /trustedSourceClass requires producerIdentityDigest/,
    );
  });

  it("refuses caller provenance on a non-TRUSTED crossing or an unrecognized provenance class", () => {
    const derived = derivedReceipt();
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

  it("any taint may degrade to MODEL_DERIVED (Immaculate rule; #6 returned false for these)", () => {
    for (const taintClass of ["EXTERNAL_UNTRUSTED", "ACTIVE_CONTENT", "UNKNOWN"] as const) {
      expect(familiarTaintCanClaimOrigin(taintClass, "MODEL_DERIVED")).toBe(true);
      expect(familiarTaintCanClaimOrigin(taintClass, "EXTERNAL_UNTRUSTED")).toBe(true);
    }
  });

  it("TRUSTED without verified provenance cannot claim a first-party origin", () => {
    expect(familiarTaintCanClaimOrigin("TRUSTED", "SYSTEM_CANONICAL")).toBe(false);
    expect(familiarTaintCanClaimOrigin("TRUSTED", "OPERATOR_TRUSTED")).toBe(false);
    expect(familiarTaintCanClaimOrigin("TRUSTED", "MODEL_DERIVED")).toBe(true);
    expect(familiarTaintCanClaimOrigin("TRUSTED", "EXTERNAL_UNTRUSTED")).toBe(true);
    // With a caller-asserted class only that class (or a degradation) may be claimed.
    expect(familiarTaintCanClaimOrigin("TRUSTED", "OPERATOR_TRUSTED", "OPERATOR_TRUSTED")).toBe(true);
    expect(familiarTaintCanClaimOrigin("TRUSTED", "SYSTEM_CANONICAL", "OPERATOR_TRUSTED")).toBe(false);
    expect(() => familiarTaintCanClaimOrigin("DERIVED", "OPERATOR_TRUSTED", "OPERATOR_TRUSTED")).toThrow(
      /only honored for a TRUSTED context crossing/,
    );
  });

  it("does not verify the caller-asserted class: it is taken as given", () => {
    // Documented behavior: the third argument is caller-asserted, not verified.
    expect(familiarTaintCanClaimOrigin("TRUSTED", "SYSTEM_CANONICAL", "SYSTEM_CANONICAL")).toBe(true);
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

  it("fails closed on malformed OriginLabelV1 fields: Immaculate codes and order, then Familiar-only codes", () => {
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
      // Same codes, same order as Immaculate validateOriginLabelV1 ...
      "unsupported_origin_label_schema",
      "origin_label_invalid_tenant_scope_digest",
      "origin_label_invalid_trust_domain_digest",
      "origin_label_invalid_capture_method_digest",
      "origin_label_invalid_propagation_policy_digest",
      "origin_label_invalid_producer_identity_digest",
      "origin_label_invalid_parent_digest",
      // ... then the Familiar-only enum checks.
      "origin_label_invalid_source_class",
      "origin_label_invalid_content_activity_class",
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

  it("reports one parent error per malformed parent, as Immaculate does", () => {
    expect(validateArobiOriginLabelV1({
      ...GOLDEN_MINIMAL_LABEL,
      parentOriginDigests: ["" as Digest, digest("d"), "sha256:abc" as Digest],
    })).toEqual(["origin_label_invalid_parent_digest", "origin_label_invalid_parent_digest"]);
  });

  it("refuses a label with fields outside OriginLabelV1 instead of digesting them", () => {
    const widened = { ...GOLDEN_MINIMAL_LABEL, grantsAuthority: true } as unknown as ArobiOriginLabelV1;
    expect(validateArobiOriginLabelV1(widened)).toEqual(["origin_label_unexpected_field"]);
    expect(() => arobiOriginLabelV1Digest(widened)).toThrow(/FMP_INVALID_ORIGIN_LABEL: origin_label_unexpected_field/);
  });

  it("refuses a non-object label with a typed error instead of a TypeError", () => {
    for (const label of [null, undefined, "label", [GOLDEN_MINIMAL_LABEL]]) {
      expect(validateArobiOriginLabelV1(label as never)).toEqual(["origin_label_not_object"]);
      expect(() => arobiOriginLabelV1Digest(label as never)).toThrow(FamiliarValidationError);
    }
  });

  it.each([
    ["tenantScopeDigest", "origin_label_invalid_tenant_scope_digest"],
    ["trustDomainDigest", "origin_label_invalid_trust_domain_digest"],
    ["captureMethodDigest", "origin_label_invalid_capture_method_digest"],
    ["propagationPolicyDigest", "origin_label_invalid_propagation_policy_digest"],
    ["producerIdentityDigest", "origin_label_invalid_producer_identity_digest"],
  ] as const)("adapter rejects a non-digest %s instead of emitting evidence", (field, reason) => {
    const receipt = derivedReceipt();
    expect(() => adaptFamiliarContextUseToMemoryPlane({
      ...adapterInput(receipt),
      [field]: "not-a-digest",
    })).toThrow(new RegExp(`FMP_INVALID_ORIGIN_LABEL: ${reason}`));
  });

  it("adapter rejects non-digest parent origins and malformed receipts", () => {
    const receipt = derivedReceipt();
    expect(() => adaptFamiliarContextUseToMemoryPlane({
      ...adapterInput(receipt),
      parentOriginDigests: [digest("d"), "" as Digest],
    })).toThrow(/parentOriginDigests must be at most 64 sha256/);
    expect(() => adaptFamiliarContextUseToMemoryPlane({
      ...adapterInput(receipt),
      parentOriginDigests: digest("d") as never,
    })).toThrow(/parentOriginDigests must be at most 64 sha256/);
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
    const receipt = derivedReceipt();
    const { parentOriginDigests: _omitted, ...withoutParents } = adapterInput(receipt);
    const evidence = adaptFamiliarContextUseToMemoryPlane({ ...withoutParents, producerIdentityDigest: digest("9") });
    expect(evidence.originLabel.parentOriginDigests).toEqual([]);
    expect(evidence.originLabel.producerIdentityDigest).toBe(digest("9"));
    expect(validateArobiOriginLabelV1(evidence.originLabel)).toEqual([]);
  });

  it("adapter evidence carries only digests and bounded metadata, not the crossed raw value", () => {
    const raw = "private-memory-text-that-must-not-be-copied";
    const receipt = derivedReceipt({ crossedValue: raw });
    const evidence = adaptFamiliarContextUseToMemoryPlane(adapterInput(receipt));
    expect(JSON.stringify(evidence)).not.toContain(raw);
    expect(evidence.crossedValueDigest).toBe(sha256DigestCanonical(raw));
  });
});

describe("Memory Plane adapter admissibility honors freshUntil", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a receipt that was ALLOW when built but is stale when adapted is not admissible", () => {
    const receipt = derivedReceipt();
    expect(receipt.decision).toBe("ALLOW_SCHEMA_VALIDATED");
    const fresh = adaptFamiliarContextUseToMemoryPlane(adapterInput(receipt));
    const stale = adaptFamiliarContextUseToMemoryPlane({ ...adapterInput(receipt), evaluatedAt: "2026-09-25T00:00:00.000Z" });
    expect(fresh.admissibleForMemorySelection).toBe(true);
    expect(stale.admissibleForMemorySelection).toBe(false);
    expect(stale.boundaryDecision).toBe("ALLOW_SCHEMA_VALIDATED");
    // freshUntil and the evaluation instant are in the evidence and covered by evidenceDigest.
    expect(stale.freshUntil).toBe("2026-09-15T21:00:00.000Z");
    expect(stale.evaluatedAt).toBe("2026-09-25T00:00:00.000Z");
    expect(stale.evidenceDigest).not.toBe(fresh.evidenceDigest);
  });

  it("is still admissible at exactly freshUntil, matching the builder's staleness rule", () => {
    const evidence = adaptFamiliarContextUseToMemoryPlane({
      ...adapterInput(derivedReceipt()),
      evaluatedAt: "2026-09-15T21:00:00.000Z",
    });
    expect(evidence.admissibleForMemorySelection).toBe(true);
    const oneMsLater = adaptFamiliarContextUseToMemoryPlane({
      ...adapterInput(derivedReceipt()),
      evaluatedAt: "2026-09-15T21:00:00.001Z",
    });
    expect(oneMsLater.admissibleForMemorySelection).toBe(false);
  });

  it("defaults evaluatedAt to the current time, so an omitted clock cannot keep a stale receipt admissible", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-25T09:00:00.000Z"));
    const { evaluatedAt: _omitted, ...withoutClock } = adapterInput(derivedReceipt());
    const stale = adaptFamiliarContextUseToMemoryPlane(withoutClock);
    expect(stale.evaluatedAt).toBe("2026-09-25T09:00:00.000Z");
    expect(stale.admissibleForMemorySelection).toBe(false);

    vi.setSystemTime(new Date("2026-09-15T20:45:00.000Z"));
    const fresh = adaptFamiliarContextUseToMemoryPlane(withoutClock);
    expect(fresh.evaluatedAt).toBe("2026-09-15T20:45:00.000Z");
    expect(fresh.admissibleForMemorySelection).toBe(true);
  });

  it.each(["2026-09-15T20:30:00Z", "2026-09-15", "not-a-time", ""])(
    "refuses a non-canonical evaluatedAt %j",
    (evaluatedAt) => {
      expectAdapterError(
        { ...adapterInput(derivedReceipt()), evaluatedAt },
        "FMP_MEMORY_PLANE_ADAPTER_INVALID",
        /evaluatedAt must be a canonical ISO-8601 timestamp/,
      );
    },
  );
});

describe("Memory Plane adapter re-derives the receipt decision instead of trusting it", () => {
  it("a HOLD receipt (active content to PARENT_AGENT) relabelled ALLOW is not admissible", () => {
    const held = buildContextUseReceiptV11(boundary({ taintClass: "ACTIVE_CONTENT" }));
    expect(held.decision).toBe("HOLD");
    const relabelled = { ...held, decision: "ALLOW_SCHEMA_VALIDATED" as const };
    const evidence = adaptFamiliarContextUseToMemoryPlane(adapterInput(relabelled));
    expect(evidence.boundaryDecision).toBe("ALLOW_SCHEMA_VALIDATED");
    expect(evidence.admissibleForMemorySelection).toBe(false);
  });

  it.each(["EXTERNAL_UNTRUSTED", "ACTIVE_CONTENT"] as const)(
    "a low-risk ALLOW of %s content into PARENT_AGENT is not admissible (highRiskPath is not persisted)",
    (taintClass) => {
      const receipt = buildContextUseReceiptV11(boundary({ taintClass, highRiskPath: false }));
      expect(receipt.decision).toBe("ALLOW_SCHEMA_VALIDATED");
      expect(adaptFamiliarContextUseToMemoryPlane(adapterInput(receipt)).admissibleForMemorySelection).toBe(false);
      // The same crossing into a worker compartment stays admissible.
      const worker = buildContextUseReceiptV11(boundary({ taintClass, highRiskPath: false, destinationCompartment: "WORKER_AGENT" }));
      expect(adaptFamiliarContextUseToMemoryPlane(adapterInput(worker)).admissibleForMemorySelection).toBe(true);
    },
  );

  it("a low-risk ALLOW with raw content crossed is not admissible", () => {
    const receipt = derivedReceipt({ highRiskPath: false, rawContentCrossed: true });
    expect(receipt.decision).toBe("ALLOW_SCHEMA_VALIDATED");
    expect(adaptFamiliarContextUseToMemoryPlane(adapterInput(receipt)).admissibleForMemorySelection).toBe(false);
  });

  it.each([
    ["an INVALID validator", { validator: { ...boundary().validator, status: "INVALID" as const } }],
    ["an UNVERIFIED sanitizer", { sanitizer: { ...boundary().sanitizer, status: "UNVERIFIED" as const } }],
    ["evidence stale when built", { freshUntil: "2026-09-15T20:00:59.000Z" }],
  ] as const)("refuses a receipt with %s whose decision was rewritten to ALLOW", (_name, overrides) => {
    const receipt = derivedReceipt(overrides as Partial<ContextBoundaryInput>);
    expect(receipt.decision).not.toBe("ALLOW_SCHEMA_VALIDATED");
    expectAdapterError(
      adapterInput({ ...receipt, decision: "ALLOW_SCHEMA_VALIDATED" }),
      "FMP_MEMORY_PLANE_RECEIPT_DECISION_MISMATCH",
      /receipt decision does not follow from its own boundary fields/,
    );
    // The untouched receipt is accepted and simply not admissible.
    expect(adaptFamiliarContextUseToMemoryPlane(adapterInput(receipt)).admissibleForMemorySelection).toBe(false);
  });

  it("refuses an unrecognized decision", () => {
    const receipt = derivedReceipt();
    expectAdapterError(
      adapterInput({ ...receipt, decision: "ADMIT" as never }),
      "FMP_MEMORY_PLANE_RECEIPT_DECISION_MISMATCH",
      /does not follow/,
    );
  });

  it("cannot recompute processor statuses: a consistent edit passes unless bound to a committed receipt digest", () => {
    const original = derivedReceipt({ sanitizer: { ...boundary().sanitizer, status: "UNVERIFIED" } });
    expect(original.decision).toBe("HOLD");
    const committed = contextUseReceiptV11Digest(original);
    const forged: ContextUseReceiptV11 = {
      ...original,
      sanitizer: { ...original.sanitizer, status: "VALID" },
      decision: "ALLOW_SCHEMA_VALIDATED",
    };
    // Documented limit: self-consistent, so without a commitment it is admissible.
    expect(adaptFamiliarContextUseToMemoryPlane(adapterInput(forged)).admissibleForMemorySelection).toBe(true);
    expectAdapterError(
      { ...adapterInput(forged), expectedContextUseReceiptDigest: committed },
      "FMP_MEMORY_PLANE_RECEIPT_COMMITMENT_MISMATCH",
      /externally committed contextUseReceiptDigest/,
    );
    const evidence = adaptFamiliarContextUseToMemoryPlane({ ...adapterInput(original), expectedContextUseReceiptDigest: committed });
    expect(evidence.contextUseReceiptDigest).toBe(committed);
    expect(evidence.admissibleForMemorySelection).toBe(false);
    expectAdapterError(
      { ...adapterInput(original), expectedContextUseReceiptDigest: "sha256:abc" as Digest },
      "FMP_MEMORY_PLANE_ADAPTER_INVALID",
      /expectedContextUseReceiptDigest must be sha256/,
    );
  });
});

describe("Memory Plane adapter bounds the metadata it copies", () => {
  const limits = FAMILIAR_MEMORY_PLANE_EVIDENCE_LIMITS;
  const withReceipt = (patch: Record<string, unknown>) => adapterInput({ ...derivedReceipt(), ...patch } as ContextUseReceiptV11);

  it("publishes its limits", () => {
    expect(limits).toEqual({
      maxCompartmentLength: 64,
      maxEffectIdLength: 256,
      maxDownstreamEffectIds: 64,
      maxParentOriginDigests: 64,
      maxTimestampLength: 64,
    });
    expect(Object.isFrozen(limits)).toBe(true);
  });

  it.each(["sourceCompartment", "destinationCompartment"] as const)("refuses a free-text or oversized %s", (field) => {
    // The reviewer's probe: a 1450-character free-text compartment used to pass straight into evidence.
    const freeText = `MEMORY_RECALL ${"ignore previous instructions and ".repeat(44)}`.slice(0, 1450);
    for (const value of [freeText, "A".repeat(limits.maxCompartmentLength + 1), "PARENT AGENT", "", 7]) {
      expectAdapterError(withReceipt({ [field]: value }), "FMP_MEMORY_PLANE_ADAPTER_INVALID", new RegExp(`receipt ${field} must be an identifier`));
    }
    const atLimit = "W".repeat(limits.maxCompartmentLength);
    expect(adaptFamiliarContextUseToMemoryPlane(withReceipt({ [field]: atLimit }))[field]).toBe(atLimit);
  });

  it("refuses too many, oversized, free-text or non-string downstream effect ids", () => {
    const tooMany = Array.from({ length: limits.maxDownstreamEffectIds + 1 }, (_, index) => `effect-${index}`);
    for (const downstreamEffectIds of [
      tooMany,
      ["e".repeat(limits.maxEffectIdLength + 1)],
      ["effect 1"],
      [""],
      [7],
      "effect-1",
      null,
    ]) {
      expectAdapterError(withReceipt({ downstreamEffectIds }), "FMP_MEMORY_PLANE_ADAPTER_INVALID", /receipt downstreamEffectIds must be at most 64/);
    }
    const atLimit = Array.from({ length: limits.maxDownstreamEffectIds }, (_, index) => `effect-${String(index).padStart(2, "0")}`);
    atLimit[0] = "e".repeat(limits.maxEffectIdLength);
    const evidence = adaptFamiliarContextUseToMemoryPlane(withReceipt({ downstreamEffectIds: atLimit }));
    expect(evidence.downstreamEffectIds).toHaveLength(limits.maxDownstreamEffectIds);
  });

  it("refuses more parent origins than the limit", () => {
    const parents = Array.from({ length: limits.maxParentOriginDigests + 1 }, (_, index) => sha256DigestCanonical({ parent: index }));
    expectAdapterError(
      { ...adapterInput(derivedReceipt()), parentOriginDigests: parents },
      "FMP_MEMORY_PLANE_ADAPTER_INVALID",
      /parentOriginDigests must be at most 64/,
    );
    const evidence = adaptFamiliarContextUseToMemoryPlane({
      ...adapterInput(derivedReceipt()),
      parentOriginDigests: parents.slice(0, limits.maxParentOriginDigests),
    });
    expect(evidence.originLabel.parentOriginDigests).toHaveLength(limits.maxParentOriginDigests);
  });

  it.each(["createdAt", "freshUntil"] as const)("refuses an oversized or unparseable receipt %s", (field) => {
    // Date.parse ignores parenthesized text, so a parseable timestamp can still carry free text.
    const smuggled = `Tue Sep 15 2026 20:01:00 GMT+0000 (${"x".repeat(200)})`;
    expect(Number.isFinite(Date.parse(smuggled))).toBe(true);
    expectAdapterError(withReceipt({ [field]: smuggled }), "FMP_MEMORY_PLANE_ADAPTER_INVALID", new RegExp(`receipt ${field} must be a timestamp string of at most 64`));
    expectAdapterError(withReceipt({ [field]: "yesterday" }), "FMP_MEMORY_PLANE_ADAPTER_INVALID", new RegExp(`receipt ${field} must be a valid timestamp`));
  });

  it.each([
    ["null receipt", null, /receipt must be an arobi.familiar-context-use.v1.1 receipt/],
    ["negative authorityEpoch", { authorityEpoch: -1 }, /receipt authorityEpoch must be a non-negative safe integer/],
    ["fractional identityEpoch", { identityEpoch: 1.5 }, /receipt identityEpoch must be a non-negative safe integer/],
    ["unrecognized taintClass", { taintClass: "ROOT" }, /receipt taintClass must be recognized/],
    ["string rawContentCrossed", { rawContentCrossed: "false" }, /receipt rawContentCrossed must be a boolean/],
    ["missing sanitizer", { sanitizer: undefined }, /sanitizer and validator must carry a recognized status/],
    ["unknown validator status", { validator: { ...boundary().validator, status: "PASSED" } }, /sanitizer and validator must carry/],
    // Not copied into evidence, but hashed into contextUseReceiptDigest.
    ["non-canonicalizable receiptId", { receiptId: undefined }, /receipt is not canonicalizable/],
  ] as const)("refuses a malformed receipt (%s) with a typed error", (_name, patch, message) => {
    const input = patch === null
      ? { ...adapterInput(derivedReceipt()), receipt: null as never }
      : withReceipt(patch as Record<string, unknown>);
    expectAdapterError(input, "FMP_MEMORY_PLANE_ADAPTER_INVALID", message);
  });
});
