import { describe, expect, it } from "vitest";
import {
  FAMILIAR_PAYLOAD_VAULT_COLUMNS,
  FAMILIAR_PROMOTION_COMMIT_COLUMNS,
  FamiliarPayloadVault,
  FamiliarPromotionCommitStore,
  buildFamiliarMemoryCandidate,
  buildFamiliarPromotionPlan,
  openedCommittedArtifactDigests,
  publishFamiliarPromotion,
  retrieveCommittedFamiliarMemories,
  type Digest,
  type FamiliarRetrievalCandidate,
} from "../../src/familiar/index.js";

const D1 = `sha256:${"1".repeat(64)}` as Digest;
const D2 = `sha256:${"2".repeat(64)}` as Digest;
const KEY = Buffer.alloc(32, 5);
const NOW = "2026-09-04T20:00:00.000Z";
type Row = Record<string, string>;

function plan(id: string, content: string) {
  const candidate = buildFamiliarMemoryCandidate({
    tenantId: "tenant-1",
    familiarId: "familiar-1",
    identityEpoch: 4,
    event: {
      id: `event-${id}`,
      type: "user_message",
      session_id: "session-1",
      timestamp: NOW,
      content,
    },
  });
  return buildFamiliarPromotionPlan({
    candidate,
    memoryId: `memory-${id}`,
    memoryClass: "PREFERENCE",
    originLabelDigest: D1,
    actorRef: "principal:operator-1",
    reasonDigest: D2,
    policyEpoch: 3,
    createdAt: NOW,
  });
}

function splitValues(text: string): string[] {
  const values: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "'") {
      if (quoted && text[index + 1] === "'") {
        current += "'";
        index += 1;
        continue;
      }
      quoted = !quoted;
      continue;
    }
    if (char === "," && !quoted) {
      values.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  values.push(current.trim());
  return values;
}

function database() {
  const tables = new Map<string, Row[]>();
  const query = async (statement: string) => {
    const introspection = statement.match(/WHERE table_name = '([^']+)'/);
    if (statement.includes("information_schema.columns") && introspection) {
      const columns = introspection[1].endsWith("_familiar_payload_vault")
        ? FAMILIAR_PAYLOAD_VAULT_COLUMNS
        : FAMILIAR_PROMOTION_COMMIT_COLUMNS;
      return columns.map((column) => ({ column_name: column.name }));
    }
    const insert = statement.match(/^INSERT INTO "([^"]+)" \((.+)\) VALUES \((.+)\)$/s);
    if (insert) {
      const columns = insert[2].split(",").map((column) => column.trim().replaceAll('"', ""));
      const values = splitValues(insert[3]);
      const row: Row = {};
      columns.forEach((column, index) => { row[column] = values[index] ?? ""; });
      tables.set(insert[1], [...(tables.get(insert[1]) ?? []), row]);
      return [];
    }
    const deletion = statement.match(/^DELETE FROM "([^"]+)" /);
    if (deletion) {
      tables.set(deletion[1], []);
      return [];
    }
    const select = statement.match(/^SELECT .+ FROM "([^"]+)" /s);
    if (select) return [...(tables.get(select[1]) ?? [])];
    return [];
  };
  return { query, tables };
}

function stores(query: (sql: string) => Promise<unknown>) {
  return {
    vault: new FamiliarPayloadVault({
      query,
      workspaceId: "workspace-1",
      tablePrefix: "memory",
      writerAgent: "agent:promotion-worker",
      pluginVersion: "test",
      cipher: { keyId: "test-key", key: KEY },
    }),
    commits: new FamiliarPromotionCommitStore({
      query,
      workspaceId: "workspace-1",
      tablePrefix: "memory",
      writerAgent: "agent:promotion-worker",
      pluginVersion: "test",
    }),
  };
}

const request = {
  tenantId: "tenant-1",
  familiarId: "familiar-1",
  identityEpoch: 4,
  allowedSupportStates: ["ASSERTED"] as const,
  allowedTrustClasses: ["OPERATOR_AUTHORED"] as const,
  allowedMemoryClasses: ["PREFERENCE"] as const,
  now: NOW,
};

describe("FMP committed protected recall", () => {
  it("ranks metadata first and opens plaintext only after committed selection", async () => {
    const db = database();
    const { vault, commits } = stores(db.query);
    const first = plan("1", "first payload");
    const second = plan("2", "second payload");
    await publishFamiliarPromotion({ plan: first, payload: "first payload", vault, commits });
    await publishFamiliarPromotion({ plan: second, payload: "second payload", vault, commits });

    let rankedCandidates: readonly FamiliarRetrievalCandidate[] = [];
    const results = await retrieveCommittedFamiliarMemories({
      commits,
      vault,
      request,
      ranker: (candidates) => {
        rankedCandidates = candidates;
        return [...candidates]
          .reverse()
          .map((candidate, index) => ({ artifactDigest: candidate.artifactDigest, score: 1 - index * 0.1 }));
      },
    });

    expect(rankedCandidates).toHaveLength(2);
    expect(rankedCandidates.every((candidate) => !("payload" in candidate.memory))).toBe(true);
    expect(results).toHaveLength(2);
    expect(results.every((result) => result.payload.state === "AVAILABLE")).toBe(true);
    expect(openedCommittedArtifactDigests(results)).toEqual(results.map((result) => result.artifactDigest));
  });

  it("does not count a tampered/unopenable payload as opened context", async () => {
    const db = database();
    const { vault, commits } = stores(db.query);
    const one = plan("1", "first payload");
    await publishFamiliarPromotion({ plan: one, payload: "first payload", vault, commits });

    const row = db.tables.get("memory_familiar_payload_vault")?.[0];
    if (!row) throw new Error("expected protected payload row");
    row.auth_tag_b64 = Buffer.alloc(16, 8).toString("base64");

    const results = await retrieveCommittedFamiliarMemories({ commits, vault, request });
    expect(results).toHaveLength(1);
    expect(results[0].payload.state).toBe("INCONCLUSIVE");
    expect(openedCommittedArtifactDigests(results)).toEqual([]);
  });
});
