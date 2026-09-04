import { describe, expect, it } from "vitest";
import {
  buildContextUseReceipt,
  buildFamiliarMemoryCandidate,
  type Digest,
} from "../../src/familiar/index.js";

const D1 = `sha256:${"1".repeat(64)}` as Digest;
const D2 = `sha256:${"2".repeat(64)}` as Digest;
const D3 = `sha256:${"3".repeat(64)}` as Digest;
const D4 = `sha256:${"4".repeat(64)}` as Digest;
const NOW = "2026-09-04T12:00:00.000Z";

describe("FMP captured-event candidates", () => {
  it("keeps operator-authored session content as a candidate instead of auto-promoting it", () => {
    const candidate = buildFamiliarMemoryCandidate({
      tenantId: "tenant-1",
      familiarId: "familiar-1",
      identityEpoch: 3,
      event: {
        id: "event-1",
        type: "user_message",
        session_id: "session-1",
        timestamp: NOW,
        content: "Remember that I prefer compact status reports",
      },
    });

    expect(candidate.trustClass).toBe("OPERATOR_AUTHORED");
    expect(candidate.proposedClass).toBe("EPISODIC");
    expect(candidate.promotionState).toBe("CANDIDATE");
    expect(candidate.mayAuthorize).toBe(false);
    expect(candidate.originDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("marks assistant content as derived and tool observations as observed", () => {
    expect(buildFamiliarMemoryCandidate({
      tenantId: "tenant-1",
      familiarId: "familiar-1",
      identityEpoch: 1,
      event: { id: "a", type: "assistant_message", timestamp: NOW, content: "summary" },
    }).trustClass).toBe("DERIVED");

    expect(buildFamiliarMemoryCandidate({
      tenantId: "tenant-1",
      familiarId: "familiar-1",
      identityEpoch: 1,
      event: { id: "t", type: "tool_call", timestamp: NOW, tool_name: "search", tool_response: "result" },
    }).trustClass).toBe("OBSERVED");
  });
});

describe("FMP consequential context-use receipts", () => {
  it("records exact retrieved/opened/relied/rejected lineage", () => {
    const receipt = buildContextUseReceipt({
      tenantId: "tenant-1",
      familiarId: "familiar-1",
      identityEpoch: 3,
      purpose: { action: "deployment-proposal" },
      retrieved: [D1, D2, D3],
      opened: [D1, D2],
      reliedUpon: [D1],
      rejectedOrConflicting: [D2],
      proposal: { action: "deploy", target: "bounded-test" },
      familiarContinuityDigest: D4,
      receiptId: "receipt-1",
      createdAt: NOW,
    });

    expect(receipt.retrieved).toEqual([D1, D2, D3]);
    expect(receipt.opened).toEqual([D1, D2]);
    expect(receipt.reliedUpon).toEqual([D1]);
    expect(receipt.rejectedOrConflicting).toEqual([D2]);
  });

  it("rejects claimed reliance on a memory that was not opened", () => {
    expect(() => buildContextUseReceipt({
      tenantId: "tenant-1",
      familiarId: "familiar-1",
      identityEpoch: 3,
      purpose: "test",
      retrieved: [D1, D2],
      opened: [D1],
      reliedUpon: [D2],
      proposal: "proposal",
      familiarContinuityDigest: D4,
      receiptId: "receipt-bad",
      createdAt: NOW,
    })).toThrow(/reliedUpon memories must be a subset of opened memories/);
  });
});
