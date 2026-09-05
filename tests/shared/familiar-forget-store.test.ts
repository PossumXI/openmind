import { describe, expect, it } from "vitest";
import {
  FAMILIAR_FORGET_COMMIT_COLUMNS,
  FamiliarForgetCommitStore,
  buildFamiliarForgetCommit,
  buildFamiliarMemoryCandidate,
  buildFamiliarPromotionCommit,
  buildFamiliarPromotionPlan,
  finalizeFamiliarForget,
  sha256DigestCanonical,
  type Digest,
} from "../../src/familiar/index.js";

const D1 = `sha256:${"1".repeat(64)}` as Digest;
const D2 = `sha256:${"2".repeat(64)}` as Digest;
const NOW = "2026-09-04T20:00:00.000Z";

function promotionPlan() {
  const candidate = buildFamiliarMemoryCandidate({
    tenantId: "tenant-1",
    familiarId: "familiar-1",
    identityEpoch: 4,
    event: { id: "event-1", type: "user_message", session_id: "session-1", timestamp: NOW, content: "payload" },
  });
  return buildFamiliarPromotionPlan({
    candidate,
    memoryId: "memory-1",
    originLabelDigest: D1,
    actorRef: "principal:operator-1",
    reasonDigest: D2,
    policyEpoch: 3,
    createdAt: NOW,
  });
}

function completeForget(memory: ReturnType<typeof promotionPlan>["memory"]) {
  const finalization = finalizeFamiliarForget({
    memory,
    actorRef: "principal:operator-1",
    reasonDigest: D2,
    policyEpoch: 4,
    surfaces: ["CANONICAL_PAYLOAD", "EMBEDDING_INDEX", "GRAPH_PROJECTION", "SUMMARY_PROJECTION", "LIVE_CACHE"].map((surface) => ({
      surface,
      state: "VERIFIED" as const,
      verificationDigest: sha256DigestCanonical({ surface, state: "ABSENT" }),
      detail: `${surface} absent`,
    })),
    createdAt: NOW,
  });
  if (finalization.state !== "VERIFIED") throw new Error("expected verified forget fixture");
  return finalization;
}

function schemaRows() {
  return FAMILIAR_FORGET_COMMIT_COLUMNS.map((column) => ({ column_name: column.name }));
}

describe("FMP authoritative forget commit ledger", () => {
  it("binds the promotion digest, FORGET mutation, and tombstone in one commit", () => {
    const plan = promotionPlan();
    const promotion = buildFamiliarPromotionCommit(plan);
    const finalization = completeForget(plan.memory);
    const commit = buildFamiliarForgetCommit({ promotion, finalization });

    expect(commit.promotionCommitDigest).toBe(sha256DigestCanonical(promotion));
    expect(commit.memoryDigest).toBe(promotion.memoryDigest);
    expect(commit.mutation.operation).toBe("FORGET");
    expect(commit.tombstone.forgottenDigest).toBe(promotion.memoryDigest);
    expect(commit.tombstone.mutationReceiptDigest).toBe(commit.mutationDigest);
  });

  it("rejects a forget finalization targeting a different memory digest", () => {
    const plan = promotionPlan();
    const promotion = buildFamiliarPromotionCommit(plan);
    const finalization = { ...completeForget(plan.memory), memoryDigest: D1 };
    expect(() => buildFamiliarForgetCommit({ promotion, finalization })).toThrow(/does not target/);
  });

  it("persists one authoritative append row", async () => {
    const statements: string[] = [];
    const store = new FamiliarForgetCommitStore({
      query: async (statement) => {
        statements.push(statement);
        if (statement.includes("information_schema.columns")) return schemaRows();
        return [];
      },
      workspaceId: "workspace-1",
      tablePrefix: "memory",
      writerAgent: "agent:forget-worker",
      pluginVersion: "test",
    });
    const plan = promotionPlan();
    const promotion = buildFamiliarPromotionCommit(plan);
    const persisted = await store.write({ promotion, finalization: completeForget(plan.memory) });
    const inserts = statements.filter((statement) => /^INSERT INTO /i.test(statement));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toContain('"memory_familiar_forget_commits"');
    expect(persisted.forgetCommitId).toBe(`forget:${promotion.commitId}`);
    expect(persisted.forgetCommitDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
