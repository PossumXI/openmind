import { describe, expect, it } from "vitest";
import { sha256DigestCanonical } from "./canonicalize.js";
import { buildContextUseReceiptV11 } from "./context-boundary.js";
import { assertContextInfluenceEdgeV1, buildContextInfluenceEdge } from "./context-influence.js";
import type { ContextUseReceiptV1 } from "./types.js";

const parentReceipt: ContextUseReceiptV1 = {
  kind: "arobi.familiar-context-use",
  version: 1,
  receiptId: "parent",
  familiarId: "familiar-1",
  tenantId: "tenant-a",
  identityEpoch: 7,
  purposeDigest: sha256DigestCanonical({ purpose: "governed-planning" }),
  retrieved: [],
  opened: [],
  reliedUpon: [],
  rejectedOrConflicting: [],
  proposalDigest: sha256DigestCanonical({ proposal: "effect-42" }),
  familiarContinuityDigest: sha256DigestCanonical({ continuity: 7 }),
  createdAt: "2026-09-08T20:00:00.000Z",
};

function allowedReceipt() {
  return buildContextUseReceiptV11({
    parentReceipt,
    authorityEpoch: 8,
    sourceCompartment: "MEMORY_RECALL",
    destinationCompartment: "PARENT_AGENT",
    allowedDerivationCompartments: ["WORKER_AGENT"],
    rawContentCrossed: false,
    sanitizer: { identity: "sanitizer", version: "1", status: "VALID" },
    validator: {
      identity: "schema-validator",
      version: "1",
      status: "VALID",
      schemaDigest: sha256DigestCanonical({ schema: "target-selection-v1" }),
    },
    taintClass: "DERIVED",
    crossedValue: { targetId: "warehouse-zone-b" },
    freshUntil: "2026-09-08T21:00:00.000Z",
    downstreamEffectIds: ["effect-42"],
    highRiskPath: true,
    receiptId: "context-use-v11",
    createdAt: "2026-09-08T20:01:00.000Z",
  });
}

describe("ContextInfluenceEdge v1", () => {
  it("CONTEXT-INFLUENCE-01 records an observable target-selection edge", () => {
    const edge = buildContextInfluenceEdge({
      contextReceipt: allowedReceipt(),
      downstreamEffectId: "effect-42",
      influenceType: "TARGET_SELECTION",
      derivedValue: { targetId: "warehouse-zone-b" },
      decisionNode: { selectedTargetId: "warehouse-zone-b", selectorVersion: "v1" },
      createdAt: "2026-09-08T20:02:00.000Z",
    });

    expect(() => assertContextInfluenceEdgeV1(edge)).not.toThrow();
    expect(edge.derivedValueDigest).toBe(sha256DigestCanonical({ targetId: "warehouse-zone-b" }));
    const encoded = JSON.stringify(edge);
    expect(encoded).not.toContain("warehouse-zone-b");
    expect(encoded).not.toMatch(/chain.of.thought|reasoning|rawContent/i);
  });

  it("CONTEXT-NO-INFLUENCE-01 records absence of material influence without a derived-value claim", () => {
    const edge = buildContextInfluenceEdge({
      contextReceipt: allowedReceipt(),
      downstreamEffectId: "effect-43",
      influenceType: "NO_MATERIAL_INFLUENCE",
      decisionNode: { decision: "unchanged" },
      createdAt: "2026-09-08T20:03:00.000Z",
    });
    expect(edge.derivedValueDigest).toBeUndefined();
    expect(() => assertContextInfluenceEdgeV1(edge)).not.toThrow();
  });

  it("refuses to manufacture influence from a held/rejected context crossing", () => {
    const held = buildContextUseReceiptV11({
      parentReceipt,
      authorityEpoch: 8,
      sourceCompartment: "EXTERNAL_INPUT",
      destinationCompartment: "PARENT_AGENT",
      rawContentCrossed: true,
      sanitizer: { identity: "sanitizer", version: "1", status: "VALID" },
      validator: {
        identity: "schema-validator",
        version: "1",
        status: "VALID",
        schemaDigest: sha256DigestCanonical({ schema: "safe" }),
      },
      taintClass: "ACTIVE_CONTENT",
      crossedValue: "malicious raw instruction",
      freshUntil: "2026-09-08T21:00:00.000Z",
      highRiskPath: true,
      createdAt: "2026-09-08T20:01:00.000Z",
    });

    expect(() => buildContextInfluenceEdge({
      contextReceipt: held,
      downstreamEffectId: "effect-44",
      influenceType: "TOOL_SELECTION",
      derivedValue: { tool: "shell" },
      decisionNode: { selectedTool: "shell" },
    })).toThrow(/allowed context-use receipt/);
  });
});
