import type { Config } from "../config.js";

export type FamiliarCaptureRuntime = {
  enabled: boolean;
  tenantId?: string;
  familiarId?: string;
  identityEpoch?: number;
  tablePrefix?: string;
};

export type FamiliarRuntimeEnvironment = Readonly<Record<string, string | undefined>>;

function enabled(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function nonEmpty(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`FMP capture requires ${label} when AROBI_FMP_CAPTURE is enabled`);
  return normalized;
}

function identityEpoch(value: string | undefined): number {
  const normalized = nonEmpty(value, "AROBI_FMP_IDENTITY_EPOCH");
  if (!/^\d+$/.test(normalized)) {
    throw new Error("FMP capture AROBI_FMP_IDENTITY_EPOCH must be a non-negative integer");
  }
  const epoch = Number(normalized);
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw new Error("FMP capture AROBI_FMP_IDENTITY_EPOCH must be a non-negative safe integer");
  }
  return epoch;
}

/**
 * Resolve the trusted scope used by the capture hook.
 *
 * Tenant identity is derived from authenticated OpenMind configuration, not
 * from the captured event. Familiar identity and its current epoch are explicit
 * operator/runtime configuration because guessing either would manufacture
 * identity continuity that the system has not established.
 */
export function resolveFamiliarCaptureRuntime(
  config: Pick<Config, "orgId" | "tableName">,
  env: FamiliarRuntimeEnvironment = process.env,
): FamiliarCaptureRuntime {
  if (!enabled(env.AROBI_FMP_CAPTURE)) return { enabled: false };

  const tenantId = nonEmpty(config.orgId, "trusted config.orgId");
  const familiarId = nonEmpty(env.AROBI_FMP_FAMILIAR_ID, "AROBI_FMP_FAMILIAR_ID");
  const epoch = identityEpoch(env.AROBI_FMP_IDENTITY_EPOCH);
  const tablePrefix = (env.AROBI_FMP_TABLE_PREFIX?.trim() || config.tableName.trim());
  if (!tablePrefix) {
    throw new Error("FMP capture requires a non-empty canonical table prefix");
  }

  return {
    enabled: true,
    tenantId,
    familiarId,
    identityEpoch: epoch,
    tablePrefix,
  };
}
