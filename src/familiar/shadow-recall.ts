import type { Config } from "../config.js";
import type { QueryFn } from "../deeplake-schema.js";
import { sha256DigestCanonical } from "./canonicalize.js";
import {
  openedCommittedArtifactDigests,
  retrieveCommittedFamiliarMemories,
} from "./committed-retrieval.js";
import { resolveFamiliarPayloadCipherFromEnv } from "./payload-vault.js";
import {
  FamiliarReadOnlyForgetSource,
  FamiliarReadOnlyPayloadSource,
  FamiliarReadOnlyPromotionSource,
} from "./read-only-store.js";
import type { Digest } from "./types.js";

export type FamiliarShadowEnvironment = Readonly<Record<string, string | undefined>>;

export type FamiliarRecallShadowRuntime =
  | { enabled: false }
  | {
      enabled: true;
      tenantId: string;
      familiarId: string;
      identityEpoch: number;
      tablePrefix: string;
      limit: number;
    };

export type FamiliarRecallShadowResult =
  | { state: "DISABLED" }
  | {
      state: "UNAVAILABLE";
      reasonCode: "SCOPE_UNAVAILABLE" | "PAYLOAD_KEY_UNAVAILABLE";
      observationDigest: Digest;
    }
  | {
      state: "INCONCLUSIVE";
      reasonCode: "READ_SOURCE_UNAVAILABLE" | "PAYLOAD_VERIFICATION_INCOMPLETE";
      retrievedCount: number;
      openedCount: number;
      unavailableCount: number;
      inconclusiveCount: number;
      retrievedDigests: Digest[];
      openedDigests: Digest[];
      observationDigest: Digest;
    }
  | {
      state: "OBSERVED";
      retrievedCount: number;
      openedCount: number;
      retrievedDigests: Digest[];
      openedDigests: Digest[];
      observationDigest: Digest;
    };

function envEnabled(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function required(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`FMP recall shadow requires ${label}`);
  return normalized;
}

function parseEpoch(value: string | undefined): number {
  const normalized = required(value, "AROBI_FMP_IDENTITY_EPOCH");
  if (!/^\d+$/.test(normalized)) {
    throw new Error("FMP recall shadow AROBI_FMP_IDENTITY_EPOCH must be a non-negative integer");
  }
  const epoch = Number(normalized);
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw new Error("FMP recall shadow AROBI_FMP_IDENTITY_EPOCH must be a non-negative safe integer");
  }
  return epoch;
}

function parseLimit(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 3;
  if (!/^\d+$/.test(value.trim())) {
    throw new Error("FMP recall shadow AROBI_FMP_RECALL_SHADOW_LIMIT must be an integer from 1 to 10");
  }
  const limit = Number(value.trim());
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) {
    throw new Error("FMP recall shadow AROBI_FMP_RECALL_SHADOW_LIMIT must be an integer from 1 to 10");
  }
  return limit;
}

/**
 * Resolve shadow recall scope from trusted OpenMind configuration + explicit
 * familiar identity/epoch. No prompt or caller payload can select tenant scope.
 */
export function resolveFamiliarRecallShadowRuntime(
  config: Pick<Config, "orgId" | "tableName">,
  env: FamiliarShadowEnvironment = process.env,
): FamiliarRecallShadowRuntime {
  if (!envEnabled(env.AROBI_FMP_RECALL_SHADOW)) return { enabled: false };
  const tenantId = required(config.orgId, "trusted config.orgId");
  const familiarId = required(env.AROBI_FMP_FAMILIAR_ID, "AROBI_FMP_FAMILIAR_ID");
  const identityEpoch = parseEpoch(env.AROBI_FMP_IDENTITY_EPOCH);
  const tablePrefix = env.AROBI_FMP_TABLE_PREFIX?.trim() || config.tableName.trim();
  if (!tablePrefix) throw new Error("FMP recall shadow requires a non-empty table prefix");
  return {
    enabled: true,
    tenantId,
    familiarId,
    identityEpoch,
    tablePrefix,
    limit: parseLimit(env.AROBI_FMP_RECALL_SHADOW_LIMIT),
  };
}

function observationDigest(value: Record<string, unknown>): Digest {
  return sha256DigestCanonical({
    kind: "arobi.familiar-recall-shadow-observation",
    version: 1,
    ...value,
  });
}

/**
 * Execute a SELECT-only, no-injection shadow probe of committed familiar recall.
 *
 * This function deliberately does NOT return decrypted payload contents and does
 * not construct a ContextUseReceipt: shadow observations did not influence the
 * proposal/model context, so claiming `reliedUpon` would be false evidence.
 *
 * Eligibility is conservative for the first shadow phase: supported memories
 * must be ASSERTED/OBSERVED/CORROBORATED, non-external-untrusted, `mayInform`,
 * current identity epoch and not authoritatively forgotten.
 */
export async function runFamiliarRecallShadow(args: {
  config: Pick<Config, "orgId" | "tableName">;
  query: QueryFn;
  prompt?: string;
  env?: FamiliarShadowEnvironment;
  now?: string;
}): Promise<FamiliarRecallShadowResult> {
  let runtime: FamiliarRecallShadowRuntime;
  try {
    runtime = resolveFamiliarRecallShadowRuntime(args.config, args.env ?? process.env);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      state: "UNAVAILABLE",
      reasonCode: "SCOPE_UNAVAILABLE",
      observationDigest: observationDigest({ reasonCode: "SCOPE_UNAVAILABLE", reason }),
    };
  }
  if (!runtime.enabled) return { state: "DISABLED" };

  let cipher;
  try {
    cipher = resolveFamiliarPayloadCipherFromEnv(args.env ?? process.env);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      state: "UNAVAILABLE",
      reasonCode: "PAYLOAD_KEY_UNAVAILABLE",
      observationDigest: observationDigest({
        tenantId: runtime.tenantId,
        familiarId: runtime.familiarId,
        identityEpoch: runtime.identityEpoch,
        reasonCode: "PAYLOAD_KEY_UNAVAILABLE",
        reason,
      }),
    };
  }

  const storeOptions = { query: args.query, tablePrefix: runtime.tablePrefix };
  const commits = new FamiliarReadOnlyPromotionSource(storeOptions);
  const forgets = new FamiliarReadOnlyForgetSource(storeOptions);
  const vault = new FamiliarReadOnlyPayloadSource({ ...storeOptions, cipher });
  const promptDigest = sha256DigestCanonical(args.prompt ?? "");

  try {
    const results = await retrieveCommittedFamiliarMemories({
      commits,
      forgets,
      vault,
      request: {
        tenantId: runtime.tenantId,
        familiarId: runtime.familiarId,
        identityEpoch: runtime.identityEpoch,
        allowedSupportStates: ["ASSERTED", "OBSERVED", "CORROBORATED"],
        allowedTrustClasses: ["OPERATOR_AUTHORED", "VERIFIED_SYSTEM", "OBSERVED", "DERIVED"],
        requireMayInform: true,
        now: args.now,
        limit: runtime.limit,
      },
    });

    const retrievedDigests = results.map((result) => result.artifactDigest);
    const openedDigests = openedCommittedArtifactDigests(results);
    const unavailableCount = results.filter((result) => result.payload.state === "UNAVAILABLE").length;
    const inconclusiveCount = results.filter((result) => result.payload.state === "INCONCLUSIVE").length;
    const common = {
      tenantId: runtime.tenantId,
      familiarId: runtime.familiarId,
      identityEpoch: runtime.identityEpoch,
      promptDigest,
      retrievedDigests,
      openedDigests,
      retrievedCount: results.length,
      openedCount: openedDigests.length,
      unavailableCount,
      inconclusiveCount,
    };

    if (unavailableCount > 0 || inconclusiveCount > 0) {
      return {
        state: "INCONCLUSIVE",
        reasonCode: "PAYLOAD_VERIFICATION_INCOMPLETE",
        retrievedCount: results.length,
        openedCount: openedDigests.length,
        unavailableCount,
        inconclusiveCount,
        retrievedDigests,
        openedDigests,
        observationDigest: observationDigest({
          ...common,
          state: "INCONCLUSIVE",
          reasonCode: "PAYLOAD_VERIFICATION_INCOMPLETE",
        }),
      };
    }

    return {
      state: "OBSERVED",
      retrievedCount: results.length,
      openedCount: openedDigests.length,
      retrievedDigests,
      openedDigests,
      observationDigest: observationDigest({ ...common, state: "OBSERVED" }),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      state: "INCONCLUSIVE",
      reasonCode: "READ_SOURCE_UNAVAILABLE",
      retrievedCount: 0,
      openedCount: 0,
      unavailableCount: 0,
      inconclusiveCount: 0,
      retrievedDigests: [],
      openedDigests: [],
      observationDigest: observationDigest({
        tenantId: runtime.tenantId,
        familiarId: runtime.familiarId,
        identityEpoch: runtime.identityEpoch,
        promptDigest,
        state: "INCONCLUSIVE",
        reasonCode: "READ_SOURCE_UNAVAILABLE",
        reason,
      }),
    };
  }
}
