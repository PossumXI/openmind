import { describe, expect, it } from "vitest";
import {
  FAMILIAR_CONTEXT_USE_COLUMNS,
  FAMILIAR_CONTINUITY_COLUMNS,
  FAMILIAR_MANIFEST_COLUMNS,
  FAMILIAR_MEMORY_COLUMNS,
  FAMILIAR_MUTATION_COLUMNS,
  FAMILIAR_TOMBSTONE_COLUMNS,
  FamiliarPersistence,
  familiarTableNames,
  type FamiliarMemoryArtifactV1,
} from "../../src/familiar/index.js";

const D1 = `sha256:${"1".repeat(64)}` as const;
const D2 = `sha256:${"2".repeat(64)}` as const;
const D3 = `sha256:${"3".repeat(64)}` as const;
const NOW = "2026-09-04T12:00:00.000Z";

function memory(overrides: Partial<FamiliarMemoryArtifactV1> = {}): FamiliarMemoryArtifactV1 {
  return {
    kind: "arobi.familiar-memory",
    version: 1,
    memoryId: "memory-1",
    familiarId: "familiar-1",
    tenantId: "tenant-1",
    identityEpoch: 1,
    memoryClass: "PREFERENCE",
    contentDigest: D1,
    originLabelDigest: D2,
    sourceArtifacts: [D3],
    transformationChain: [],
    trustClass: "OPERATOR_AUTHORED",
    supportState: "CORROBORATED",
    mayInform: true,
    mayAuthorize: false,
    revision: 1,
    createdAt: NOW,
    ...overrides,
  };
}

const columnsBySuffix = new Map<string, readonly { name: string }[]>([
  ["familiar_manifests", FAMILIAR_MANIFEST_COLUMNS],
  ["familiar_memories", FAMILIAR_MEMORY_COLUMNS],
  ["familiar_mutations", FAMILIAR_MUTATION_COLUMNS],
  ["familiar_context_use", FAMILIAR_CONTEXT_USE_COLUMNS],
  ["familiar_continuity", FAMILIAR_CONTINUITY_COLUMNS],
  ["familiar_tombstones", FAMILIAR_TOMBSTONE_COLUMNS],
]);

function schemaRowsForIntrospection(sql: string): Array<{ column_name: string }> {
  for (const [suffix, columns] of columnsBySuffix) {
    if (sql.includes(suffix)) return columns.map((column) => ({ column_name: column.name }));
  }
  return [];
}

describe("FMP persistence", () => {
  it("creates additive table names without colliding with legacy memory/session tables", () => {
    expect(familiarTableNames("memory")).toEqual({
      manifests: "memory_familiar_manifests",
      memories: "memory_familiar_memories",
      mutations: "memory_familiar_mutations",
      contextUse: "memory_familiar_context_use",
      continuity: "memory_familiar_continuity",
      tombstones: "memory_familiar_tombstones",
    });
  });

  it("persists memory metadata with may_authorize fixed to zero", async () => {
    const statements: string[] = [];
    const query = async (sql: string): Promise<unknown> => {
      statements.push(sql);
      if (sql.includes("information_schema.columns")) return schemaRowsForIntrospection(sql);
      return [];
    };
    const store = new FamiliarPersistence({
      query,
      workspaceId: "workspace-1",
      tablePrefix: "memory",
      writerAgent: "test-agent",
      pluginVersion: "test-version",
    });

    const persisted = await store.writeMemory(memory());
    expect(persisted.digest).toMatch(/^sha256:[0-9a-f]{64}$/);

    const insert = statements.find((statement) => statement.startsWith("INSERT INTO \"memory_familiar_memories\""));
    expect(insert).toBeDefined();
    expect(insert).toContain("may_authorize");
    expect(insert).toMatch(/may_authorize[^)]*\)[\s\S]*VALUES \([^)]*0/);
    expect(insert).toContain("tenant-1");
    expect(insert).toContain("familiar-1");
  });

  it("rejects an authority-bearing memory before any persistence I/O", async () => {
    const statements: string[] = [];
    const store = new FamiliarPersistence({
      query: async (sql) => {
        statements.push(sql);
        return [];
      },
      workspaceId: "workspace-1",
      tablePrefix: "memory",
      writerAgent: "test-agent",
      pluginVersion: "test-version",
    });

    const invalid = { ...memory(), mayAuthorize: true };
    await expect(store.writeMemory(invalid)).rejects.toMatchObject({
      code: "FMP_MEMORY_CANNOT_AUTHORIZE",
    });
    expect(statements).toEqual([]);
  });

  it("scopes canonical reads in SQL before parsing and returns only latest current revisions", async () => {
    const statements: string[] = [];
    const current = memory({ revision: 2, contentDigest: D2 });
    const superseded = memory({ revision: 1, supportState: "SUPERSEDED" });
    const other = memory({ memoryId: "memory-2", revision: 1, contentDigest: D3 });

    const query = async (sql: string): Promise<unknown> => {
      statements.push(sql);
      if (sql.includes("information_schema.columns")) return schemaRowsForIntrospection(sql);
      if (sql.startsWith("SELECT memory_id")) {
        return [
          {
            memory_id: current.memoryId,
            revision: current.revision,
            support_state: current.supportState,
            canonical_json: JSON.stringify(current),
          },
          {
            memory_id: superseded.memoryId,
            revision: superseded.revision,
            support_state: superseded.supportState,
            canonical_json: JSON.stringify(superseded),
          },
          {
            memory_id: other.memoryId,
            revision: other.revision,
            support_state: other.supportState,
            canonical_json: JSON.stringify(other),
          },
        ];
      }
      return [];
    };

    const store = new FamiliarPersistence({
      query,
      workspaceId: "workspace-1",
      tablePrefix: "memory",
      writerAgent: "test-agent",
      pluginVersion: "test-version",
    });
    const result = await store.readCurrentMemories({
      tenantId: "tenant-1",
      familiarId: "familiar-1",
    });

    expect(result.map((item) => [item.memoryId, item.revision])).toEqual([
      ["memory-1", 2],
      ["memory-2", 1],
    ]);
    const scopedSelect = statements.find((statement) => statement.startsWith("SELECT memory_id"));
    expect(scopedSelect).toContain("WHERE tenant_id = 'tenant-1' AND familiar_id = 'familiar-1'");
  });
});
