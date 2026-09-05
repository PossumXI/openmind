import { describe, expect, it } from "vitest";
import {
  FAMILIAR_PROMOTION_COMMIT_COLUMNS,
  FamiliarPromotionCommitStore,
  buildFamiliarMemoryCandidate,
  buildFamiliarPromotionCommit,
  buildFamiliarPromotionPlan,
  sha256DigestCanonical,
  type Digest,
} from "../../src/familiar/index.js";

const D1 = `sha256:${"1".repeat(64)}` as Digest;
const D2 = `sha256:${"2".repeat(64)}` as Digest;
const NOW = "2026-09-04T20:00:00.000Z";

function plan() {
  const candidate = buildFamiliarMemoryCandidate({
    tenantId: "tenant-1",
    familiarId: "familiar-1",
    identityEpoch: 4,
    event: {
      id: "event-1",
      type: "user_message",
      session_id: "session-1",
      timestamp: NOW,
      content: "Remember the bounded preference",
    },
  });
  return buildFamiliarPromotionPlan({
    candidate,
    memoryId: "memory-1",
    memoryClass: "PREFERENCE",
    originLabelDigest: D1,
    actorRef: "principal:operator-1",
    reasonDigest: D2,
    policyEpoch: 3,
    createdAt: NOW,
  });
}

function schemaRows() {
  return FAMILIAR_PROMOTION_COMMIT_COLUMNS.map((column) => ({
    column_name: column.name,
  }));
}

describe("FMP atomic promotion commit store", () => {
  it("persists candidate-memory-mutation authority lineage in one authoritative INSERT", async () => {
    const sql: string[] = [];
    const store = new FamiliarPromotionCommitStore({
      query: async (statement) => {
        sql.push(statement);
        if (statement.includes("information_schema.columns")) return schemaRows();
        return [];
      },
      workspaceId: "workspace-1",
      tablePrefix: "memory",
      writerAgent: "agent:promotion-worker",
      pluginVersion: "test",
    });

    const promotion = plan();
    const persisted = await store.write(promotion);
    const inserts = sql.filter((statement) => /^INSERT INTO /i.test(statement));

    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toContain('"memory_familiar_promotion_commits"');
    expect(inserts[0]).toContain(promotion.candidateDigest);
    expect(inserts[0]).toContain(promotion.memoryDigest);
    expect(inserts[0]).toContain(promotion.mutationDigest);
    expect(persisted.commitId).toBe(`promotion:${promotion.candidate.candidateId}:${promotion.memory.memoryId}`);
    expect(persisted.commitDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("rejects a promotion plan whose declared digest no longer matches its canonical artifact", () => {
    const promotion = plan();
    const tampered = {
      ...promotion,
      memoryDigest: D2,
    };
    expect(() => buildFamiliarPromotionCommit(tampered)).toThrow(/memoryDigest is stale or inconsistent/);
  });

  it("reads only scope-matching commits whose stored commit digest verifies", async () => {
    const promotion = plan();
    const commit = buildFamiliarPromotionCommit(promotion);
    const commitDigest = sha256DigestCanonical(commit);
    let selectCount = 0;
    const store = new FamiliarPromotionCommitStore({
      query: async (statement) => {
        if (statement.includes("information_schema.columns")) return schemaRows();
        if (/^SELECT canonical_json, commit_digest /i.test(statement)) {
          selectCount += 1;
          return [
            { canonical_json: JSON.stringify(commit), commit_digest: commitDigest },
            { canonical_json: JSON.stringify(commit), commit_digest: D1 },
          ];
        }
        return [];
      },
      workspaceId: "workspace-1",
      tablePrefix: "memory",
      writerAgent: "agent:promotion-worker",
      pluginVersion: "test",
    });

    const rows = await store.read({
      tenantId: "tenant-1",
      familiarId: "familiar-1",
      identityEpoch: 4,
    });

    expect(selectCount).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].commitId).toBe(commit.commitId);
  });

  it("does not accept a projection as proof when no authoritative promotion commit row exists", async () => {
    const store = new FamiliarPromotionCommitStore({
      query: async (statement) => {
        if (statement.includes("information_schema.columns")) return schemaRows();
        return [];
      },
      workspaceId: "workspace-1",
      tablePrefix: "memory",
      writerAgent: "agent:promotion-worker",
      pluginVersion: "test",
    });

    await expect(
      store.read({ tenantId: "tenant-1", familiarId: "familiar-1", identityEpoch: 4 }),
    ).resolves.toEqual([]);
  });
});
