import { createDecipheriv } from "node:crypto";
import type { QueryFn } from "../deeplake-schema.js";
import { sqlIdent, sqlStr } from "../utils/sql.js";
import {
  canonicalizeFamiliarValue,
  sha256DigestCanonical,
} from "./canonicalize.js";
import type {
  FamiliarForgetCommitSource,
  FamiliarPayloadOpenSource,
  FamiliarPromotionCommitSource,
} from "./committed-retrieval.js";
import {
  assertFamiliarForgetCommitV1,
  type FamiliarForgetCommitV1,
} from "./forget-store.js";
import type {
  FamiliarPayloadCipherConfig,
  FamiliarPayloadOpenResult,
} from "./payload-vault.js";
import {
  assertFamiliarPromotionCommitV1,
  type FamiliarPromotionCommitV1,
} from "./promotion-store.js";

const CIPHER_ALG = "AES-256-GCM";
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export type FamiliarReadOnlyStoreOptions = {
  query: QueryFn;
  tablePrefix: string;
};

export type FamiliarReadOnlyPayloadOptions = FamiliarReadOnlyStoreOptions & {
  cipher: FamiliarPayloadCipherConfig;
};

function text(value: string): string {
  return `'${sqlStr(value)}'`;
}

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`FMP read-only store requires non-empty ${label}`);
  return normalized;
}

function integer(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("FMP read-only store identityEpoch must be a non-negative safe integer");
  }
  return String(value);
}

function table(prefix: string, suffix: string): string {
  return `${sqlIdent(nonEmpty(prefix, "tablePrefix"))}_${suffix}`;
}

function promotionTable(prefix: string): string {
  return table(prefix, "familiar_promotion_commits");
}

function forgetTable(prefix: string): string {
  return table(prefix, "familiar_forget_commits");
}

function payloadTable(prefix: string): string {
  return table(prefix, "familiar_payload_vault");
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
    throw new Error(`FMP read-only payload ${label} must be non-empty base64`);
  }
  const buffer = Buffer.from(value, "base64");
  if (buffer.length === 0) throw new Error(`FMP read-only payload ${label} decoded empty`);
  return buffer;
}

function keyBuffer(config: FamiliarPayloadCipherConfig): Buffer {
  nonEmpty(config.keyId, "cipher.keyId");
  const key = Buffer.from(config.key);
  if (key.length !== 32) {
    throw new Error("FMP read-only payload key must be exactly 32 bytes for AES-256-GCM");
  }
  return key;
}

/**
 * SELECT-only authoritative promotion reader for latency-sensitive recall.
 *
 * Unlike `FamiliarPromotionCommitStore.read()`, this adapter never invokes
 * schema creation/healing/index DDL. If the expected table is unavailable, the
 * query error propagates and the shadow caller must remain unavailable rather
 * than creating infrastructure from a prompt hook.
 */
export class FamiliarReadOnlyPromotionSource implements FamiliarPromotionCommitSource {
  private readonly name: string;

  constructor(private readonly options: FamiliarReadOnlyStoreOptions) {
    this.name = promotionTable(options.tablePrefix);
  }

  async read(args: {
    tenantId: string;
    familiarId: string;
    identityEpoch: number;
  }): Promise<FamiliarPromotionCommitV1[]> {
    const tenantId = nonEmpty(args.tenantId, "tenantId");
    const familiarId = nonEmpty(args.familiarId, "familiarId");
    const rows = (await this.options.query(
      `SELECT canonical_json, commit_digest FROM "${sqlIdent(this.name)}" ` +
        `WHERE tenant_id = ${text(tenantId)} AND familiar_id = ${text(familiarId)} ` +
        `AND identity_epoch = ${integer(args.identityEpoch)} ORDER BY created_at ASC`,
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
        ) continue;
        if (sha256DigestCanonical(parsed) !== row.commit_digest) continue;
        commits.push(parsed);
      } catch {
        // Invalid/corrupt rows never become recallable familiar memory.
      }
    }
    return commits;
  }
}

/** SELECT-only authoritative forget reader. */
export class FamiliarReadOnlyForgetSource implements FamiliarForgetCommitSource {
  private readonly name: string;

  constructor(private readonly options: FamiliarReadOnlyStoreOptions) {
    this.name = forgetTable(options.tablePrefix);
  }

  async read(args: {
    tenantId: string;
    familiarId: string;
    identityEpoch: number;
  }): Promise<FamiliarForgetCommitV1[]> {
    const tenantId = nonEmpty(args.tenantId, "tenantId");
    const familiarId = nonEmpty(args.familiarId, "familiarId");
    const rows = (await this.options.query(
      `SELECT canonical_json, forget_commit_digest FROM "${sqlIdent(this.name)}" ` +
        `WHERE tenant_id = ${text(tenantId)} AND familiar_id = ${text(familiarId)} ` +
        `AND identity_epoch = ${integer(args.identityEpoch)} ORDER BY created_at ASC`,
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
        ) continue;
        if (sha256DigestCanonical(parsed) !== row.forget_commit_digest) continue;
        commits.push(parsed);
      } catch {
        // Invalid/corrupt rows never suppress or rewrite unrelated memory.
      }
    }
    return commits;
  }
}

/**
 * SELECT-only protected-payload opener for recall/shadow paths.
 *
 * This reproduces the vault's verification envelope without calling
 * `FamiliarPayloadVault.ensure()`: scope/AAD/key/cipher/digest checks remain the
 * same, but a prompt hook cannot create/heal tables or indexes.
 */
export class FamiliarReadOnlyPayloadSource implements FamiliarPayloadOpenSource {
  private readonly name: string;
  private readonly key: Buffer;

  constructor(private readonly options: FamiliarReadOnlyPayloadOptions) {
    this.name = payloadTable(options.tablePrefix);
    this.key = keyBuffer(options.cipher);
  }

  async open(commit: FamiliarPromotionCommitV1): Promise<FamiliarPayloadOpenResult> {
    try {
      assertFamiliarPromotionCommitV1(commit);
      const rows = (await this.options.query(
        `SELECT payload_id, content_digest, aad_digest, cipher_alg, key_id, nonce_b64, auth_tag_b64, ciphertext_b64 ` +
          `FROM "${sqlIdent(this.name)}" WHERE commit_id = ${text(commit.commitId)} ` +
          `AND tenant_id = ${text(commit.tenantId)} AND familiar_id = ${text(commit.familiarId)} ` +
          `AND identity_epoch = ${integer(commit.identityEpoch)} AND memory_id = ${text(commit.memoryId)} ` +
          `AND content_digest = ${text(commit.memory.contentDigest)} LIMIT 2`,
      )) as Array<Record<string, unknown>>;

      if (rows.length === 0) {
        return { state: "UNAVAILABLE", reason: "Committed familiar payload is absent from the protected vault." };
      }
      if (rows.length !== 1) {
        return { state: "INCONCLUSIVE", reason: "Multiple protected payload rows matched one promotion commit." };
      }

      const row = rows[0];
      if (row.payload_id !== payloadId(commit)) {
        return { state: "INCONCLUSIVE", reason: "Protected payload id does not match the promotion commit." };
      }
      if (row.cipher_alg !== CIPHER_ALG || row.key_id !== this.options.cipher.keyId) {
        return { state: "INCONCLUSIVE", reason: "Protected payload cipher/key identity does not match this runtime." };
      }

      const aad = canonicalizeFamiliarValue(aadObject(commit));
      const expectedAadDigest = sha256DigestCanonical(aadObject(commit));
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
      if (contentDigest !== commit.memory.contentDigest || row.content_digest !== contentDigest) {
        return { state: "INCONCLUSIVE", reason: "Decrypted familiar payload digest does not match committed memory." };
      }
      return { state: "AVAILABLE", payload, contentDigest };
    } catch (error) {
      return {
        state: "INCONCLUSIVE",
        reason: `Protected familiar payload could not be verified read-only: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
