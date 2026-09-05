import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  buildCreateTableSql,
  healMissingColumns,
  type ColumnDef,
  type QueryFn,
} from "../deeplake-schema.js";
import { sqlIdent, sqlStr } from "../utils/sql.js";
import { canonicalizeFamiliarValue, sha256DigestCanonical } from "./canonicalize.js";
import {
  assertFamiliarPromotionCommitV1,
  buildFamiliarPromotionCommit,
  type FamiliarPromotionCommitStore,
  type FamiliarPromotionCommitV1,
} from "./promotion-store.js";
import type { FamiliarPromotionPlan } from "./promotion.js";
import type { Digest } from "./types.js";

const CIPHER_ALG = "AES-256-GCM" as const;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export const FAMILIAR_PAYLOAD_VAULT_COLUMNS: readonly ColumnDef[] = Object.freeze([
  { name: "id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "payload_id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "commit_id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "tenant_id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "familiar_id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "identity_epoch", sql: "BIGINT NOT NULL DEFAULT 0" },
  { name: "memory_id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "content_digest", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "aad_digest", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "cipher_alg", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "key_id", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "nonce_b64", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "auth_tag_b64", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "ciphertext_b64", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "created_at", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "writer_agent", sql: "TEXT NOT NULL DEFAULT ''" },
  { name: "plugin_version", sql: "TEXT NOT NULL DEFAULT ''" },
]);

export type FamiliarPayloadCipherConfig = {
  keyId: string;
  key: Uint8Array;
};

export type FamiliarPayloadVaultOptions = {
  query: QueryFn;
  workspaceId: string;
  tablePrefix: string;
  writerAgent: string;
  pluginVersion: string;
  cipher: FamiliarPayloadCipherConfig;
  log?: (message: string) => void;
};

export type FamiliarPayloadStageResult = {
  payloadId: string;
  contentDigest: Digest;
  aadDigest: Digest;
};

export type FamiliarPayloadOpenResult =
  | { state: "AVAILABLE"; payload: unknown; contentDigest: Digest }
  | { state: "UNAVAILABLE"; reason: string }
  | { state: "INCONCLUSIVE"; reason: string };

export type FamiliarPayloadErasureResult = {
  surface: "CANONICAL_PAYLOAD";
  state: "VERIFIED" | "FAILED";
  verificationDigest?: Digest;
  detail: string;
};

export type FamiliarPromotionPublishResult = {
  commitId: string;
  commitDigest: Digest;
  payloadId: string;
  payloadContentDigest: Digest;
};

function text(value: string): string {
  return `'${sqlStr(value)}'`;
}

function integer(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("FMP payload identityEpoch must be a non-negative safe integer");
  }
  return String(value);
}

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`FMP payload vault requires non-empty ${label}`);
  return normalized;
}

function tableName(prefix: string): string {
  return `${sqlIdent(prefix)}_familiar_payload_vault`;
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

function keyBuffer(config: FamiliarPayloadCipherConfig): Buffer {
  const keyId = nonEmpty(config.keyId, "cipher.keyId");
  void keyId;
  const key = Buffer.from(config.key);
  if (key.length !== 32) {
    throw new Error("FMP payload cipher key must be exactly 32 bytes for AES-256-GCM");
  }
  return key;
}

function aadObject(commit: FamiliarPromotionCommitV1) {
  return {
    kind: "arobi.familiar-payload-aad",
    version: 1,
    commitId: commit.commitId,
    tenantId: commit.tenantId,
    familiarId: commit.familiarId,
    identityEpoch: commit.identityEpoch,
    memoryId: commit.memoryId,
    contentDigest: commit.memory.contentDigest,
  } as const;
}

function payloadId(commit: FamiliarPromotionCommitV1): string {
  return `payload:${commit.commitId}`;
}

function decodeBase64(value: unknown, label: string): Buffer {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`FMP payload ${label} must be non-empty base64`);
  }
  const buffer = Buffer.from(value, "base64");
  if (buffer.length === 0) throw new Error(`FMP payload ${label} decoded empty`);
  return buffer;
}

export function resolveFamiliarPayloadCipherFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): FamiliarPayloadCipherConfig {
  const keyId = nonEmpty(env.AROBI_FMP_PAYLOAD_KEY_ID ?? "", "AROBI_FMP_PAYLOAD_KEY_ID");
  const encoded = nonEmpty(env.AROBI_FMP_PAYLOAD_KEY_B64 ?? "", "AROBI_FMP_PAYLOAD_KEY_B64");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) {
    throw new Error("AROBI_FMP_PAYLOAD_KEY_B64 must decode to exactly 32 bytes");
  }
  return { keyId, key };
}

export class FamiliarPayloadVault {
  private ensured = false;
  private readonly name: string;
  private readonly key: Buffer;

  constructor(private readonly options: FamiliarPayloadVaultOptions) {
    this.name = tableName(options.tablePrefix);
    this.key = keyBuffer(options.cipher);
  }

  async ensure(): Promise<string> {
    if (this.ensured) return this.name;
    await this.options.query(buildCreateTableSql(this.name, FAMILIAR_PAYLOAD_VAULT_COLUMNS));
    await healMissingColumns({
      query: this.options.query,
      tableName: this.name,
      workspaceId: this.options.workspaceId,
      columns: FAMILIAR_PAYLOAD_VAULT_COLUMNS,
      log: this.options.log,
    });
    await this.options.query(createIndexSql({
      indexName: `${this.name}_payload_id_uq`,
      tableName: this.name,
      columns: ["payload_id"],
      unique: true,
    }));
    await this.options.query(createIndexSql({
      indexName: `${this.name}_scope_idx`,
      tableName: this.name,
      columns: ["tenant_id", "familiar_id", "identity_epoch", "memory_id"],
    }));
    this.ensured = true;
    return this.name;
  }

  /**
   * Stage encrypted content before the authoritative promotion commit is made
   * visible. An orphaned staged row is not a live memory because reads are
   * commit-driven; publishFamiliarPromotion() best-effort removes it if the
   * commit write fails.
   */
  async stage(commitValue: FamiliarPromotionCommitV1, payload: unknown): Promise<FamiliarPayloadStageResult> {
    assertFamiliarPromotionCommitV1(commitValue);
    const canonicalPayload = canonicalizeFamiliarValue(payload);
    const contentDigest = sha256DigestCanonical(payload);
    if (contentDigest !== commitValue.memory.contentDigest) {
      throw new Error("FMP payload content does not match promoted memory contentDigest");
    }

    const aad = canonicalizeFamiliarValue(aadObject(commitValue));
    const aadDigest = sha256DigestCanonical(aadObject(commitValue));
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce, { authTagLength: AUTH_TAG_BYTES });
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const ciphertext = Buffer.concat([
      cipher.update(canonicalPayload, "utf8"),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    const table = await this.ensure();
    const rowPayloadId = payloadId(commitValue);
    await this.options.query(insertSql(table, {
      id: text(randomUUID()),
      payload_id: text(rowPayloadId),
      commit_id: text(commitValue.commitId),
      tenant_id: text(commitValue.tenantId),
      familiar_id: text(commitValue.familiarId),
      identity_epoch: integer(commitValue.identityEpoch),
      memory_id: text(commitValue.memoryId),
      content_digest: text(contentDigest),
      aad_digest: text(aadDigest),
      cipher_alg: text(CIPHER_ALG),
      key_id: text(nonEmpty(this.options.cipher.keyId, "cipher.keyId")),
      nonce_b64: text(nonce.toString("base64")),
      auth_tag_b64: text(authTag.toString("base64")),
      ciphertext_b64: text(ciphertext.toString("base64")),
      created_at: text(commitValue.createdAt),
      writer_agent: text(nonEmpty(this.options.writerAgent, "writerAgent")),
      plugin_version: text(this.options.pluginVersion.trim()),
    }));

    return { payloadId: rowPayloadId, contentDigest, aadDigest };
  }

  async open(commitValue: FamiliarPromotionCommitV1): Promise<FamiliarPayloadOpenResult> {
    try {
      assertFamiliarPromotionCommitV1(commitValue);
      const table = await this.ensure();
      const rows = (await this.options.query(
        `SELECT payload_id, content_digest, aad_digest, cipher_alg, key_id, nonce_b64, auth_tag_b64, ciphertext_b64 ` +
          `FROM "${sqlIdent(table)}" WHERE commit_id = ${text(commitValue.commitId)} ` +
          `AND tenant_id = ${text(commitValue.tenantId)} AND familiar_id = ${text(commitValue.familiarId)} ` +
          `AND identity_epoch = ${integer(commitValue.identityEpoch)} AND memory_id = ${text(commitValue.memoryId)} ` +
          `AND content_digest = ${text(commitValue.memory.contentDigest)} LIMIT 2`,
      )) as Array<Record<string, unknown>>;

      if (rows.length === 0) {
        return { state: "UNAVAILABLE", reason: "Committed familiar payload is absent from the protected vault." };
      }
      if (rows.length !== 1) {
        return { state: "INCONCLUSIVE", reason: "Multiple protected payload rows matched one promotion commit." };
      }
      const row = rows[0];
      if (row.payload_id !== payloadId(commitValue)) {
        return { state: "INCONCLUSIVE", reason: "Protected payload id does not match the promotion commit." };
      }
      if (row.cipher_alg !== CIPHER_ALG || row.key_id !== this.options.cipher.keyId) {
        return { state: "INCONCLUSIVE", reason: "Protected payload cipher/key identity does not match this runtime." };
      }

      const aad = canonicalizeFamiliarValue(aadObject(commitValue));
      const expectedAadDigest = sha256DigestCanonical(aadObject(commitValue));
      if (row.aad_digest !== expectedAadDigest) {
        return { state: "INCONCLUSIVE", reason: "Protected payload AAD digest does not match the committed scope." };
      }
      const nonce = decodeBase64(row.nonce_b64, "nonce");
      const authTag = decodeBase64(row.auth_tag_b64, "auth tag");
      const ciphertext = decodeBase64(row.ciphertext_b64, "ciphertext");
      if (nonce.length !== NONCE_BYTES || authTag.length !== AUTH_TAG_BYTES) {
        return { state: "INCONCLUSIVE", reason: "Protected payload cryptographic envelope has invalid dimensions." };
      }

      const decipher = createDecipheriv("aes-256-gcm", this.key, nonce, { authTagLength: AUTH_TAG_BYTES });
      decipher.setAAD(Buffer.from(aad, "utf8"));
      decipher.setAuthTag(authTag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      const payload: unknown = JSON.parse(plaintext);
      const contentDigest = sha256DigestCanonical(payload);
      if (contentDigest !== commitValue.memory.contentDigest || row.content_digest !== contentDigest) {
        return { state: "INCONCLUSIVE", reason: "Decrypted familiar payload digest does not match committed memory." };
      }
      return { state: "AVAILABLE", payload, contentDigest };
    } catch (error) {
      return {
        state: "INCONCLUSIVE",
        reason: `Protected familiar payload could not be verified: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Remove the exact protected payload row and prove it is no longer readable
   * from the live vault surface. This does not make claims about provider
   * backups or external exports; those are separate erasure surfaces/policies.
   */
  async erase(commitValue: FamiliarPromotionCommitV1): Promise<FamiliarPayloadErasureResult> {
    try {
      assertFamiliarPromotionCommitV1(commitValue);
      const table = await this.ensure();
      const selector =
        `commit_id = ${text(commitValue.commitId)} AND tenant_id = ${text(commitValue.tenantId)} ` +
        `AND familiar_id = ${text(commitValue.familiarId)} AND identity_epoch = ${integer(commitValue.identityEpoch)} ` +
        `AND memory_id = ${text(commitValue.memoryId)} AND content_digest = ${text(commitValue.memory.contentDigest)}`;
      await this.options.query(`DELETE FROM "${sqlIdent(table)}" WHERE ${selector}`);
      const remaining = (await this.options.query(
        `SELECT payload_id FROM "${sqlIdent(table)}" WHERE ${selector} LIMIT 1`,
      )) as Array<Record<string, unknown>>;
      if (remaining.length !== 0) {
        return {
          surface: "CANONICAL_PAYLOAD",
          state: "FAILED",
          detail: "Protected familiar payload row remained readable after DELETE.",
        };
      }
      const verification = {
        kind: "arobi.familiar-erasure-verification",
        version: 1,
        surface: "CANONICAL_PAYLOAD",
        commitId: commitValue.commitId,
        tenantId: commitValue.tenantId,
        familiarId: commitValue.familiarId,
        identityEpoch: commitValue.identityEpoch,
        memoryId: commitValue.memoryId,
        contentDigest: commitValue.memory.contentDigest,
        state: "ABSENT_AFTER_DELETE",
      } as const;
      return {
        surface: "CANONICAL_PAYLOAD",
        state: "VERIFIED",
        verificationDigest: sha256DigestCanonical(verification),
        detail: "Protected familiar payload is absent from the live vault after scoped deletion.",
      };
    } catch (error) {
      return {
        surface: "CANONICAL_PAYLOAD",
        state: "FAILED",
        detail: `Protected familiar payload erasure could not be verified: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}

/**
 * Two-phase publish with a single authoritative visibility point:
 *   1. stage encrypted payload (not live by itself),
 *   2. append one promotion commit row containing memory + PROMOTE receipt.
 *
 * If step 2 fails, the staged payload is best-effort deleted and the error is
 * propagated. A staged orphan never constitutes a promoted memory because
 * retrieval must start from a verified promotion commit.
 */
export async function publishFamiliarPromotion(args: {
  plan: FamiliarPromotionPlan;
  payload: unknown;
  vault: FamiliarPayloadVault;
  commits: FamiliarPromotionCommitStore;
}): Promise<FamiliarPromotionPublishResult> {
  const commit = buildFamiliarPromotionCommit(args.plan);
  const staged = await args.vault.stage(commit, args.payload);
  try {
    const persisted = await args.commits.write(args.plan);
    if (persisted.commitId !== commit.commitId) {
      throw new Error("FMP promotion commit store returned an unexpected commit id");
    }
    return {
      commitId: persisted.commitId,
      commitDigest: persisted.commitDigest,
      payloadId: staged.payloadId,
      payloadContentDigest: staged.contentDigest,
    };
  } catch (error) {
    await args.vault.erase(commit).catch(() => undefined);
    throw error;
  }
}
