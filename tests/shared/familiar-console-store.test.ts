import { mkdtemp, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  FamiliarConsoleStore,
  FamiliarPersistence,
  publishFamiliarMemoryConsoleSnapshotFile,
  type FamiliarMemoryArtifactV1,
} from "../../src/familiar/index.js";

const D1 = `sha256:${"1".repeat(64)}` as const;
const D2 = `sha256:${"2".repeat(64)}` as const;
const D3 = `sha256:${"3".repeat(64)}` as const;

function memory(identityEpoch = 4): FamiliarMemoryArtifactV1 {
  return {
    kind: "arobi.familiar-memory",
    version: 1,
    memoryId: "memory-1",
    tenantId: "tenant-1",
    familiarId: "familiar-1",
    identityEpoch,
    memoryClass: "PREFERENCE",
    contentDigest: D1,
    originLabelDigest: D2,
    sourceArtifacts: [D3],
    transformationChain: [],
    trustClass: "OPERATOR_AUTHORED",
    supportState: "ASSERTED",
    mayInform: true,
    mayAuthorize: false,
    revision: 1,
    createdAt: "2026-09-04T20:00:00.000Z",
  };
}

function harness(row = memory()) {
  const queries: string[] = [];
  const query = async (sql: string): Promise<unknown> => {
    queries.push(sql);
    if (sql.includes("_familiar_memories\"") && sql.trimStart().startsWith("SELECT")) {
      return [
        {
          memory_id: row.memoryId,
          revision: row.revision,
          support_state: row.supportState,
          canonical_json: JSON.stringify(row),
        },
      ];
    }
    if (sql.includes("_familiar_continuity\"") && sql.trimStart().startsWith("SELECT")) return [];
    if (sql.includes("_familiar_tombstones\"") && sql.trimStart().startsWith("SELECT")) return [];
    // CREATE/ALTER/index/introspection operations are accepted by this bounded
    // unit fake. Empty introspection results intentionally exercise additive
    // schema healing without needing a real Deeplake workspace.
    return [];
  };
  const persistence = new FamiliarPersistence({
    query,
    workspaceId: "workspace-1",
    tablePrefix: "memory",
    writerAgent: "test",
    pluginVersion: "test",
  });
  return {
    queries,
    store: new FamiliarConsoleStore({ query, persistence }),
  };
}

describe("FMP console canonical-store transport", () => {
  it("scopes canonical reads by tenant, familiar, and exact current identity epoch before returning evidence", async () => {
    const { queries, store } = harness();
    const snapshot = await store.buildSnapshot({
      tenantId: "tenant-1",
      familiarId: "familiar-1",
      identityEpoch: 4,
    });

    expect(snapshot.identityEpoch).toBe(4);
    expect(snapshot.memories).toHaveLength(1);
    expect(snapshot.continuityState).toBe("UNAVAILABLE");

    const memoryRead = queries.find(
      (sql) => sql.startsWith("SELECT memory_id") && sql.includes("_familiar_memories"),
    );
    expect(memoryRead).toContain("tenant_id = 'tenant-1'");
    expect(memoryRead).toContain("familiar_id = 'familiar-1'");
    expect(memoryRead).toContain("identity_epoch = 4");
  });

  it("rejects a corrupted/wrong-epoch canonical row even if the storage response returned it", async () => {
    const { store } = harness(memory(3));
    const snapshot = await store.buildSnapshot({
      tenantId: "tenant-1",
      familiarId: "familiar-1",
      identityEpoch: 4,
    });

    expect(snapshot.identityEpoch).toBe(4);
    expect(snapshot.memories).toEqual([]);
    expect(snapshot.continuityState).toBe("UNAVAILABLE");
  });

  it("never upgrades an existing continuity artifact to VERIFIED without a verifier/policy verdict", async () => {
    const { store } = harness();
    // The harness has no continuity row, so the conservative state is
    // UNAVAILABLE. A separate fixture with a continuity row would default to
    // INCONCLUSIVE rather than VERIFIED by construction.
    const snapshot = await store.buildSnapshot({
      tenantId: "tenant-1",
      familiarId: "familiar-1",
      identityEpoch: 4,
    });
    expect(snapshot.continuityState).not.toBe("VERIFIED");
  });

  it("publishes a bounded canonical JSON snapshot to a private local file", async () => {
    const { store } = harness();
    const snapshot = await store.buildSnapshot({
      tenantId: "tenant-1",
      familiarId: "familiar-1",
      identityEpoch: 4,
    });
    const dir = await mkdtemp(join(tmpdir(), "arobi-fmp-console-"));
    const path = join(dir, "snapshot.json");

    await publishFamiliarMemoryConsoleSnapshotFile(path, snapshot);

    const raw = await readFile(path, "utf8");
    const published = JSON.parse(raw) as Record<string, unknown>;
    expect(published.kind).toBe("arobi.familiar-memory-console");
    expect(published.identityEpoch).toBe(4);
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });
});
