import { describe, expect, it } from "vitest";
import { sha256DigestCanonical } from "./canonicalize.js";
import { buildContextUseReceiptV11, type ContextBoundaryInput } from "./context-boundary.js";
import {
  adaptFamiliarContextUseToMemoryPlane,
  arobiOriginLabelV1Digest,
  familiarTaintCanClaimOrigin,
} from "./memory-plane-adapter.js";
import type { ContextUseReceiptV1 } from "./types.js";

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
  it("MEMORY-ORIGIN-LAUNDER-01 maps derived Familiar context to MODEL_DERIVED", () => {
    const receipt = buildContextUseReceiptV11(boundary({ taintClass: "DERIVED" }));
    const evidence = adaptFamiliarContextUseToMemoryPlane(adapterInput(receipt));
    expect(evidence.originLabel.sourceClass).toBe("MODEL_DERIVED");
    expect(evidence.originLabel.contentActivityClass).toBe("PASSIVE");
    expect(evidence.originLabelDigest).toBe(arobiOriginLabelV1Digest(evidence.originLabel));
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
  });

  it("a trusted caller may explicitly map TRUSTED boundary evidence to an operator origin", () => {
    const receipt = buildContextUseReceiptV11(boundary({ taintClass: "TRUSTED" }));
    const evidence = adaptFamiliarContextUseToMemoryPlane({
      ...adapterInput(receipt),
      trustedSourceClass: "OPERATOR_TRUSTED",
    });
    expect(evidence.originLabel.sourceClass).toBe("OPERATOR_TRUSTED");
  });

  it("monotone trust helper blocks derived/untrusted elevation", () => {
    expect(familiarTaintCanClaimOrigin("DERIVED", "OPERATOR_TRUSTED")).toBe(false);
    expect(familiarTaintCanClaimOrigin("EXTERNAL_UNTRUSTED", "SYSTEM_CANONICAL")).toBe(false);
    expect(familiarTaintCanClaimOrigin("ACTIVE_CONTENT", "TOOL_OBSERVED")).toBe(false);
    expect(familiarTaintCanClaimOrigin("DERIVED", "MODEL_DERIVED")).toBe(true);
  });

  it("adapter evidence carries only digests and bounded metadata, not the crossed raw value", () => {
    const raw = "private-memory-text-that-must-not-be-copied";
    const receipt = buildContextUseReceiptV11(boundary({ crossedValue: raw, taintClass: "DERIVED" }));
    const evidence = adaptFamiliarContextUseToMemoryPlane(adapterInput(receipt));
    expect(JSON.stringify(evidence)).not.toContain(raw);
    expect(evidence.crossedValueDigest).toBe(sha256DigestCanonical(raw));
  });
});
