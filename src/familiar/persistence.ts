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
  FamiliarValidationError,
  isDigest,
  assertContextUseReceiptV1,
  assertFamiliarContinuityAttestationV1,
  assertFamiliarManifestV1,
  assertFamiliarMemoryArtifactV1,
  assertMemoryMutationReceiptV1,
  assertMemoryTombstoneReceiptV1,
} from "./validate.js";
import { MEMORY_TRUST_CLASSES } from "./types.js";
import type {
  ContextUseReceiptV1,
  Digest,
  FamiliarContinuityAttestationV1,
  FamiliarManifestV1,
  FamiliarMemoryArtifactV1,
  MemoryMutationReceiptV1,
  MemoryTombstoneReceiptV1,
  MemoryTrustClass,
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

/** How far, and over how many artifacts, a lineage is traced back to its origins before it is refused. */
const LINEAGE_MAX_DEPTH = 8;
const LINEAGE_MAX_ARTIFACTS = 64;

interface LineageRow {
  sources: Digest[];
  trustClass: MemoryTrustClass;
}

interface FamiliarLineage {
  row(digest: Digest): Promise<LineageRow | null>;
  originsOf(digest: Digest): Promise<Set<Digest>>;
}

function notIndependent(message: string): never {
  throw new FamiliarValidationError("FMP_CORROBORATION_NOT_INDEPENDENT", message);
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
    const lineage = this.lineage(tables.memories, value);
    await this.assertTrustDoesNotRise(value, lineage);
    if (value.supportState === "CORROBORATED") await this.assertIndependentCorroboration(value, lineage);
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

  /**
   * The origins a stored memory rests on, sorted: what its lineage reaches through the memories it was derived from
   * in this tenant, familiar and identity epoch, down to what is not a memory here (an event, a candidate or evidence).
   * However many times a source was summarized, the result still names it (ArobiMemBench MEM-001). Throws
   * FMP_LINEAGE_UNTRACEABLE when the trace cannot be completed within bounds.
   */
  async traceOrigins(args: { tenantId: string; familiarId: string; identityEpoch: number; artifactDigest: Digest }): Promise<Digest[]> {
    if (!isDigest(args.artifactDigest)) {
      throw new FamiliarValidationError("FMP_LINEAGE_UNTRACEABLE", "artifactDigest is not a digest");
    }
    const tables = await this.ensure();
    const lineage = this.lineage(tables.memories, args);
    if ((await lineage.row(args.artifactDigest)) === null) {
      throw new FamiliarValidationError("FMP_LINEAGE_UNTRACEABLE", "the artifact is not a memory recorded in this scope");
    }
    return [...(await lineage.originsOf(args.artifactDigest))].sort();
  }

  /**
   * Reads stored lineage in one scope, under one bounded budget: a row is a memory's recorded sources and trust, and
   * originsOf walks sources down to what is not a memory here. A trace that is too deep or too wide, a digest that
   * names two rows, or an unreadable row fails closed with FMP_LINEAGE_UNTRACEABLE.
   */
  private lineage(tableName: string, scope: { tenantId: string; familiarId: string; identityEpoch: number }): FamiliarLineage {
    const table = sqlIdent(tableName);
    const where = `tenant_id = ${text(scope.tenantId)} AND familiar_id = ${text(scope.familiarId)} `
      + `AND identity_epoch = ${integer(scope.identityEpoch)}`;
    const untraceable = (message: string): never => {
      throw new FamiliarValidationError("FMP_LINEAGE_UNTRACEABLE", message);
    };
    let reads = 0;
    const cache = new Map<Digest, LineageRow | null>();
    const row = async (digest: Digest): Promise<LineageRow | null> => {
      if (cache.has(digest)) return cache.get(digest)!;
      reads += 1;
      if (reads > LINEAGE_MAX_ARTIFACTS) untraceable("the lineage could not be traced to its origins within bounds");
      const rows = (await this.options.query(
        `SELECT source_artifacts_json, trust_class FROM "${table}" WHERE ${where} AND artifact_digest = ${text(digest)} LIMIT 2`,
      )) as Array<Record<string, unknown>>;
      if (!Array.isArray(rows) || rows.length === 0) {
        cache.set(digest, null);
        return null;
      }
      if (rows.length > 1) untraceable("a source digest names more than one stored memory");
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(rows[0].source_artifacts_json));
      } catch {
        untraceable("a source memory's lineage is unreadable");
      }
      const trustClass = rows[0].trust_class;
      if (!Array.isArray(parsed) || !parsed.every(isDigest)
        || !(MEMORY_TRUST_CLASSES as readonly unknown[]).includes(trustClass)) {
        untraceable("a source memory's lineage is unreadable");
      }
      const stored: LineageRow = { sources: parsed as Digest[], trustClass: trustClass as MemoryTrustClass };
      cache.set(digest, stored);
      return stored;
    };
    const originsOf = async (start: Digest): Promise<Set<Digest>> => {
      const origins = new Set<Digest>();
      const seen = new Set<Digest>([start]);
      let frontier: Digest[] = [start];
      for (let depth = 0; frontier.length > 0; depth += 1) {
        if (depth > LINEAGE_MAX_DEPTH) untraceable("the lineage could not be traced to its origins within bounds");
        const next: Digest[] = [];
        for (const digest of frontier) {
          const stored = await row(digest);
          if (stored === null || stored.sources.length === 0) {
            origins.add(digest);
            continue;
          }
          for (const parent of stored.sources) {
            if (!seen.has(parent)) {
              seen.add(parent);
              next.push(parent);
            }
          }
        }
        frontier = next;
      }
      return origins;
    };
    return { row, originsOf };
  }

  /**
   * A memory derived from stored memories is never more trusted than the least trusted of them: summarizing, merging
   * or repeating EXTERNAL_UNTRUSTED content keeps it EXTERNAL_UNTRUSTED (ArobiMemBench MEM-001).
   */
  private async assertTrustDoesNotRise(memory: FamiliarMemoryArtifactV1, lineage: FamiliarLineage): Promise<void> {
    let weakest = -1;
    for (const source of new Set(memory.sourceArtifacts)) {
      const stored = await lineage.row(source);
      if (stored) weakest = Math.max(weakest, MEMORY_TRUST_CLASSES.indexOf(stored.trustClass));
    }
    if (weakest >= 0 && MEMORY_TRUST_CLASSES.indexOf(memory.trustClass) < weakest) {
      throw new FamiliarValidationError(
        "FMP_TRUST_NOT_MONOTONE",
        `a memory derived from ${MEMORY_TRUST_CLASSES[weakest]} sources cannot be recorded as ${memory.trustClass}`,
      );
    }
  }

  /**
   * A memory may claim CORROBORATED only when at least two of its sources rest on different origins (ArobiMemBench
   * MEM-013). Summaries that all come from one observation reach the same origin, so they are one source repeated, not
   * independent confirmation. Every corroborating source must be a stored memory, whose lineage can be traced.
   */
  private async assertIndependentCorroboration(memory: FamiliarMemoryArtifactV1, lineage: FamiliarLineage): Promise<void> {
    const direct = [...new Set(memory.sourceArtifacts)];
    if (direct.length < 2) notIndependent("CORROBORATED needs at least two sources with different origins");
    const traced: Array<Set<Digest>> = [];
    try {
      for (const source of direct) {
        // Only a recorded memory has lineage to trace; an event and the candidate made from it would look unrelated.
        if ((await lineage.row(source)) === null) {
          notIndependent("each corroborating source must be a memory recorded in this scope, so its origins can be traced");
        }
        traced.push(await lineage.originsOf(source));
      }
    } catch (error) {
      if (error instanceof FamiliarValidationError && error.code === "FMP_LINEAGE_UNTRACEABLE") notIndependent(error.message);
      throw error;
    }
    for (let i = 0; i < traced.length; i += 1) {
      for (let j = i + 1; j < traced.length; j += 1) {
        if (![...traced[i]].some((origin) => traced[j].has(origin))) return;
      }
    }
    notIndependent("every source of this corroboration rests on a shared origin, so it is one source repeated");
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
   * Read current canonical memory rows for exactly one tenant + familiar +
   * identity epoch. Scope is applied in SQL before any application-level
   * filtering/ranking. Latest revision wins per memory id within that epoch;
   * non-current support states are omitted.
   */
  async readCurrentMemories(args: {
    tenantId: string;
    familiarId: string;
    identityEpoch: number;
  }): Promise<FamiliarMemoryArtifactV1[]> {
    if (!args.tenantId.trim() || !args.familiarId.trim()) {
      throw new Error("FMP scoped read requires non-empty tenantId and familiarId");
    }
    const identityEpoch = integer(args.identityEpoch);
    const tables = await this.ensure();
    const table = sqlIdent(tables.memories);
    const query =
      `SELECT memory_id, revision, support_state, canonical_json FROM "${table}" ` +
      `WHERE tenant_id = ${text(args.tenantId)} AND familiar_id = ${text(args.familiarId)} ` +
      `AND identity_epoch = ${identityEpoch} ` +
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
      if (
        parsed.tenantId !== args.tenantId ||
        parsed.familiarId !== args.familiarId ||
        parsed.identityEpoch !== args.identityEpoch
      ) {
        // Defense in depth against malformed/corrupted rows despite SQL scope.
        continue;
      }
      // A memory whose correction names it is not current, even if its own support state was never changed.
      if (parsed.supersededBy !== undefined) continue;
      current.push(parsed);
    }
    return current;
  }

  /**
   * Read one recorded revision by its artifact digest, whatever its state now: a corrected or superseded revision is
   * never overwritten (writes only insert), so the exact memory that informed earlier work can be reconstructed
   * (ArobiMemBench MEM-009). Returns null when no row in this scope has that digest; refuses a row whose stored bytes
   * no longer hash to it, or a digest that names two rows.
   */
  async readMemoryByDigest(args: {
    tenantId: string;
    familiarId: string;
    identityEpoch: number;
    artifactDigest: Digest;
  }): Promise<FamiliarMemoryArtifactV1 | null> {
    if (!args.tenantId.trim() || !args.familiarId.trim() || !isDigest(args.artifactDigest)) {
      throw new Error("FMP digest read requires non-empty tenantId and familiarId and an artifact digest");
    }
    const tables = await this.ensure();
    const rows = (await this.options.query(
      `SELECT canonical_json FROM "${sqlIdent(tables.memories)}" WHERE tenant_id = ${text(args.tenantId)} `
        + `AND familiar_id = ${text(args.familiarId)} AND identity_epoch = ${integer(args.identityEpoch)} `
        + `AND artifact_digest = ${text(args.artifactDigest)} LIMIT 2`,
    )) as Array<Record<string, unknown>>;
    if (!Array.isArray(rows) || rows.length === 0) return null;
    if (rows.length > 1) throw new Error("FMP digest read found more than one row for one artifact digest");
    const parsed: unknown = JSON.parse(String(rows[0].canonical_json));
    assertFamiliarMemoryArtifactV1(parsed);
    if (sha256DigestCanonical(parsed) !== args.artifactDigest) {
      throw new Error("FMP digest read found a row whose stored memory does not hash to its artifact digest");
    }
    return parsed;
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
