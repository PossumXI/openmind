import { randomUUID } from "node:crypto";
import { sqlIdent, sqlStr } from "../utils/sql.js";
import type { QueryFn } from "../deeplake-schema.js";
import { canonicalizeFamiliarValue, sha256DigestCanonical } from "./canonicalize.js";
import {
  assertFamiliarMemoryCandidateV1,
  type FamiliarMemoryCandidateV1,
} from "./candidate.js";
import { ensureFamiliarTables, type FamiliarTableNames } from "./schema.js";
import {
  assertContextUseReceiptV1,
  assertFamiliarContinuityAttestationV1,
  assertFamiliarManifestV1,
  assertFamiliarMemoryArtifactV1,
  assertMemoryMutationReceiptV1,
  assertMemoryTombstoneReceiptV1,
} from "./validate.js";
import type {
  ContextUseReceiptV1,
  Digest,
  FamiliarContinuityAttestationV1,
  FamiliarManifestV1,
  FamiliarMemoryArtifactV1,
  MemoryMutationReceiptV1,
  MemoryTombstoneReceiptV1,
} from "./types.js";

export interface FamiliarPersistenceOptions {
  query: QueryFn;
  workspaceId: string;
  tablePrefix: string;
  writerAgent: string;
  pluginVersion: string;
  log?: (message: string) => void;
}

export interface PersistedFamiliarArtifact {
  rowId: string;
  digest: Digest;
}

function text(value: string | undefined): string {
  return `'${sqlStr(value ?? "")}'`;
}

function integer(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`FMP persistence requires a non-negative safe integer, got ${String(value)}`);
  }
  return String(value);
}

function jsonText(value: unknown): string {
  return text(JSON.stringify(value));
}

function insertSql(tableName: string, values: Record<string, string>): string {
  const table = sqlIdent(tableName);
  const columns = Object.keys(values);
  const renderedColumns = columns.map((column) => sqlIdent(column)).join(", ");
  const renderedValues = columns.map((column) => values[column]).join(", ");
  return `INSERT INTO "${table}" (${renderedColumns}) VALUES (${renderedValues})`;
}

function canonicalText(value: unknown): string {
  return canonicalizeFamiliarValue(value);
}

export class FamiliarPersistence {
  private tables: FamiliarTableNames | null = null;

  constructor(private readonly options: FamiliarPersistenceOptions) {}

  async ensure(): Promise<FamiliarTableNames> {
    if (this.tables) return this.tables;
    this.tables = await ensureFamiliarTables({
      query: this.options.query,
      workspaceId: this.options.workspaceId,
      tablePrefix: this.options.tablePrefix,
      log: this.options.log,
    });
    return this.tables;
  }

  private async write(tableName: string, values: Record<string, string>): Promise<void> {
    await this.options.query(insertSql(tableName, values));
  }

  private writerColumns(): Record<string, string> {
    return {
      writer_agent: text(this.options.writerAgent),
      plugin_version: text(this.options.pluginVersion),
    };
  }

  /**
   * Persist a digest-only capture candidate. The canonical candidate contains
   * only identifiers, trust/classification metadata and digests; raw familiar
   * plaintext remains in the already-governed source event store until a
   * separate policy-controlled promotion creates a protected memory artifact.
   */
  async writeCandidate(value: unknown): Promise<PersistedFamiliarArtifact> {
    assertFamiliarMemoryCandidateV1(value);
    const tables = await this.ensure();
    const digest = sha256DigestCanonical(value);
    const rowId = randomUUID();
    await this.write(tables.candidates, {
      id: text(rowId),
      candidate_id: text(value.candidateId),
      tenant_id: text(value.tenantId),
      familiar_id: text(value.familiarId),
      identity_epoch: integer(value.identityEpoch),
      source_event_id: text(value.sourceEventId),
      source_session_id: text(value.sourceSessionId),
      proposed_class: text(value.proposedClass),
      trust_class: text(value.trustClass),
      origin_digest: text(value.originDigest),
      content_digest: text(value.contentDigest),
      may_authorize: "0",
      promotion_state: text(value.promotionState),
      canonical_json: text(canonicalText(value)),
      created_at: text(value.createdAt),
      ...this.writerColumns(),
    });
    return { rowId, digest };
  }

  async writeManifest(value: unknown): Promise<PersistedFamiliarArtifact> {
    assertFamiliarManifestV1(value);
    const tables = await this.ensure();
    const digest = sha256DigestCanonical(value);
    const rowId = randomUUID();
    await this.write(tables.manifests, {
      id: text(rowId),
      manifest_id: text(value.manifestId),
      tenant_id: text(value.tenantId),
      familiar_id: text(value.familiarId),
      identity_epoch: integer(value.identityEpoch),
      artifact_digest: text(digest),
      memory_root: text(value.memoryRoot),
      core_memory_root: text(value.coreMemoryRoot),
      skill_root: text(value.skillRoot),
      policy_epoch: integer(value.policyEpoch),
      authority_epoch: integer(value.authorityEpoch),
      canonical_json: text(canonicalText(value)),
      created_at: text(value.createdAt),
      ...this.writerColumns(),
    });
    return { rowId, digest };
  }

  async writeMemory(value: unknown): Promise<PersistedFamiliarArtifact> {
    assertFamiliarMemoryArtifactV1(value);
    const tables = await this.ensure();
    const digest = sha256DigestCanonical(value);
    const rowId = randomUUID();
    await this.write(tables.memories, {
      id: text(rowId),
      memory_id: text(value.memoryId),
      tenant_id: text(value.tenantId),
      familiar_id: text(value.familiarId),
      identity_epoch: integer(value.identityEpoch),
      revision: integer(value.revision),
      memory_class: text(value.memoryClass),
      trust_class: text(value.trustClass),
      support_state: text(value.supportState),
      may_authorize: "0",
      content_digest: text(value.contentDigest),
      origin_label_digest: text(value.originLabelDigest),
      artifact_digest: text(digest),
      previous_digest: text(value.previousDigest),
      superseded_by: text(value.supersededBy),
      source_artifacts_json: jsonText(value.sourceArtifacts),
      transformation_chain_json: jsonText(value.transformationChain),
      canonical_json: text(canonicalText(value)),
      created_at: text(value.createdAt),
      expires_at: text(value.expiresAt),
      ...this.writerColumns(),
    });
    return { rowId, digest };
  }

  async writeMutation(value: unknown): Promise<PersistedFamiliarArtifact> {
    assertMemoryMutationReceiptV1(value);
    const tables = await this.ensure();
    const digest = sha256DigestCanonical(value);
    const rowId = randomUUID();
    await this.write(tables.mutations, {
      id: text(rowId),
      mutation_id: text(value.mutationId),
      tenant_id: text(value.tenantId),
      familiar_id: text(value.familiarId),
      identity_epoch: integer(value.identityEpoch),
      operation: text(value.operation),
      policy_epoch: integer(value.policyEpoch),
      actor_ref: text(value.actorRef),
      receipt_digest: text(digest),
      previous_digests_json: jsonText(value.previousDigests),
      next_digest: text(value.nextDigest),
      evidence_digests_json: jsonText(value.evidenceDigests),
      canonical_json: text(canonicalText(value)),
      created_at: text(value.createdAt),
      ...this.writerColumns(),
    });
    return { rowId, digest };
  }

  async writeContextUse(value: unknown): Promise<PersistedFamiliarArtifact> {
    assertContextUseReceiptV1(value);
    const tables = await this.ensure();
    const digest = sha256DigestCanonical(value);
    const rowId = randomUUID();
    await this.write(tables.contextUse, {
      id: text(rowId),
      receipt_id: text(value.receiptId),
      tenant_id: text(value.tenantId),
      familiar_id: text(value.familiarId),
      identity_epoch: integer(value.identityEpoch),
      receipt_digest: text(digest),
      purpose_digest: text(value.purposeDigest),
      proposal_digest: text(value.proposalDigest),
      continuity_digest: text(value.familiarContinuityDigest),
      retrieved_json: jsonText(value.retrieved),
      opened_json: jsonText(value.opened),
      relied_upon_json: jsonText(value.reliedUpon),
      rejected_json: jsonText(value.rejectedOrConflicting),
      canonical_json: text(canonicalText(value)),
      created_at: text(value.createdAt),
      ...this.writerColumns(),
    });
    return { rowId, digest };
  }

  async writeContinuity(value: unknown): Promise<PersistedFamiliarArtifact> {
    assertFamiliarContinuityAttestationV1(value);
    const tables = await this.ensure();
    const digest = sha256DigestCanonical(value);
    const rowId = randomUUID();
    await this.write(tables.continuity, {
      id: text(rowId),
      attestation_id: text(value.attestationId),
      tenant_id: text(value.tenantId),
      familiar_id: text(value.familiarId),
      identity_epoch: integer(value.identityEpoch),
      attestation_digest: text(digest),
      memory_root: text(value.memoryRoot),
      core_memory_root: text(value.coreMemoryRoot),
      policy_epoch: integer(value.policyEpoch),
      authority_epoch: integer(value.authorityEpoch),
      previous_continuity_digest: text(value.previousContinuityDigest),
      canonical_json: text(canonicalText(value)),
      created_at: text(value.createdAt),
      ...this.writerColumns(),
    });
    return { rowId, digest };
  }

  async writeTombstone(value: unknown): Promise<PersistedFamiliarArtifact> {
    assertMemoryTombstoneReceiptV1(value);
    const tables = await this.ensure();
    const digest = sha256DigestCanonical(value);
    const rowId = randomUUID();
    await this.write(tables.tombstones, {
      id: text(rowId),
      tombstone_id: text(value.tombstoneId),
      memory_id: text(value.memoryId),
      tenant_id: text(value.tenantId),
      familiar_id: text(value.familiarId),
      identity_epoch: integer(value.identityEpoch),
      tombstone_digest: text(digest),
      forgotten_digest: text(value.forgottenDigest),
      mutation_receipt_digest: text(value.mutationReceiptDigest),
      surfaces_json: jsonText(value.surfaces),
      invalidated_derived_json: jsonText(value.invalidatedDerivedDigests),
      canonical_json: text(canonicalText(value)),
      created_at: text(value.createdAt),
      ...this.writerColumns(),
    });
    return { rowId, digest };
  }

  /**
   * Read current canonical memory rows for exactly one tenant + familiar.
   * Scope is applied in SQL before any application-level filtering/ranking.
   * Latest revision wins per memory id; non-current support states are omitted.
   */
  async readCurrentMemories(args: {
    tenantId: string;
    familiarId: string;
  }): Promise<FamiliarMemoryArtifactV1[]> {
    if (!args.tenantId.trim() || !args.familiarId.trim()) {
      throw new Error("FMP scoped read requires non-empty tenantId and familiarId");
    }
    const tables = await this.ensure();
    const table = sqlIdent(tables.memories);
    const query =
      `SELECT memory_id, revision, support_state, canonical_json FROM "${table}" ` +
      `WHERE tenant_id = ${text(args.tenantId)} AND familiar_id = ${text(args.familiarId)} ` +
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
      if (typeof row.canonical_json !== "string") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.canonical_json);
      } catch {
        continue;
      }
      try {
        assertFamiliarMemoryArtifactV1(parsed);
      } catch {
        continue;
      }
      if (parsed.tenantId !== args.tenantId || parsed.familiarId !== args.familiarId) {
        // Defense in depth against malformed/corrupted rows despite SQL scope.
        continue;
      }
      current.push(parsed);
    }
    return current;
  }

  /**
   * Read digest-only capture candidates for one tenant/familiar. Candidates are
   * never returned as live memories and never participate in authorization.
   */
  async readCandidates(args: {
    tenantId: string;
    familiarId: string;
    identityEpoch?: number;
    limit?: number;
  }): Promise<FamiliarMemoryCandidateV1[]> {
    if (!args.tenantId.trim() || !args.familiarId.trim()) {
      throw new Error("FMP candidate read requires non-empty tenantId and familiarId");
    }
    if (args.identityEpoch !== undefined && (!Number.isSafeInteger(args.identityEpoch) || args.identityEpoch < 0)) {
      throw new Error("FMP candidate read identityEpoch must be a non-negative safe integer");
    }
    const limit = args.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error("FMP candidate read limit must be an integer between 1 and 1000");
    }
    const tables = await this.ensure();
    const table = sqlIdent(tables.candidates);
    const epochClause = args.identityEpoch === undefined ? "" : ` AND identity_epoch = ${integer(args.identityEpoch)}`;
    const query =
      `SELECT canonical_json FROM "${table}" ` +
      `WHERE tenant_id = ${text(args.tenantId)} AND familiar_id = ${text(args.familiarId)}${epochClause} ` +
      `ORDER BY created_at DESC LIMIT ${limit}`;
    const rows = (await this.options.query(query)) as Array<Record<string, unknown>>;
    const out: FamiliarMemoryCandidateV1[] = [];
    for (const row of rows) {
      if (typeof row.canonical_json !== "string") continue;
      try {
        const parsed: unknown = JSON.parse(row.canonical_json);
        assertFamiliarMemoryCandidateV1(parsed);
        if (parsed.tenantId !== args.tenantId || parsed.familiarId !== args.familiarId) continue;
        if (args.identityEpoch !== undefined && parsed.identityEpoch !== args.identityEpoch) continue;
        out.push(parsed);
      } catch {
        continue;
      }
    }
    return out;
  }
}
