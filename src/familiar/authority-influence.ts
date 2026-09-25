import { sha256DigestCanonical } from "./canonicalize.js";
import { FamiliarValidationError, isDigest } from "./validate.js";
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

const INFLUENCE_SOURCES: ReadonlySet<string> = new Set<AuthorityInfluenceSource>([
  ...CONTEXT_ONLY_AUTHORITY_SOURCES,
  "AUTHORITY_RESOLUTION",
  "POLICY_DECISION",
]);

const RECORD_KEYS = [
  "authorityChanged",
  "authorityEpoch",
  "contextUseReceiptDigest",
  "decision",
  "evaluatedAt",
  "familiarId",
  "identityEpoch",
  "influenceSources",
  "reasonCode",
  "recordDigest",
  "requestedAuthorityChange",
  "schemaVersion",
  "tenantId",
] as const;

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

function isCanonicalTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function timestamp(value: string): string {
  if (!isCanonicalTimestamp(value)) {
    throw new Error("FMP authority influence requires canonical evaluatedAt");
  }
  return value;
}

/**
 * The only decision table. NONE may inform planning; any context-only source
 * behind an authority change is rejected (mixed trusted + context-only sources
 * fail closed); only purely trusted references are held for the external
 * authority PEP. No branch changes authority.
 */
function decideAuthorityInfluence(
  influenceSources: readonly AuthorityInfluenceSource[],
  requestedAuthorityChange: RequestedAuthorityChange,
): Pick<FamiliarAuthorityInfluenceV1, "decision" | "reasonCode"> {
  if (requestedAuthorityChange === "NONE") {
    return { decision: "ALLOW_PLANNING_ONLY", reasonCode: "CONTEXT_MAY_INFORM_PLANNING" };
  }
  const contextOnly = influenceSources.some((source) =>
    CONTEXT_ONLY_AUTHORITY_SOURCES.includes(source as ContextOnlyAuthoritySource));
  if (contextOnly) {
    return { decision: "REJECT", reasonCode: "AUTHORITY_FROM_UNTRUSTED_MEMORY" };
  }
  return { decision: "HOLD_EXTERNAL_AUTHORITY_VERIFICATION", reasonCode: "EXTERNAL_AUTHORITY_VERIFICATION_REQUIRED" };
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
  const influenceSources = [...new Set(input.influenceSources)];
  if (influenceSources.length === 0 || influenceSources.some((source) => !INFLUENCE_SOURCES.has(source))) {
    throw new Error("FMP authority influence requires recognized influenceSources");
  }
  influenceSources.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  // The record is frozen below; freeze the nested array too so the digested
  // source list cannot be mutated in place after evaluation.
  Object.freeze(influenceSources);

  const { decision, reasonCode } = decideAuthorityInfluence(influenceSources, input.requestedAuthorityChange);

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

function invalidRecord(message: string): never {
  throw new FamiliarValidationError("FMP_INVALID_AUTHORITY_INFLUENCE", message);
}

/**
 * Verifier for a stored or transported FamiliarAuthorityInfluenceV1 record.
 * It re-derives decision/reasonCode from influenceSources and
 * requestedAuthorityChange and recomputes recordDigest, so a record cannot be
 * edited after evaluation (a memory source dropped, REJECT rewritten to HOLD,
 * authorityChanged flipped). A valid record is still only Familiar-side
 * evidence: HOLD_EXTERNAL_AUTHORITY_VERIFICATION is never an admission, and
 * Immaculate remains the authority boundary.
 */
export function assertFamiliarAuthorityInfluenceV1(value: unknown): asserts value is FamiliarAuthorityInfluenceV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalidRecord("record must be an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== RECORD_KEYS.length || keys.some((key, index) => key !== RECORD_KEYS[index])) {
    invalidRecord("record has missing or unexpected fields");
  }
  if (record.schemaVersion !== AUTHORITY_INFLUENCE_SCHEMA) {
    invalidRecord(`schemaVersion must equal ${AUTHORITY_INFLUENCE_SCHEMA}`);
  }
  for (const field of ["tenantId", "familiarId"] as const) {
    const entry = record[field];
    if (typeof entry !== "string" || entry.trim() === "" || entry.trim() !== entry) {
      invalidRecord(`${field} must be a non-empty trimmed string`);
    }
  }
  for (const field of ["identityEpoch", "authorityEpoch"] as const) {
    const entry = record[field];
    if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 0) {
      invalidRecord(`${field} must be a non-negative safe integer`);
    }
  }
  if (!isDigest(record.contextUseReceiptDigest)) {
    invalidRecord("contextUseReceiptDigest must be sha256:<64 lowercase hex>");
  }
  const sources = record.influenceSources;
  if (
    !Array.isArray(sources) ||
    sources.length === 0 ||
    sources.some((source, index) =>
      typeof source !== "string" || !INFLUENCE_SOURCES.has(source) || (index > 0 && !(sources[index - 1] < source)))
  ) {
    invalidRecord("influenceSources must be recognized, unique and sorted");
  }
  const requestedAuthorityChange = record.requestedAuthorityChange as RequestedAuthorityChange;
  if (!REQUESTED_AUTHORITY_CHANGES.has(requestedAuthorityChange)) {
    invalidRecord("requestedAuthorityChange must be recognized");
  }
  if (record.authorityChanged !== false) {
    invalidRecord("authorityChanged must be false");
  }
  if (typeof record.evaluatedAt !== "string" || !isCanonicalTimestamp(record.evaluatedAt)) {
    invalidRecord("evaluatedAt must be a canonical ISO-8601 timestamp");
  }
  const expected = decideAuthorityInfluence(sources as AuthorityInfluenceSource[], requestedAuthorityChange);
  if (record.decision !== expected.decision || record.reasonCode !== expected.reasonCode) {
    throw new FamiliarValidationError(
      "FMP_AUTHORITY_INFLUENCE_DECISION_MISMATCH",
      "decision/reasonCode do not follow from influenceSources and requestedAuthorityChange",
    );
  }
  const { recordDigest, ...body } = record;
  if (!isDigest(recordDigest) || recordDigest !== sha256DigestCanonical(body)) {
    throw new FamiliarValidationError(
      "FMP_AUTHORITY_INFLUENCE_DIGEST_MISMATCH",
      "recordDigest does not match the record body",
    );
  }
}
