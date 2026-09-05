import { describe, expect, it } from "vitest";
import {
  FAMILIAR_PAYLOAD_VAULT_COLUMNS,
  FamiliarPayloadVault,
  buildFamiliarMemoryCandidate,
  buildFamiliarPromotionCommit,
  buildFamiliarPromotionPlan,
  runControlledFamiliarForget,
  sha256DigestCanonical,
  type Digest,
} from "../../src/familiar/index.js";

const D1 = `sha256:${"1".repeat(64)}` as Digest;
const D2 = `sha256:${"2".repeat(64)}` as Digest;
const NOW = "2026-09-04T20:00:00.000Z";
const KEY = Buffer.alloc(32, 3);
type Row = Record<string, unknown>;

function plan() {
  const candidate = buildFamiliarMemoryCandidate({
    tenantId: "tenant-1",
    familiarId: "familiar-1",
    identityEpoch: 4,
    event: {
      id: "source-event-1",
      type: "user_message",
      session_id: "source-session-1",
      timestamp: NOW,
      content: "forgettable familiar payload",
    },
  });
  return buildFamiliarPromotionPlan({
    candidate,
    memoryId: "memory-1",
    originLabelDigest: D1,
    actorRef: "principal:operator-1",
    reasonDigest: D2,
    policyEpoch: 4,
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
  const vaultRows: Row[] = [];
  const sessionRows: Row[] = [{ id: "source-event-1", message_embedding: [0.1, 0.2] }];
  const query = async (statement: string) => {
    if (statement.includes("information_schema.columns")) {
      return FAMILIAR_PAYLOAD_VAULT_COLUMNS.map((column) => ({ column_name: column.name }));
    }
    const insert = statement.match(/^INSERT INTO "([^"]+)" \((.+)\) VALUES \((.+)\)$/s);
    if (insert && insert[1].endsWith("_familiar_payload_vault")) {
      const columns = insert[2].split(",").map((column) => column.trim().replaceAll('"', ""));
      const values = splitValues(insert[3]);
      const row: Row = {};
      columns.forEach((column, index) => { row[column] = values[index] ?? ""; });
      vaultRows.push(row);
      return [];
    }
    if (statement.startsWith('DELETE FROM "memory_familiar_payload_vault"')) {
      vaultRows.splice(0, vaultRows.length);
      return [];
    }
    if (statement.startsWith('SELECT payload_id FROM "memory_familiar_payload_vault"')) {
      return [...vaultRows];
    }
    if (statement.startsWith('UPDATE "sessions" SET message_embedding = NULL')) {
      const row = sessionRows.find((candidate) => candidate.id === "source-event-1");
      if (row) row.message_embedding = null;
      return [];
    }
    if (statement.startsWith('SELECT id, message_embedding FROM "sessions"')) {
      return [...sessionRows];
    }
    return [];
  };
  return { query, vaultRows, sessionRows };
}

function verifiedProjection(surface: "GRAPH_PROJECTION" | "SUMMARY_PROJECTION") {
  return {
    erase: async () => ({
      surface,
      state: "VERIFIED" as const,
      verificationDigest: sha256DigestCanonical({ surface, state: "ABSENT" }),
      detail: `${surface} fixture verified absent`,
    }),
  };
}

describe("FMP controlled forgetting worker", () => {
  it("stays INCOMPLETE when derived graph/summary erasure is not executable", async () => {
    const db = database();
    const vault = new FamiliarPayloadVault({
      query: db.query,
      workspaceId: "workspace-1",
      tablePrefix: "memory",
      writerAgent: "agent:forget-worker",
      pluginVersion: "test",
      cipher: { keyId: "test-key", key: KEY },
    });
    const promotion = plan();
    const commit = buildFamiliarPromotionCommit(promotion);
    await vault.stage(commit, "forgettable familiar payload");

    const result = await runControlledFamiliarForget({
      commit,
      vault,
      query: db.query,
      sessionsTableName: "sessions",
      actorRef: "principal:operator-1",
      reasonDigest: D2,
      policyEpoch: 5,
      createdAt: NOW,
    });

    expect(result.finalization.state).toBe("INCOMPLETE");
    expect(result.surfaces.find((surface) => surface.surface === "CANONICAL_PAYLOAD")?.state).toBe("VERIFIED");
    expect(result.surfaces.find((surface) => surface.surface === "EMBEDDING_INDEX")?.state).toBe("VERIFIED");
    expect(result.surfaces.find((surface) => surface.surface === "GRAPH_PROJECTION")?.state).toBe("FAILED");
    expect(result.surfaces.find((surface) => surface.surface === "SUMMARY_PROJECTION")?.state).toBe("FAILED");
  });

  it("produces a verified FORGET mutation/tombstone only after every controlled surface verifies", async () => {
    const db = database();
    const vault = new FamiliarPayloadVault({
      query: db.query,
      workspaceId: "workspace-1",
      tablePrefix: "memory",
      writerAgent: "agent:forget-worker",
      pluginVersion: "test",
      cipher: { keyId: "test-key", key: KEY },
    });
    const promotion = plan();
    const commit = buildFamiliarPromotionCommit(promotion);
    await vault.stage(commit, "forgettable familiar payload");

    const result = await runControlledFamiliarForget({
      commit,
      vault,
      query: db.query,
      sessionsTableName: "sessions",
      actorRef: "principal:operator-1",
      reasonDigest: D2,
      policyEpoch: 5,
      graphProjection: verifiedProjection("GRAPH_PROJECTION"),
      summaryProjection: verifiedProjection("SUMMARY_PROJECTION"),
      createdAt: NOW,
    });

    expect(result.finalization.state).toBe("VERIFIED");
    if (result.finalization.state === "VERIFIED") {
      expect(result.finalization.mutation.operation).toBe("FORGET");
      expect(result.finalization.tombstone.forgottenDigest).toBe(result.finalization.memoryDigest);
      expect(result.finalization.tombstone.surfaces.every((surface) => surface.state !== "FAILED")).toBe(true);
    }
    expect(db.vaultRows).toEqual([]);
    expect(db.sessionRows[0].message_embedding).toBeNull();
  });
});
