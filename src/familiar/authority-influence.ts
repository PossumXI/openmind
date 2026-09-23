import { sha256DigestCanonical } from "./canonicalize.js";
import { isDigest } from "./validate.js";
import type { Digest } from "./types.js";

export const AUTHORITY_INFLUENCE_SCHEMA = "arobi.familiar-authority-influence.v1" as const;

export const CONTEXT_ONLY_AUTHORITY_SOURCES = [
  "MEMORY",
  "RETRIEVED_TEXT",
  "MODEL_OUTPUT",
  "TOOL_OUTPUT",
  "REASONING_HISTORY",
] as const;

export type ContextOnlyAuthoritySource = (typeof CONTEXT_ONLY_AUTHORITY_SOURCES)[number];
export type AuthorityInfluenceSource =
  | ContextOnlyAuthoritySource
  | "AUTHORITY_RESOLUTION"
  | "POLICY_DECISION";
export type RequestedAuthorityChange =
  | "NONE"
  | "MINT"
  | "EXTEND_SCOPE"
  | "INCREASE_BUDGET"
  | "REFRESH_LIFETIME";
export type AuthorityInfluenceDecision =
  | "ALLOW_PLANNING_ONLY"
  | "HOLD_EXTERNAL_AUTHORITY_VERIFICATION"
  | "REJECT";

const REQUESTED_AUTHORITY_CHANGES = new Set<RequestedAuthorityChange>([
  "NONE",
  "MINT",
  "EXTEND_SCOPE",
  "INCREASE_BUDGET",
  "REFRESH_LIFETIME",
]);

export interface FamiliarAuthorityInfluenceV1 {
  schemaVersion: typeof AUTHORITY_INFLUENCE_SCHEMA;
  tenantId: string;
  familiarId: string;
  identityEpoch: number;
  authorityEpoch: number;
  contextUseReceiptDigest: Digest;
  influenceSources: AuthorityInfluenceSource[];
  requestedAuthorityChange: RequestedAuthorityChange;
  decision: AuthorityInfluenceDecision;
  reasonCode:
    | "CONTEXT_MAY_INFORM_PLANNING"
    | "AUTHORITY_FROM_UNTRUSTED_MEMORY"
    | "EXTERNAL_AUTHORITY_VERIFICATION_REQUIRED";
  authorityChanged: false;
  evaluatedAt: string;
  recordDigest: Digest;
}

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`FMP authority influence requires ${field}`);
  return normalized;
}

function epoch(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`FMP authority influence requires non-negative ${field}`);
  }
  return value;
}

function timestamp(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error("FMP authority influence requires canonical evaluatedAt");
  }
  return value;
}

/**
 * Memory/context evidence can inform planning, but this layer has no transition
 * that mints, widens, or refreshes authority. Even trusted authority references
 * are returned to the external authority PEP for native verification.
 */
export function evaluateFamiliarAuthorityInfluence(input: {
  tenantId: string;
  familiarId: string;
  identityEpoch: number;
  authorityEpoch: number;
  contextUseReceiptDigest: Digest;
  influenceSources: readonly AuthorityInfluenceSource[];
  requestedAuthorityChange: RequestedAuthorityChange;
  evaluatedAt?: string;
}): FamiliarAuthorityInfluenceV1 {
  if (!isDigest(input.contextUseReceiptDigest)) {
    throw new Error("FMP authority influence requires contextUseReceiptDigest");
  }
  if (!REQUESTED_AUTHORITY_CHANGES.has(input.requestedAuthorityChange)) {
    throw new Error("FMP authority influence requires recognized requestedAuthorityChange");
  }
  const validSources = new Set<AuthorityInfluenceSource>([
    ...CONTEXT_ONLY_AUTHORITY_SOURCES,
    "AUTHORITY_RESOLUTION",
    "POLICY_DECISION",
  ]);
  const influenceSources = [...new Set(input.influenceSources)];
  if (influenceSources.length === 0 || influenceSources.some((source) => !validSources.has(source))) {
    throw new Error("FMP authority influence requires recognized influenceSources");
  }
  influenceSources.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);

  const contextOnly = influenceSources.some((source) =>
    CONTEXT_ONLY_AUTHORITY_SOURCES.includes(source as ContextOnlyAuthoritySource));
  let decision: AuthorityInfluenceDecision;
  let reasonCode: FamiliarAuthorityInfluenceV1["reasonCode"];
  if (input.requestedAuthorityChange === "NONE") {
    decision = "ALLOW_PLANNING_ONLY";
    reasonCode = "CONTEXT_MAY_INFORM_PLANNING";
  } else if (contextOnly) {
    decision = "REJECT";
    reasonCode = "AUTHORITY_FROM_UNTRUSTED_MEMORY";
  } else {
    decision = "HOLD_EXTERNAL_AUTHORITY_VERIFICATION";
    reasonCode = "EXTERNAL_AUTHORITY_VERIFICATION_REQUIRED";
  }

  const body = {
    schemaVersion: AUTHORITY_INFLUENCE_SCHEMA,
    tenantId: nonEmpty(input.tenantId, "tenantId"),
    familiarId: nonEmpty(input.familiarId, "familiarId"),
    identityEpoch: epoch(input.identityEpoch, "identityEpoch"),
    authorityEpoch: epoch(input.authorityEpoch, "authorityEpoch"),
    contextUseReceiptDigest: input.contextUseReceiptDigest,
    influenceSources,
    requestedAuthorityChange: input.requestedAuthorityChange,
    decision,
    reasonCode,
    authorityChanged: false as const,
    evaluatedAt: timestamp(input.evaluatedAt ?? new Date().toISOString()),
  };
  return Object.freeze({
    ...body,
    recordDigest: sha256DigestCanonical(body),
  });
}
