import { randomUUID } from "node:crypto";
import {
  buildCreateTableSql,
  healMissingColumns,
  type ColumnDef,
  type QueryFn,
} from "../deeplake-schema.js";
import { sqlIdent, sqlStr } from "../utils/sql.js";
import { canonicalizeFamiliarValue, sha256DigestCanonical } from "./canonicalize.js";
import type { FamiliarForgetComplete } from "./forgetting.js";
import {
  assertFamiliarPromotionCommitV1,
  type FamiliarPromotionCommitV1,
} from "./promotion-store.js";
import {
  assertMemoryMutationReceiptV1,
  assertMemoryTombstoneReceiptV1,
  isDigest,
} from "./validate.js";
import type {
  Digest,
  MemoryMutationReceiptV1,
  MemoryTombstoneReceiptV1,
} from "./types.js";

export const FAMILIAR_FORGET_COMMIT_COLUMNS: readonly ColumnDef[] = Object.freeze([
  { name: "id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "forget_commit_id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "tenant_id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "familiar_id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "identity_epoch", sql: "BIGINT NOT NULL DEFAULT 0" },
  { name: "promotion_commit_id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "promotion_commit_digest", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "memory_id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "memory_digest", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "mutation_digest", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "tombstone_digest", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "forget_commit_digest", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "canonical_json", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "created_at", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "writer_agent", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "plugin_version", sql: "TEXT NOT NULL DEFAULT ''" },
]);

export type FamiliarForgetCommitV1 = {
  kind: "arobi.familiar-forget-commit";
  version: 1;
  forgetCommitId: string;
  tenantId: string;
  familiarId: string;
  identityEpoch: number;
  promotionCommitId: string;
  promotionCommitDigest: Digest;
  memoryId: string;
  memoryDigest: Digest;
  mutationDigest: Digest;
  tombstoneDigest: Digest;
  mutation: MemoryMutationReceiptV1;
  tombstone: MemoryTombstoneReceiptV1;
  createdAt: string;
};

export type FamiliarForgetCommitStoreOptions = {
  query: QueryFn;
  workspaceId: string;
  tablePrefix: string;
  writerAgent: string;
  pluginVersion: string;
  log?: (message: string) => void;
};

export type PersistedFamiliarForgetCommit = {
  rowId: string;
  forgetCommitId: string;
  forgetCommitDigest: Digest;
};

function text(value: string): string {
  return `'${sqlStr(value)}'`;
}

function integer(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("FMP forget commit identityEpoch must be a non-negative safe integer");
  }
  return String(value);
}

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`FMP forget commit requires non-empty ${label}`);
  return normalized;
}

function tableName(prefix: string): string {
  return `${sqlIdent(prefix)}_familiar_forget_commits`;
}

function createIndexSql(args: {
  indexName: string;
  tableName: string;
  columns: readonly string[];
  unique?: boolean;
}): string {
  const index = sqlIdent(args.indexName);
  const table = sqlIdent(args.tableName);
  const columns = args.columns.map((column) => `"${sqlIdent(column)}"`).join(", ");
  return `CREATE ${args.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS "${index}" ON "${table}" (${columns})`;
}

function insertSql(table: string, values: Record<string, string>): string {
  const safeTable = sqlIdent(table);
  const columns = Object.keys(values);
  return `INSERT INTO "${safeTable}" (${columns.map((column) => `"${sqlIdent(column)}"`).join(", ")}) VALUES (${columns.map((column) => values[column]).join(", ")})`;
}

export function assertFamiliarForgetCommitV1(
  value: unknown,
): asserts value is FamiliarForgetCommitV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("FMP forget commit must be an object");
  }
  const commit = value as Record<string, unknown>;
  if (commit.kind !== "arobi.familiar-forget-commit" || commit.version !== 1) {
    throw new Error("unsupported FMP forget commit contract");
  }
  for (const key of [
    "forgetCommitId",
    "tenantId",
    "familiarId",
    "promotionCommitId",
    "memoryId",
    "createdAt",
  ] as const) {
    if (typeof commit[key] !== "string" || !commit[key].trim()) {
      throw new Error(`FMP forget commit ${key} must be a non-empty string`);
    }
  }
  if (!Number.isSafeInteger(commit.identityEpoch) || (commit.identityEpoch as number) < 0) {
    throw new Error("FMP forget commit identityEpoch must be a non-negative safe integer");
  }
  for (const key of [
    "promotionCommitDigest",
    "memoryDigest",
    "mutationDigest",
    "tombstoneDigest",
  ] as const) {
    if (!isDigest(commit[key])) throw new Error(`FMP forget commit ${key} is invalid`);
  }

  assertMemoryMutationReceiptV1(commit.mutation);
  assertMemoryTombstoneReceiptV1(commit.tombstone);
  const mutation = commit.mutation;
  const tombstone = commit.tombstone;
  if (
    mutation.tenantId !== commit.tenantId ||
    mutation.familiarId !== commit.familiarId ||
    mutation.identityEpoch !== commit.identityEpoch ||
    mutation.operation !== "FORGET"
  ) {
    throw new Error("FMP forget commit mutation does not match commit scope/operation");
  }
  if (
    tombstone.tenantId !== commit.tenantId ||
    tombstone.familiarId !== commit.familiarId ||
    tombstone.identityEpoch !== commit.identityEpoch ||
    tombstone.memoryId !== commit.memoryId
  ) {
    throw new Error("FMP forget commit tombstone does not match commit scope");
  }
  if (mutation.previousDigests.length !== 1 || mutation.previousDigests[0] !== commit.memoryDigest) {
    throw new Error("FMP forget commit mutation must bind exactly the forgotten memory digest");
  }
  if (tombstone.forgottenDigest !== commit.memoryDigest) {
    throw new Error("FMP forget commit tombstone does not bind forgotten memory digest");
  }
  if (sha256DigestCanonical(mutation) !== commit.mutationDigest) {
    throw new Error("FMP forget commit mutationDigest does not match canonical mutation");
  }
  if (sha256DigestCanonical(tombstone) !== commit.tombstoneDigest) {
    throw new Error("FMP forget commit tombstoneDigest does not match canonical tombstone");
  }
  if (tombstone.mutationReceiptDigest !== commit.mutationDigest) {
    throw new Error("FMP forget commit tombstone does not bind FORGET mutation digest");
  }
}

export function buildFamiliarForgetCommit(args: {
  promotion: FamiliarPromotionCommitV1;
  finalization: FamiliarForgetComplete;
}): FamiliarForgetCommitV1 {
  assertFamiliarPromotionCommitV1(args.promotion);
  const promotionDigest = sha256DigestCanonical(args.promotion);
  if (args.finalization.memoryDigest !== args.promotion.memoryDigest) {
    throw new Error("FMP forget finalization does not target the promoted memory digest");
  }
  if (args.finalization.mutationDigest !== sha256DigestCanonical(args.finalization.mutation)) {
    throw new Error("FMP forget finalization mutationDigest is stale or inconsistent");
  }
  if (args.finalization.tombstoneDigest !== sha256DigestCanonical(args.finalization.tombstone)) {
    throw new Error("FMP forget finalization tombstoneDigest is stale or inconsistent");
  }

  const commit: FamiliarForgetCommitV1 = {
    kind: "arobi.familiar-forget-commit",
    version: 1,
    forgetCommitId: `forget:${args.promotion.commitId}`,
    tenantId: args.promotion.tenantId,
    familiarId: args.promotion.familiarId,
    identityEpoch: args.promotion.identityEpoch,
    promotionCommitId: args.promotion.commitId,
    promotionCommitDigest: promotionDigest,
    memoryId: args.promotion.memoryId,
    memoryDigest: args.promotion.memoryDigest,
    mutationDigest: args.finalization.mutationDigest,
    tombstoneDigest: args.finalization.tombstoneDigest,
    mutation: args.finalization.mutation,
    tombstone: args.finalization.tombstone,
    createdAt: args.finalization.mutation.createdAt,
  };
  assertFamiliarForgetCommitV1(commit);
  return commit;
}

export class FamiliarForgetCommitStore {
  private ensured = false;
  private readonly name: string;

  constructor(private readonly options: FamiliarForgetCommitStoreOptions) {
    this.name = tableName(options.tablePrefix);
  }

  async ensure(): Promise<string> {
    if (this.ensured) return this.name;
    await this.options.query(buildCreateTableSql(this.name, FAMILIAR_FORGET_COMMIT_COLUMNS));
    await healMissingColumns({
      query: this.options.query,
      tableName: this.name,
      workspaceId: this.options.workspaceId,
      columns: FAMILIAR_FORGET_COMMIT_COLUMNS,
      log: this.options.log,
    });
    await this.options.query(createIndexSql({
      indexName: `${this.name}_forget_commit_id_uq`,
      tableName: this.name,
      columns: ["forget_commit_id"],
      unique: true,
    }));
    await this.options.query(createIndexSql({
      indexName: `${this.name}_promotion_commit_uq`,
      tableName: this.name,
      columns: ["tenant_id", "familiar_id", "identity_epoch", "promotion_commit_id"],
      unique: true,
    }));
    await this.options.query(createIndexSql({
      indexName: `${this.name}_memory_idx`,
      tableName: this.name,
      columns: ["tenant_id", "familiar_id", "identity_epoch", "memory_id"],
    }));
    this.ensured = true;
    return this.name;
  }

  async write(args: {
    promotion: FamiliarPromotionCommitV1;
    finalization: FamiliarForgetComplete;
  }): Promise<PersistedFamiliarForgetCommit> {
    const table = await this.ensure();
    const commit = buildFamiliarForgetCommit(args);
    const forgetCommitDigest = sha256DigestCanonical(commit);
    const rowId = randomUUID();
    await this.options.query(insertSql(table, {
      id: text(rowId),
      forget_commit_id: text(commit.forgetCommitId),
      tenant_id: text(commit.tenantId),
      familiar_id: text(commit.familiarId),
      identity_epoch: integer(commit.identityEpoch),
      promotion_commit_id: text(commit.promotionCommitId),
      promotion_commit_digest: text(commit.promotionCommitDigest),
      memory_id: text(commit.memoryId),
      memory_digest: text(commit.memoryDigest),
      mutation_digest: text(commit.mutationDigest),
      tombstone_digest: text(commit.tombstoneDigest),
      forget_commit_digest: text(forgetCommitDigest),
      canonical_json: text(canonicalizeFamiliarValue(commit)),
      created_at: text(commit.createdAt),
      writer_agent: text(nonEmpty(this.options.writerAgent, "writerAgent")),
      plugin_version: text(this.options.pluginVersion.trim()),
    }));
    return { rowId, forgetCommitId: commit.forgetCommitId, forgetCommitDigest };
  }

  async read(args: {
    tenantId: string;
    familiarId: string;
    identityEpoch: number;
  }): Promise<FamiliarForgetCommitV1[]> {
    const tenantId = nonEmpty(args.tenantId, "tenantId");
    const familiarId = nonEmpty(args.familiarId, "familiarId");
    const identityEpoch = integer(args.identityEpoch);
    const table = await this.ensure();
    const rows = (await this.options.query(
      `SELECT canonical_json, forget_commit_digest FROM "${sqlIdent(table)}" ` +
        `WHERE tenant_id = ${text(tenantId)} AND familiar_id = ${text(familiarId)} ` +
        `AND identity_epoch = ${identityEpoch} ORDER BY created_at ASC`,
    )) as Array<Record<string, unknown>>;

    const commits: FamiliarForgetCommitV1[] = [];
    for (const row of rows) {
      if (typeof row.canonical_json !== "string" || typeof row.forget_commit_digest !== "string") continue;
      try {
        const parsed: unknown = JSON.parse(row.canonical_json);
        assertFamiliarForgetCommitV1(parsed);
        if (
          parsed.tenantId !== tenantId ||
          parsed.familiarId !== familiarId ||
          parsed.identityEpoch !== args.identityEpoch
        ) {
          continue;
        }
        if (sha256DigestCanonical(parsed) !== row.forget_commit_digest) continue;
        commits.push(parsed);
      } catch {
        // Corrupt/unverifiable forget rows never suppress or rewrite live memory.
      }
    }
    return commits;
  }
}
