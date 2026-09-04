import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { QueryFn } from "../deeplake-schema.js";
import { sqlIdent, sqlStr } from "../utils/sql.js";
import { canonicalizeFamiliarValue } from "./canonicalize.js";
import {
  buildFamiliarMemoryConsoleSnapshot,
  type FamiliarConsoleContinuityState,
  type FamiliarMemoryConsoleSnapshotV1,
} from "./console.js";
import type { FamiliarPersistence } from "./persistence.js";
import {
  assertFamiliarContinuityAttestationV1,
  assertFamiliarMemoryArtifactV1,
  assertMemoryTombstoneReceiptV1,
} from "./validate.js";
import type {
  FamiliarContinuityAttestationV1,
  FamiliarMemoryArtifactV1,
  MemoryTombstoneReceiptV1,
} from "./types.js";

function text(value: string): string {
  return `'${sqlStr(value)}'`;
}

function epoch(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("FMP console store identityEpoch must be a non-negative safe integer");
  }
  return String(value);
}

function parseCanonical<T>(
  value: unknown,
  validate: (candidate: unknown) => asserts candidate is T,
): T | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    validate(parsed);
    return parsed;
  } catch {
    return undefined;
  }
}

export interface FamiliarConsoleStoreOptions {
  query: QueryFn;
  persistence: FamiliarPersistence;
}

export interface FamiliarConsoleSnapshotRequest {
  tenantId: string;
  familiarId: string;
  identityEpoch: number;
  familiarLabel?: string;
  /**
   * Optional verifier/policy verdict. When omitted, the store never upgrades
   * itself: no continuity row -> UNAVAILABLE; continuity row -> INCONCLUSIVE.
   */
  continuityState?: FamiliarConsoleContinuityState;
  currentModel?: string;
  currentRuntime?: string;
}

export class FamiliarConsoleStore {
  constructor(private readonly options: FamiliarConsoleStoreOptions) {}

  private async scope(request: FamiliarConsoleSnapshotRequest) {
    if (!request.tenantId.trim() || !request.familiarId.trim()) {
      throw new Error("FMP console store requires non-empty tenantId and familiarId");
    }
    epoch(request.identityEpoch);
    return this.options.persistence.ensure();
  }

  async readCurrentMemories(
    request: FamiliarConsoleSnapshotRequest,
  ): Promise<FamiliarMemoryArtifactV1[]> {
    const tables = await this.scope(request);
    const table = sqlIdent(tables.memories);
    const query =
      `SELECT memory_id, revision, support_state, canonical_json FROM "${table}" ` +
      `WHERE tenant_id = ${text(request.tenantId)} ` +
      `AND familiar_id = ${text(request.familiarId)} ` +
      `AND identity_epoch = ${epoch(request.identityEpoch)} ` +
      `ORDER BY memory_id ASC, revision DESC, created_at DESC`;
    const rows = (await this.options.query(query)) as Array<Record<string, unknown>>;
    const seen = new Set<string>();
    const current: FamiliarMemoryArtifactV1[] = [];

    for (const row of rows) {
      const memoryId = typeof row.memory_id === "string" ? row.memory_id : "";
      if (!memoryId || seen.has(memoryId)) continue;
      seen.add(memoryId);
      if (
        row.support_state === "SUPERSEDED" ||
        row.support_state === "QUARANTINED" ||
        row.support_state === "FORGOTTEN"
      ) {
        continue;
      }
      const parsed = parseCanonical(row.canonical_json, assertFamiliarMemoryArtifactV1);
      if (!parsed) continue;
      if (
        parsed.tenantId !== request.tenantId ||
        parsed.familiarId !== request.familiarId ||
        parsed.identityEpoch !== request.identityEpoch
      ) {
        continue;
      }
      current.push(parsed);
    }
    return current;
  }

  async readLatestContinuity(
    request: FamiliarConsoleSnapshotRequest,
  ): Promise<FamiliarContinuityAttestationV1 | undefined> {
    const tables = await this.scope(request);
    const table = sqlIdent(tables.continuity);
    const query =
      `SELECT canonical_json FROM "${table}" ` +
      `WHERE tenant_id = ${text(request.tenantId)} ` +
      `AND familiar_id = ${text(request.familiarId)} ` +
      `AND identity_epoch = ${epoch(request.identityEpoch)} ` +
      `ORDER BY created_at DESC LIMIT 1`;
    const rows = (await this.options.query(query)) as Array<Record<string, unknown>>;
    const parsed = parseCanonical(rows[0]?.canonical_json, assertFamiliarContinuityAttestationV1);
    if (!parsed) return undefined;
    if (
      parsed.tenantId !== request.tenantId ||
      parsed.familiarId !== request.familiarId ||
      parsed.identityEpoch !== request.identityEpoch
    ) {
      return undefined;
    }
    return parsed;
  }

  async readLatestTombstone(
    request: FamiliarConsoleSnapshotRequest,
  ): Promise<MemoryTombstoneReceiptV1 | undefined> {
    const tables = await this.scope(request);
    const table = sqlIdent(tables.tombstones);
    const query =
      `SELECT canonical_json FROM "${table}" ` +
      `WHERE tenant_id = ${text(request.tenantId)} ` +
      `AND familiar_id = ${text(request.familiarId)} ` +
      `AND identity_epoch = ${epoch(request.identityEpoch)} ` +
      `ORDER BY created_at DESC LIMIT 1`;
    const rows = (await this.options.query(query)) as Array<Record<string, unknown>>;
    const parsed = parseCanonical(rows[0]?.canonical_json, assertMemoryTombstoneReceiptV1);
    if (!parsed) return undefined;
    if (
      parsed.tenantId !== request.tenantId ||
      parsed.familiarId !== request.familiarId ||
      parsed.identityEpoch !== request.identityEpoch
    ) {
      return undefined;
    }
    return parsed;
  }

  async buildSnapshot(
    request: FamiliarConsoleSnapshotRequest,
  ): Promise<FamiliarMemoryConsoleSnapshotV1> {
    const [memories, continuity, latestTombstone] = await Promise.all([
      this.readCurrentMemories(request),
      this.readLatestContinuity(request),
      this.readLatestTombstone(request),
    ]);

    const continuityState =
      request.continuityState ?? (continuity ? "INCONCLUSIVE" : "UNAVAILABLE");

    return buildFamiliarMemoryConsoleSnapshot({
      tenantId: request.tenantId,
      familiarId: request.familiarId,
      identityEpoch: request.identityEpoch,
      familiarLabel: request.familiarLabel,
      continuityState,
      continuity,
      memories,
      latestTombstone,
      currentModel: request.currentModel,
      currentRuntime: request.currentRuntime,
    });
  }
}

/**
 * Publish a console snapshot atomically on the local host. The target file is
 * private-by-default (0600), the temporary file lives beside the target so the
 * rename stays on one filesystem, and no plaintext memory payload is added by
 * this transport beyond whatever explicitly policy-bounded preview fields the
 * already-built snapshot contains.
 */
export async function publishFamiliarMemoryConsoleSnapshotFile(
  path: string,
  snapshot: FamiliarMemoryConsoleSnapshotV1,
): Promise<void> {
  const target = path.trim();
  if (!target) throw new Error("FMP console snapshot path must be non-empty");
  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  const payload = `${canonicalizeFamiliarValue(snapshot)}\n`;
  try {
    await writeFile(temp, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}
