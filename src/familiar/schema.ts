import {
  buildCreateTableSql,
  healMissingColumns,
  type ColumnDef,
  type QueryFn,
} from "../deeplake-schema.js";
import { sqlIdent } from "../utils/sql.js";

export const FAMILIAR_MANIFEST_COLUMNS: readonly ColumnDef[] = Object.freeze([
  { name: "id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "manifest_id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "tenant_id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "familiar_id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "identity_epoch", sql: "BIGINT NOT NULL DEFAULT 0" },
  { name: "artifact_digest", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "memory_root", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "core_memory_root", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "skill_root", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "policy_epoch", sql: "BIGINT NOT NULL DEFAULT 0" },
  { name: "authority_epoch", sql: "BIGINT NOT NULL DEFAULT 0" },
  { name: "canonical_json", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "created_at", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "writer_agent", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "plugin_version", sql: "TEXT NOT NULL DEFAULT ''" },
]);

export const FAMILIAR_MEMORY_COLUMNS: readonly ColumnDef[] = Object.freeze([
  { name: "id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "memory_id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "tenant_id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "familiar_id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "identity_epoch", sql: "BIGINT NOT NULL DEFAULT 0" },
  { name: "revision", sql: "BIGINT NOT NULL DEFAULT 1" },
  { name: "memory_class", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "trust_class", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "support_state", sql: "TEXT NOT NULL DEFAULT ''" },
  // Literal 0 is defense in depth for the FMP invariant: memory is context,
  // never execution authority. Runtime validation also rejects true.
  { name: "may_authorize", sql: "BIGINT NOT NULL DEFAULT 0" },
  { name: "content_digest", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "origin_label_digest", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "artifact_digest", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "previous_digest", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "superseded_by", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "source_artifacts_json", sql: "TEXT NOT NULL DEFAULT '[]'" },
  { name: "transformation_chain_json", sql: "TEXT NOT NULL DEFAULT '[]'" },
  { name: "canonical_json", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "created_at", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "expires_at", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "writer_agent", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "plugin_version", sql: "TEXT NOT NULL DEFAULT ''" },
]);

export const FAMILIAR_MUTATION_COLUMNS: readonly ColumnDef[] = Object.freeze([
  { name: "id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "mutation_id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "tenant_id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "familiar_id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "identity_epoch", sql: "BIGINT NOT NULL DEFAULT 0" },
  { name: "operation", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "policy_epoch", sql: "BIGINT NOT NULL DEFAULT 0" },
  { name: "actor_ref", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "receipt_digest", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "previous_digests_json", sql: "TEXT NOT NULL DEFAULT '[]'" },
  { name: "next_digest", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "evidence_digests_json", sql: "TEXT NOT NULL DEFAULT '[]'" },
  { name: "canonical_json", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "created_at", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "writer_agent", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "plugin_version", sql: "TEXT NOT NULL DEFAULT ''" },
]);

export const FAMILIAR_CONTEXT_USE_COLUMNS: readonly ColumnDef[] = Object.freeze([
  { name: "id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "receipt_id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "tenant_id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "familiar_id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "identity_epoch", sql: "BIGINT NOT NULL DEFAULT 0" },
  { name: "receipt_digest", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "purpose_digest", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "proposal_digest", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "continuity_digest", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "retrieved_json", sql: "TEXT NOT NULL DEFAULT '[]'" },
  { name: "opened_json", sql: "TEXT NOT NULL DEFAULT '[]'" },
  { name: "relied_upon_json", sql: "TEXT NOT NULL DEFAULT '[]'" },
  { name: "rejected_json", sql: "TEXT NOT NULL DEFAULT '[]'" },
  { name: "canonical_json", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "created_at", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "writer_agent", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "plugin_version", sql: "TEXT NOT NULL DEFAULT ''" },
]);

export const FAMILIAR_CONTINUITY_COLUMNS: readonly ColumnDef[] = Object.freeze([
  { name: "id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "attestation_id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "tenant_id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "familiar_id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "identity_epoch", sql: "BIGINT NOT NULL DEFAULT 0" },
  { name: "attestation_digest", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "memory_root", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "core_memory_root", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "policy_epoch", sql: "BIGINT NOT NULL DEFAULT 0" },
  { name: "authority_epoch", sql: "BIGINT NOT NULL DEFAULT 0" },
  { name: "previous_continuity_digest", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "canonical_json", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "created_at", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "writer_agent", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "plugin_version", sql: "TEXT NOT NULL DEFAULT ''" },
]);

export const FAMILIAR_TOMBSTONE_COLUMNS: readonly ColumnDef[] = Object.freeze([
  { name: "id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "tombstone_id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "memory_id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "tenant_id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "familiar_id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "identity_epoch", sql: "BIGINT NOT NULL DEFAULT 0" },
  { name: "tombstone_digest", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "forgotten_digest", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "mutation_receipt_digest", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "surfaces_json", sql: "TEXT NOT NULL DEFAULT '[]'" },
  { name: "invalidated_derived_json", sql: "TEXT NOT NULL DEFAULT '[]'" },
  { name: "canonical_json", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "created_at", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "writer_agent", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "plugin_version", sql: "TEXT NOT NULL DEFAULT ''" },
]);

export interface FamiliarTableNames {
  manifests: string;
  memories: string;
  mutations: string;
  contextUse: string;
  continuity: string;
  tombstones: string;
}

export function familiarTableNames(prefix: string): FamiliarTableNames {
  const safe = sqlIdent(prefix);
  return {
    manifests: `${safe}_familiar_manifests`,
    memories: `${safe}_familiar_memories`,
    mutations: `${safe}_familiar_mutations`,
    contextUse: `${safe}_familiar_context_use`,
    continuity: `${safe}_familiar_continuity`,
    tombstones: `${safe}_familiar_tombstones`,
  };
}

const TABLE_DEFS: ReadonlyArray<{
  key: keyof FamiliarTableNames;
  columns: readonly ColumnDef[];
}> = Object.freeze([
  { key: "manifests", columns: FAMILIAR_MANIFEST_COLUMNS },
  { key: "memories", columns: FAMILIAR_MEMORY_COLUMNS },
  { key: "mutations", columns: FAMILIAR_MUTATION_COLUMNS },
  { key: "contextUse", columns: FAMILIAR_CONTEXT_USE_COLUMNS },
  { key: "continuity", columns: FAMILIAR_CONTINUITY_COLUMNS },
  { key: "tombstones", columns: FAMILIAR_TOMBSTONE_COLUMNS },
]);

/**
 * Create/heal every additive FMP table using openmind's existing Deeplake
 * schema primitives. No destructive migration or parallel ALTER flow.
 */
export async function ensureFamiliarTables(args: {
  query: QueryFn;
  workspaceId: string;
  tablePrefix: string;
  log?: (message: string) => void;
}): Promise<FamiliarTableNames> {
  const names = familiarTableNames(args.tablePrefix);
  for (const definition of TABLE_DEFS) {
    const tableName = names[definition.key];
    await args.query(buildCreateTableSql(tableName, definition.columns));
    await healMissingColumns({
      query: args.query,
      tableName,
      workspaceId: args.workspaceId,
      columns: definition.columns,
      log: args.log,
    });
  }
  return names;
}
