import { describe, expect, it } from "vitest";
import {
  FAMILIAR_PAYLOAD_VAULT_COLUMNS,
  FAMILIAR_PROMOTION_COMMIT_COLUMNS,
  FamiliarPayloadVault,
  FamiliarPromotionCommitStore,
  buildFamiliarMemoryCandidate,
  buildFamiliarPromotionCommit,
  buildFamiliarPromotionPlan,
  publishFamiliarPromotion,
  type Digest,
} from "../../src/familiar/index.js";

const D1 = `sha256:${"1".repeat(64)}` as Digest;
const D2 = `sha256:${"2".repeat(64)}` as Digest;
const NOW = "2026-09-04T20:00:00.000Z";
const KEY = Buffer.alloc(32, 7);

type Row = Record<string, string>;

function promotion(payload: unknown = "Remember the bounded preference") {
  const candidate = buildFamiliarMemoryCandidate({
    tenantId: "tenant-1",
    familiarId: "familiar-1",
    identityEpoch: 4,
    event: {
      id: "event-1",
      type: "user_message",
      session_id: "session-1",
      timestamp: NOW,
      content: payload,
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

function columnRows(table: string) {
  const columns = table.endsWith("_familiar_payload_vault")
    ? FAMILIAR_PAYLOAD_VAULT_COLUMNS
    : FAMILIAR_PROMOTION_COMMIT_COLUMNS;
  return columns.map((column) => ({ column_name: column.name }));
}

function splitSqlValues(text: string): string[] {
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

function parseInsert(statement: string): { table: string; row: Row } | undefined {
  const match = statement.match(/^INSERT INTO "([^"]+)" \((.+)\) VALUES \((.+)\)$/s);
  if (!match) return undefined;
  const [, table, rawColumns, rawValues] = match;
  const columns = rawColumns.split(",").map((column) => column.trim().replaceAll('"', ""));
  const values = splitSqlValues(rawValues);
  const row: Row = {};
  columns.forEach((column, index) => {
    row[column] = values[index] ?? "";
  });
  return { table, row };
}

function memoryQuery(options: { failPromotionInsert?: boolean } = {}) {
  const tables = new Map<string, Row[]>();
  const sql: string[] = [];

  const query = async (statement: string) => {
    sql.push(statement);
    const introspection = statement.match(/WHERE table_name = '([^']+)'/);
    if (statement.includes("information_schema.columns") && introspection) {
      return columnRows(introspection[1]);
    }
    const insert = parseInsert(statement);
    if (insert) {
      if (options.failPromotionInsert && insert.table.endsWith("_familiar_promotion_commits")) {
        throw new Error("simulated promotion commit failure");
      }
      const rows = tables.get(insert.table) ?? [];
      rows.push(insert.row);
      tables.set(insert.table, rows);
      return [];
    }
    const deletion = statement.match(/^DELETE FROM "([^"]+)" /);
    if (deletion) {
      tables.set(deletion[1], []);
      return [];
    }
    const select = statement.match(/^SELECT .+ FROM "([^"]+)" /s);
    if (select) {
      return [...(tables.get(select[1]) ?? [])];
    }
    return [];
  };

  return { query, tables, sql };
}

function stores(query: (statement: string) => Promise<unknown>) {
  return {
    vault: new FamiliarPayloadVault({
      query,
      workspaceId: "workspace-1",
      tablePrefix: "memory",
      writerAgent: "agent:promotion-worker",
      pluginVersion: "test",
      cipher: { keyId: "test-key-1", key: KEY },
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

describe("FMP protected payload vault", () => {
  it("stages ciphertext only when the payload digest matches the promoted candidate", async () => {
    const db = memoryQuery();
    const { vault } = stores(db.query);
    const plan = promotion();
    const commit = buildFamiliarPromotionCommit(plan);

    await expect(vault.stage(commit, "different payload")).rejects.toThrow(/content does not match/);
    expect(db.sql.some((statement) => /^INSERT INTO /i.test(statement))).toBe(false);
  });

  it("decrypts an authenticated staged payload only for the matching promotion commit", async () => {
    const db = memoryQuery();
    const { vault } = stores(db.query);
    const plan = promotion();
    const commit = buildFamiliarPromotionCommit(plan);

    await vault.stage(commit, "Remember the bounded preference");
    const opened = await vault.open(commit);

    expect(opened.state).toBe("AVAILABLE");
    if (opened.state === "AVAILABLE") {
      expect(opened.payload).toBe("Remember the bounded preference");
      expect(opened.contentDigest).toBe(plan.memory.contentDigest);
    }
    const stored = db.tables.get("memory_familiar_payload_vault")?.[0];
    expect(stored?.ciphertext_b64).toBeTruthy();
    expect(stored?.ciphertext_b64).not.toContain("Remember");
  });

  it("returns INCONCLUSIVE when authenticated ciphertext is tampered", async () => {
    const db = memoryQuery();
    const { vault } = stores(db.query);
    const plan = promotion();
    const commit = buildFamiliarPromotionCommit(plan);
    await vault.stage(commit, "Remember the bounded preference");

    const row = db.tables.get("memory_familiar_payload_vault")?.[0];
    if (!row) throw new Error("expected staged payload row");
    row.auth_tag_b64 = Buffer.alloc(16, 9).toString("base64");

    const opened = await vault.open(commit);
    expect(opened.state).toBe("INCONCLUSIVE");
  });

  it("verifies live canonical payload absence after scoped deletion", async () => {
    const db = memoryQuery();
    const { vault } = stores(db.query);
    const plan = promotion();
    const commit = buildFamiliarPromotionCommit(plan);
    await vault.stage(commit, "Remember the bounded preference");

    const result = await vault.erase(commit);

    expect(result.state).toBe("VERIFIED");
    expect(result.verificationDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(db.tables.get("memory_familiar_payload_vault")).toEqual([]);
  });

  it("publishes the authoritative promotion only after payload staging succeeds", async () => {
    const db = memoryQuery();
    const { vault, commits } = stores(db.query);
    const plan = promotion();

    const published = await publishFamiliarPromotion({
      plan,
      payload: "Remember the bounded preference",
      vault,
      commits,
    });

    expect(published.commitId).toBe(`promotion:${plan.candidate.candidateId}:${plan.memory.memoryId}`);
    expect(db.tables.get("memory_familiar_payload_vault")).toHaveLength(1);
    expect(db.tables.get("memory_familiar_promotion_commits")).toHaveLength(1);
    const firstPayloadInsert = db.sql.findIndex((statement) => statement.includes("_familiar_payload_vault") && /^INSERT/i.test(statement));
    const firstCommitInsert = db.sql.findIndex((statement) => statement.includes("_familiar_promotion_commits") && /^INSERT/i.test(statement));
    expect(firstPayloadInsert).toBeGreaterThanOrEqual(0);
    expect(firstCommitInsert).toBeGreaterThan(firstPayloadInsert);
  });

  it("best-effort removes a staged orphan when the authoritative commit fails", async () => {
    const db = memoryQuery({ failPromotionInsert: true });
    const { vault, commits } = stores(db.query);
    const plan = promotion();

    await expect(
      publishFamiliarPromotion({
        plan,
        payload: "Remember the bounded preference",
        vault,
        commits,
      }),
    ).rejects.toThrow(/simulated promotion commit failure/);

    expect(db.tables.get("memory_familiar_payload_vault")).toEqual([]);
    expect(db.tables.get("memory_familiar_promotion_commits") ?? []).toHaveLength(0);
  });
});
