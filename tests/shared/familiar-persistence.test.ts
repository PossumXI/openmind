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
  sha256DigestCanonical,
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
    supportState: "OBSERVED",
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
      candidates: "memory_familiar_candidates",
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
      identityEpoch: 1,
    });

    expect(result.map((item) => [item.memoryId, item.revision])).toEqual([
      ["memory-1", 2],
      ["memory-2", 1],
    ]);
    const scopedSelect = statements.find((statement) => statement.startsWith("SELECT memory_id"));
    expect(scopedSelect).toContain("WHERE tenant_id = 'tenant-1' AND familiar_id = 'familiar-1'");
  });

  // ArobiMemBench MEM-013: summaries of one observation are one source repeated, not independent confirmation.
  describe("CORROBORATED needs sources with different origins", () => {
    const O1 = `sha256:${"a".repeat(64)}` as const; // observation A (event) and its candidate
    const C1 = `sha256:${"b".repeat(64)}` as const;
    const O2 = `sha256:${"c".repeat(64)}` as const; // observation B and its candidate
    const C2 = `sha256:${"d".repeat(64)}` as const;
    const M1 = `sha256:${"e".repeat(64)}` as const; // memory promoted from observation A
    const M2 = `sha256:${"f".repeat(64)}` as const; // memory promoted from observation B
    const S1 = `sha256:${"7".repeat(64)}` as const; // summary of M1
    const S2 = `sha256:${"8".repeat(64)}` as const; // another summary of M1
    const S3 = `sha256:${"9".repeat(64)}` as const; // a summary of a summary of M1
    const stored = new Map<string, string[]>([[M1, [C1, O1]], [M2, [C2, O2]], [S1, [M1]], [S2, [M1]], [S3, [S1]]]);
    const trust = new Map<string, string>([[M1, "OPERATOR_AUTHORED"], [M2, "OPERATOR_AUTHORED"], [S1, "DERIVED"], [S2, "DERIVED"], [S3, "DERIVED"]]);

    function store() {
      const statements: string[] = [];
      const query = async (sql: string): Promise<unknown> => {
        statements.push(sql);
        if (sql.includes("information_schema.columns")) return schemaRowsForIntrospection(sql);
        const lookup = sql.match(/^SELECT source_artifacts_json, trust_class FROM .+ AND artifact_digest = '(sha256:[0-9a-f]{64})' LIMIT 2$/);
        if (lookup) {
          expect(sql).toContain("tenant_id = 'tenant-1' AND familiar_id = 'familiar-1' AND identity_epoch = 1");
          const sources = stored.get(lookup[1]);
          return sources ? [{ source_artifacts_json: JSON.stringify(sources), trust_class: trust.get(lookup[1]) }] : [];
        }
        return [];
      };
      return { statements, persistence: new FamiliarPersistence({
        query, workspaceId: "workspace-1", tablePrefix: "memory", writerAgent: "test-agent", pluginVersion: "test-version",
      }) };
    }
    const corroborated = (sourceArtifacts: string[]) => memory({ supportState: "CORROBORATED", trustClass: "DERIVED", sourceArtifacts: sourceArtifacts as FamiliarMemoryArtifactV1["sourceArtifacts"] });

    it("accepts two memories that come from different observations", async () => {
      const { persistence, statements } = store();
      await expect(persistence.writeMemory(corroborated([M1, M2]))).resolves.toMatchObject({ digest: expect.any(String) });
      expect(statements.some((sql) => sql.startsWith("INSERT INTO"))).toBe(true);
    });

    it("refuses summaries that all trace back to one observation, however deep, and writes nothing", async () => {
      for (const sources of [[S1, S2], [S1, S3], [M1, S1], [S2, S3]]) {
        const { persistence, statements } = store();
        await expect(persistence.writeMemory(corroborated(sources)))
          .rejects.toMatchObject({ code: "FMP_CORROBORATION_NOT_INDEPENDENT" });
        expect(statements.some((sql) => sql.startsWith("INSERT INTO"))).toBe(false);
      }
    });

    it("refuses a single source, and sources that are not recorded memories (an event and its own candidate)", async () => {
      for (const sources of [[M1], [O1, C1], [M1, O2]]) {
        const { persistence } = store();
        await expect(persistence.writeMemory(corroborated(sources)))
          .rejects.toMatchObject({ code: "FMP_CORROBORATION_NOT_INDEPENDENT" });
      }
    });
  });

  // ArobiMemBench MEM-001: an external observation summarized three times stays external and traceable to its source.
  describe("derived memory keeps its sources and never gains trust", () => {
    const EVENT = `sha256:${"a".repeat(64)}` as const;
    const CAND = `sha256:${"b".repeat(64)}` as const;
    const OBS = `sha256:${"c".repeat(64)}` as const; // the stored external observation
    const SUM1 = `sha256:${"d".repeat(64)}` as const;
    const SUM2 = `sha256:${"e".repeat(64)}` as const;
    const rows = new Map<string, { sources: string[]; trust: string }>([
      [OBS, { sources: [CAND, EVENT], trust: "EXTERNAL_UNTRUSTED" }],
      [SUM1, { sources: [OBS], trust: "EXTERNAL_UNTRUSTED" }],
      [SUM2, { sources: [SUM1], trust: "EXTERNAL_UNTRUSTED" }],
    ]);
    function store() {
      const statements: string[] = [];
      const query = async (sql: string): Promise<unknown> => {
        statements.push(sql);
        if (sql.includes("information_schema.columns")) return schemaRowsForIntrospection(sql);
        const lookup = sql.match(/AND artifact_digest = '(sha256:[0-9a-f]{64})' LIMIT 2$/);
        if (lookup) {
          const stored = rows.get(lookup[1]);
          return stored ? [{ source_artifacts_json: JSON.stringify(stored.sources), trust_class: stored.trust }] : [];
        }
        return [];
      };
      return { statements, persistence: new FamiliarPersistence({
        query, workspaceId: "workspace-1", tablePrefix: "memory", writerAgent: "test-agent", pluginVersion: "test-version",
      }) };
    }
    const third = (trustClass: FamiliarMemoryArtifactV1["trustClass"]) =>
      memory({ memoryId: "summary-3", memoryClass: "EPISODIC", trustClass, supportState: "ASSERTED", sourceArtifacts: [SUM2] });

    it("refuses a third summary that claims more trust than the external observation, and writes nothing", async () => {
      for (const trustClass of ["DERIVED", "OBSERVED", "VERIFIED_SYSTEM", "OPERATOR_AUTHORED"] as const) {
        const { persistence, statements } = store();
        await expect(persistence.writeMemory(third(trustClass))).rejects.toMatchObject({ code: "FMP_TRUST_NOT_MONOTONE" });
        expect(statements.some((sql) => sql.startsWith("INSERT INTO"))).toBe(false);
      }
    });

    it("records it as external, and every summary still traces back to the original observation", async () => {
      const { persistence } = store();
      await expect(persistence.writeMemory(third("EXTERNAL_UNTRUSTED"))).resolves.toMatchObject({ digest: expect.any(String) });
      for (const artifactDigest of [OBS, SUM1, SUM2]) {
        await expect(persistence.traceOrigins({ tenantId: "tenant-1", familiarId: "familiar-1", identityEpoch: 1, artifactDigest }))
          .resolves.toEqual([EVENT, CAND].sort());
      }
      await expect(persistence.traceOrigins({ tenantId: "tenant-1", familiarId: "familiar-1", identityEpoch: 1, artifactDigest: EVENT }))
        .rejects.toMatchObject({ code: "FMP_LINEAGE_UNTRACEABLE" });
    });
  });

  // ArobiMemBench MEM-009: a correction is a new revision plus a mutation receipt; the corrected revision stays readable.
  describe("a correction never erases the revision it corrects", () => {
    it("inserts the new revision and its CORRECT receipt, and the old revision is still read back exactly", async () => {
      const table = new Map<string, Record<string, string>>();
      const statements: string[] = [];
      const query = async (sql: string): Promise<unknown> => {
        statements.push(sql);
        if (sql.includes("information_schema.columns")) return schemaRowsForIntrospection(sql);
        const insert = sql.match(/^INSERT INTO "memory_familiar_memories" \((.+?)\) VALUES \((.+)\)$/s);
        if (insert) {
          const columns = insert[1].split(", ").map((column) => column.replaceAll('"', ""));
          const values = [...insert[2].matchAll(/'((?:[^']|'')*)'|(\d+)/g)].map((m) => (m[1] ?? m[2]).replaceAll("''", "'"));
          const row = Object.fromEntries(columns.map((column, index) => [column, values[index]]));
          table.set(row.artifact_digest, row);
          return [];
        }
        const byDigest = sql.match(/^SELECT canonical_json FROM .+ AND artifact_digest = '(sha256:[0-9a-f]{64})' LIMIT 2$/);
        if (byDigest) {
          const row = table.get(byDigest[1]);
          return row ? [{ canonical_json: row.canonical_json }] : [];
        }
        return [];
      };
      const store = new FamiliarPersistence({ query, workspaceId: "workspace-1", tablePrefix: "memory", writerAgent: "test-agent", pluginVersion: "test-version" });

      const original = memory({ memoryClass: "PREFERENCE", contentDigest: D1 });
      const first = await store.writeMemory(original);
      const corrected = memory({ memoryClass: "PREFERENCE", contentDigest: D2, revision: 2, previousDigest: first.digest });
      const second = await store.writeMemory(corrected);
      await store.writeMutation({
        kind: "arobi.familiar-memory-mutation", version: 1, mutationId: "mutation-correct-1", familiarId: "familiar-1",
        tenantId: "tenant-1", identityEpoch: 1, operation: "CORRECT", actorRef: "principal:operator-1", reasonDigest: D3,
        policyEpoch: 1, previousDigests: [first.digest], nextDigest: second.digest, evidenceDigests: [], createdAt: NOW,
      });

      // Only inserts: nothing was updated or deleted in place.
      expect(statements.filter((sql) => /^(UPDATE|DELETE)\b/i.test(sql))).toEqual([]);
      const scope = { tenantId: "tenant-1", familiarId: "familiar-1", identityEpoch: 1 };
      const before = await store.readMemoryByDigest({ ...scope, artifactDigest: first.digest });
      expect(before).toEqual(original);
      expect(sha256DigestCanonical(before)).toBe(first.digest);
      expect(await store.readMemoryByDigest({ ...scope, artifactDigest: second.digest })).toEqual(corrected);
      expect(await store.readMemoryByDigest({ ...scope, artifactDigest: `sha256:${"9".repeat(64)}` })).toBeNull();
    });
  });
});
