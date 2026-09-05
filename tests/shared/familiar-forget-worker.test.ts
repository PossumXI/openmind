import { describe, expect, it } from "vitest";
import type { QueryFn } from "../../src/deeplake-schema.js";
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
import { FAMILIAR_FORGET_HOLD_DESCRIPTION } from "../../src/hooks/upload-summary.js";

const D1 = `sha256:${"1".repeat(64)}` as Digest;
const D2 = `sha256:${"2".repeat(64)}` as Digest;
const NOW = "2026-09-04T20:00:00.000Z";
const KEY = Buffer.alloc(32, 3);
type Row = Record<string, unknown>;

function sourceEvent() {
  return {
    id: "source-event-1",
    type: "user_message" as const,
    session_id: "source-session-1",
    timestamp: NOW,
    content: "forgettable familiar payload",
  };
}

function plan() {
  const candidate = buildFamiliarMemoryCandidate({
    tenantId: "tenant-1",
    familiarId: "familiar-1",
    identityEpoch: 4,
    event: sourceEvent(),
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
  const sessionRows: Row[] = [{
    id: "source-event-1",
    message: sourceEvent(),
    message_embedding: [0.1, 0.2],
    author: "operator",
    project: "project-1",
    path: "/sessions/operator/source-session-1.jsonl",
    creation_date: NOW,
  }];
  const memoryRows: Row[] = [{
    path: "/summaries/operator/source-session-1.md",
    summary: "old derived summary containing forgettable familiar payload",
    summary_embedding: [0.3, 0.4],
    description: "completed summary",
  }];

  const query: QueryFn = async (statement: string) => {
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

    if (statement.startsWith('SELECT id, message, message_embedding, author, project, path, creation_date FROM "sessions"')) {
      return [...sessionRows];
    }
    if (statement.startsWith('UPDATE "sessions" SET message = ')) {
      const match = statement.match(/SET message = '(.+)'::jsonb, message_embedding = NULL,/s);
      if (!match) throw new Error(`could not parse source tombstone SQL: ${statement}`);
      const message = JSON.parse(match[1].replace(/''/g, "'"));
      const row = sessionRows.find((candidate) => candidate.id === "source-event-1");
      if (row) {
        row.message = message;
        row.message_embedding = null;
      }
      return [];
    }
    if (statement.startsWith('SELECT id, message, message_embedding, author, project FROM "sessions"')) {
      return [...sessionRows];
    }

    if (statement.startsWith('UPDATE "memory" SET summary = \'\'')) {
      for (const row of memoryRows) {
        row.summary = "";
        row.summary_embedding = null;
        row.description = FAMILIAR_FORGET_HOLD_DESCRIPTION;
      }
      return [];
    }
    if (statement.startsWith('SELECT path, summary, summary_embedding, description FROM "memory"')) {
      return [...memoryRows];
    }
    if (statement.startsWith('INSERT INTO "memory"')) {
      if (memoryRows.length === 0) {
        memoryRows.push({
          path: "/summaries/operator/source-session-1.md",
          summary: "",
          summary_embedding: null,
          description: FAMILIAR_FORGET_HOLD_DESCRIPTION,
        });
      }
      return [];
    }

    return [];
  };
  return { query, vaultRows, sessionRows, memoryRows };
}

function verifiedGraph() {
  return {
    erase: async () => ({
      surface: "GRAPH_PROJECTION" as const,
      state: "VERIFIED" as const,
      verificationDigest: sha256DigestCanonical({ surface: "GRAPH_PROJECTION", state: "ABSENT" }),
      detail: "graph fixture verified absent",
    }),
  };
}

function vault(query: QueryFn) {
  return new FamiliarPayloadVault({
    query,
    workspaceId: "workspace-1",
    tablePrefix: "memory",
    writerAgent: "agent:forget-worker",
    pluginVersion: "test",
    cipher: { keyId: "test-key", key: KEY },
  });
}

describe("FMP controlled forgetting worker", () => {
  it("stays INCOMPLETE when graph erasure is not executable while closing source/summary surfaces", async () => {
    const db = database();
    const protectedVault = vault(db.query);
    const promotion = plan();
    const commit = buildFamiliarPromotionCommit(promotion);
    await protectedVault.stage(commit, "forgettable familiar payload");

    const result = await runControlledFamiliarForget({
      commit,
      vault: protectedVault,
      query: db.query,
      sessionsTableName: "sessions",
      memoryTableName: "memory",
      actorRef: "principal:operator-1",
      reasonDigest: D2,
      policyEpoch: 5,
      createdAt: NOW,
    });

    expect(result.finalization.state).toBe("INCOMPLETE");
    expect(result.surfaces.find((surface) => surface.surface === "CANONICAL_PAYLOAD")?.state).toBe("VERIFIED");
    expect(result.surfaces.find((surface) => surface.surface === "EMBEDDING_INDEX")?.state).toBe("VERIFIED");
    expect(result.surfaces.find((surface) => surface.surface === "GRAPH_PROJECTION")?.state).toBe("FAILED");
    expect(result.surfaces.find((surface) => surface.surface === "SUMMARY_PROJECTION")?.state).toBe("VERIFIED");
    expect(db.sessionRows[0].message_embedding).toBeNull();
    expect((db.sessionRows[0].message as Row).type).toBe("familiar_memory_forgotten_source");
    expect(db.memoryRows[0]).toMatchObject({
      summary: "",
      summary_embedding: null,
      description: FAMILIAR_FORGET_HOLD_DESCRIPTION,
    });
  });

  it("produces a verified FORGET mutation/tombstone only after every controlled surface verifies", async () => {
    const db = database();
    const protectedVault = vault(db.query);
    const promotion = plan();
    const commit = buildFamiliarPromotionCommit(promotion);
    await protectedVault.stage(commit, "forgettable familiar payload");

    const result = await runControlledFamiliarForget({
      commit,
      vault: protectedVault,
      query: db.query,
      sessionsTableName: "sessions",
      memoryTableName: "memory",
      actorRef: "principal:operator-1",
      reasonDigest: D2,
      policyEpoch: 5,
      graphProjection: verifiedGraph(),
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
    expect((db.sessionRows[0].message as Row).original_event_digest).toBe(commit.sourceEventDigest);
    expect(db.memoryRows[0].description).toBe(FAMILIAR_FORGET_HOLD_DESCRIPTION);
  });

  it("can retry after a downstream graph failure without needing forgotten plaintext back", async () => {
    const db = database();
    const protectedVault = vault(db.query);
    const promotion = plan();
    const commit = buildFamiliarPromotionCommit(promotion);
    await protectedVault.stage(commit, "forgettable familiar payload");

    const first = await runControlledFamiliarForget({
      commit,
      vault: protectedVault,
      query: db.query,
      sessionsTableName: "sessions",
      memoryTableName: "memory",
      actorRef: "principal:operator-1",
      reasonDigest: D2,
      policyEpoch: 5,
      createdAt: NOW,
    });
    expect(first.finalization.state).toBe("INCOMPLETE");

    const second = await runControlledFamiliarForget({
      commit,
      vault: protectedVault,
      query: db.query,
      sessionsTableName: "sessions",
      memoryTableName: "memory",
      actorRef: "principal:operator-1",
      reasonDigest: D2,
      policyEpoch: 5,
      graphProjection: verifiedGraph(),
      createdAt: NOW,
    });

    expect(second.finalization.state).toBe("VERIFIED");
    expect((db.sessionRows[0].message as Row).type).toBe("familiar_memory_forgotten_source");
    expect((db.sessionRows[0].message as Row).original_event_digest).toBe(commit.sourceEventDigest);
  });
});
