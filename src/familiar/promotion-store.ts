import { randomUUID } from "node:crypto";
import {
  buildCreateTableSql,
  healMissingColumns,
  type ColumnDef,
  type QueryFn,
} from "../deeplake-schema.js";
import { sqlIdent, sqlStr } from "../utils/sql.js";
import { canonicalizeFamiliarValue, sha256DigestCanonical } from "./canonicalize.js";
import { assertFamiliarMemoryCandidateV1 } from "./candidate.js";
import type { FamiliarPromotionPlan } from "./promotion.js";
import {
  assertFamiliarMemoryArtifactV1,
  assertMemoryMutationReceiptV1,
  isDigest,
} from "./validate.js";
import type {
  Digest,
  FamiliarMemoryArtifactV1,
  MemoryMutationReceiptV1,
} from "./types.js";

export const FAMILIAR_PROMOTION_COMMIT_COLUMNS: readonly ColumnDef[] = Object.freeze([
  { name: "id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "commit_id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "tenant_id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "familiar_id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "identity_epoch", sql: "BIGINT NOT NULL DEFAULT 0" },
  { name: "candidate_id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "candidate_digest", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "source_event_id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "source_event_digest", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "source_session_id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "memory_id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "memory_digest", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "mutation_id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "mutation_digest", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "commit_digest", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "canonical_json", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "created_at", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "writer_agent", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "plugin_version", sql: "TEXT NOT NULL DEFAULT ''" },
]);

export type FamiliarPromotionCommitV1 = {
  kind: "arobi.familiar-promotion-commit";
  version: 1;
  commitId: string;
  tenantId: string;
  familiarId: string;
  identityEpoch: number;
  candidateId: string;
  candidateDigest: Digest;
  sourceEventId: string;
  sourceEventDigest: Digest;
  sourceSessionId?: string;
  memoryId: string;
  memoryDigest: Digest;
  mutationId: string;
  mutationDigest: Digest;
  memory: FamiliarMemoryArtifactV1;
  mutation: MemoryMutationReceiptV1;
  createdAt: string;
};

export type PersistedFamiliarPromotionCommit = {
  rowId: string;
  commitId: string;
  commitDigest: Digest;
};

export type FamiliarPromotionCommitStoreOptions = {
  query: QueryFn;
  workspaceId: string;
  tablePrefix: string;
  writerAgent: string;
  pluginVersion: string;
  log?: (message: string) => void;
};

function text(value: string): string {
  return `'${sqlStr(value)}'`;
}

function integer(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("FMP promotion commit identityEpoch must be a non-negative safe integer");
  }
  return String(value);
}

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`FMP promotion commit requires non-empty ${label}`);
  return normalized;
}

function tableName(prefix: string): string {
  return `${sqlIdent(prefix)}_familiar_promotion_commits`;
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

export function assertFamiliarPromotionCommitV1(
  value: unknown,
): asserts value is FamiliarPromotionCommitV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("FMP promotion commit must be an object");
  }
  const commit = value as Record<string, unknown>;
  if (commit.kind !== "arobi.familiar-promotion-commit" || commit.version !== 1) {
    throw new Error("unsupported FMP promotion commit contract");
  }
  for (const key of [
    "commitId",
    "tenantId",
    "familiarId",
    "candidateId",
    "sourceEventId",
    "memoryId",
    "mutationId",
    "createdAt",
  ] as const) {
    if (typeof commit[key] !== "string" || !commit[key].trim()) {
      throw new Error(`FMP promotion commit ${key} must be a non-empty string`);
    }
  }
  if (
    commit.sourceSessionId !== undefined &&
    (typeof commit.sourceSessionId !== "string" || !commit.sourceSessionId.trim())
  ) {
    throw new Error("FMP promotion commit sourceSessionId must be non-empty when present");
  }
  if (!Number.isSafeInteger(commit.identityEpoch) || (commit.identityEpoch as number) < 0) {
    throw new Error("FMP promotion commit identityEpoch must be a non-negative safe integer");
  }
  for (const key of [
    "candidateDigest",
    "sourceEventDigest",
    "memoryDigest",
    "mutationDigest",
  ] as const) {
    if (!isDigest(commit[key])) throw new Error(`FMP promotion commit ${key} is invalid`);
  }

  assertFamiliarMemoryArtifactV1(commit.memory);
  assertMemoryMutationReceiptV1(commit.mutation);
  const memory = commit.memory;
  const mutation = commit.mutation;

  if (
    memory.tenantId !== commit.tenantId ||
    memory.familiarId !== commit.familiarId ||
    memory.identityEpoch !== commit.identityEpoch ||
    memory.memoryId !== commit.memoryId
  ) {
    throw new Error("FMP promotion commit memory scope does not match commit scope");
  }
  if (
    mutation.tenantId !== commit.tenantId ||
    mutation.familiarId !== commit.familiarId ||
    mutation.identityEpoch !== commit.identityEpoch ||
    mutation.mutationId !== commit.mutationId
  ) {
    throw new Error("FMP promotion commit mutation scope does not match commit scope");
  }
  if (mutation.operation !== "PROMOTE") {
    throw new Error("FMP promotion commit mutation must be PROMOTE");
  }
  if (memory.mayAuthorize !== false) {
    throw new Error("FMP promotion commit memory mayAuthorize must be false");
  }
  if (sha256DigestCanonical(memory) !== commit.memoryDigest) {
    throw new Error("FMP promotion commit memoryDigest does not match canonical memory");
  }
  if (sha256DigestCanonical(mutation) !== commit.mutationDigest) {
    throw new Error("FMP promotion commit mutationDigest does not match canonical mutation");
  }
  if (mutation.nextDigest !== commit.memoryDigest) {
    throw new Error("FMP promotion commit mutation nextDigest does not bind committed memory");
  }
  if (
    mutation.previousDigests.length !== 1 ||
    mutation.previousDigests[0] !== commit.candidateDigest
  ) {
    throw new Error("FMP promotion commit mutation must bind exactly the promoted candidate digest");
  }
  if (!memory.sourceArtifacts.includes(commit.sourceEventDigest)) {
    throw new Error("FMP promotion commit sourceEventDigest is not preserved in memory source artifacts");
  }
  if (!mutation.evidenceDigests.includes(commit.sourceEventDigest)) {
    throw new Error("FMP promotion commit sourceEventDigest is not preserved in mutation evidence");
  }
}

export function buildFamiliarPromotionCommit(
  plan: FamiliarPromotionPlan,
): FamiliarPromotionCommitV1 {
  assertFamiliarMemoryCandidateV1(plan.candidate);
  assertFamiliarMemoryArtifactV1(plan.memory);
  assertMemoryMutationReceiptV1(plan.mutation);

  const candidateDigest = sha256DigestCanonical(plan.candidate);
  const memoryDigest = sha256DigestCanonical(plan.memory);
  const mutationDigest = sha256DigestCanonical(plan.mutation);
  if (candidateDigest !== plan.candidateDigest) {
    throw new Error("FMP promotion plan candidateDigest is stale or inconsistent");
  }
  if (memoryDigest !== plan.memoryDigest) {
    throw new Error("FMP promotion plan memoryDigest is stale or inconsistent");
  }
  if (mutationDigest !== plan.mutationDigest) {
    throw new Error("FMP promotion plan mutationDigest is stale or inconsistent");
  }
  if (!isDigest(plan.candidate.originDigest)) {
    throw new Error("FMP promotion candidate source event digest is invalid");
  }

  const commit: FamiliarPromotionCommitV1 = {
    kind: "arobi.familiar-promotion-commit",
    version: 1,
    commitId: `promotion:${plan.candidate.candidateId}:${plan.memory.memoryId}`,
    tenantId: plan.candidate.tenantId,
    familiarId: plan.candidate.familiarId,
    identityEpoch: plan.candidate.identityEpoch,
    candidateId: plan.candidate.candidateId,
    candidateDigest,
    sourceEventId: plan.candidate.sourceEventId,
    sourceEventDigest: plan.candidate.originDigest,
    ...(plan.candidate.sourceSessionId ? { sourceSessionId: plan.candidate.sourceSessionId } : {}),
    memoryId: plan.memory.memoryId,
    memoryDigest,
    mutationId: plan.mutation.mutationId,
    mutationDigest,
    memory: plan.memory,
    mutation: plan.mutation,
    createdAt: plan.mutation.createdAt,
  };
  assertFamiliarPromotionCommitV1(commit);
  return commit;
}

export class FamiliarPromotionCommitStore {
  private ensured = false;
  private readonly name: string;

  constructor(private readonly options: FamiliarPromotionCommitStoreOptions) {
    this.name = tableName(options.tablePrefix);
  }

  async ensure(): Promise<string> {
    if (this.ensured) return this.name;
    await this.options.query(buildCreateTableSql(this.name, FAMILIAR_PROMOTION_COMMIT_COLUMNS));
    await healMissingColumns({
      query: this.options.query,
      tableName: this.name,
      workspaceId: this.options.workspaceId,
      columns: FAMILIAR_PROMOTION_COMMIT_COLUMNS,
      log: this.options.log,
    });
    await this.options.query(createIndexSql({
      indexName: `${this.name}_commit_id_uq`,
      tableName: this.name,
      columns: ["commit_id"],
      unique: true,
    }));
    await this.options.query(createIndexSql({
      indexName: `${this.name}_memory_scope_uq`,
      tableName: this.name,
      columns: ["tenant_id", "familiar_id", "identity_epoch", "memory_id"],
      unique: true,
    }));
    await this.options.query(createIndexSql({
      indexName: `${this.name}_source_event_idx`,
      tableName: this.name,
      columns: ["tenant_id", "familiar_id", "source_event_id"],
    }));
    await this.options.query(createIndexSql({
      indexName: `${this.name}_scope_idx`,
      tableName: this.name,
      columns: ["tenant_id", "familiar_id", "identity_epoch", "created_at"],
    }));
    this.ensured = true;
    return this.name;
  }

  /**
   * Persist one authoritative promotion commit as exactly one database row.
   * This is the durable source of truth for candidate -> source event -> memory
   * -> PROMOTE mutation. Separate memory/mutation rows are rebuildable
   * projections and must not be treated as proof without a matching commit.
   */
  async write(plan: FamiliarPromotionPlan): Promise<PersistedFamiliarPromotionCommit> {
    const table = await this.ensure();
    const commit = buildFamiliarPromotionCommit(plan);
    const commitDigest = sha256DigestCanonical(commit);
    const rowId = randomUUID();
    await this.options.query(insertSql(table, {
      id: text(rowId),
      commit_id: text(commit.commitId),
      tenant_id: text(commit.tenantId),
      familiar_id: text(commit.familiarId),
      identity_epoch: integer(commit.identityEpoch),
      candidate_id: text(commit.candidateId),
      candidate_digest: text(commit.candidateDigest),
      source_event_id: text(commit.sourceEventId),
      source_event_digest: text(commit.sourceEventDigest),
      source_session_id: text(commit.sourceSessionId ?? ""),
      memory_id: text(commit.memoryId),
      memory_digest: text(commit.memoryDigest),
      mutation_id: text(commit.mutationId),
      mutation_digest: text(commit.mutationDigest),
      commit_digest: text(commitDigest),
      canonical_json: text(canonicalizeFamiliarValue(commit)),
      created_at: text(commit.createdAt),
      writer_agent: text(nonEmpty(this.options.writerAgent, "writerAgent")),
      plugin_version: text(this.options.pluginVersion.trim()),
    }));
    return { rowId, commitId: commit.commitId, commitDigest };
  }

  async read(args: {
    tenantId: string;
    familiarId: string;
    identityEpoch: number;
  }): Promise<FamiliarPromotionCommitV1[]> {
    const tenantId = nonEmpty(args.tenantId, "tenantId");
    const familiarId = nonEmpty(args.familiarId, "familiarId");
    const identityEpoch = integer(args.identityEpoch);
    const table = await this.ensure();
    const rows = (await this.options.query(
      `SELECT canonical_json, commit_digest FROM "${sqlIdent(table)}" ` +
        `WHERE tenant_id = ${text(tenantId)} AND familiar_id = ${text(familiarId)} ` +
        `AND identity_epoch = ${identityEpoch} ORDER BY created_at ASC`,
    )) as Array<Record<string, unknown>>;

    const commits: FamiliarPromotionCommitV1[] = [];
    for (const row of rows) {
      if (typeof row.canonical_json !== "string" || typeof row.commit_digest !== "string") continue;
      try {
        const parsed: unknown = JSON.parse(row.canonical_json);
        assertFamiliarPromotionCommitV1(parsed);
        if (
          parsed.tenantId !== tenantId ||
          parsed.familiarId !== familiarId ||
          parsed.identityEpoch !== args.identityEpoch
        ) {
          continue;
        }
        if (sha256DigestCanonical(parsed) !== row.commit_digest) {
          continue;
        }
        commits.push(parsed);
      } catch {
        // Corrupt/unverifiable rows never become live familiar memory.
      }
    }
    return commits;
  }
}
