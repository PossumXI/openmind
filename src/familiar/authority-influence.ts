import { sha256DomainDigestCanonical } from "./canonicalize.js";
import { FamiliarValidationError, isDigest } from "./validate.js";
import type { Digest } from "./types.js";

export const AUTHORITY_INFLUENCE_SCHEMA = "arobi.familiar-authority-influence.v1" as const;
/**
 * Domain for recordDigest, in the Immaculate canonicalEffectDigest scheme
 * (sha256 over `${domain}\n${canonical JSON}`), so Immaculate evidence lineage
 * can recompute and anchor the digest with its own code.
 */
export const AUTHORITY_INFLUENCE_DIGEST_DOMAIN = "arobi/familiar-authority-influence/v1" as const;

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

function invalidRecord(message: string): never {
  throw new FamiliarValidationError("FMP_INVALID_AUTHORITY_INFLUENCE", message);
}

function nonEmpty(value: string, field: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) invalidRecord(`FMP authority influence requires ${field}`);
  return normalized;
}

function epoch(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    invalidRecord(`FMP authority influence requires non-negative ${field}`);
  }
  return value;
}

function isCanonicalTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function timestamp(value: string): string {
  if (typeof value !== "string" || !isCanonicalTimestamp(value)) {
    invalidRecord("FMP authority influence requires canonical evaluatedAt");
  }
  return value;
}

/**
 * recordDigest of a FamiliarAuthorityInfluenceV1 body (every field except
 * recordDigest). Public and unkeyed: anyone can recompute it, so it identifies
 * a record but does not by itself prove who produced it.
 */
export function familiarAuthorityInfluenceV1Digest(
  body: Omit<FamiliarAuthorityInfluenceV1, "recordDigest">,
): Digest {
  return sha256DomainDigestCanonical(AUTHORITY_INFLUENCE_DIGEST_DOMAIN, body);
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
    invalidRecord("FMP authority influence requires contextUseReceiptDigest");
  }
  if (!REQUESTED_AUTHORITY_CHANGES.has(input.requestedAuthorityChange)) {
    invalidRecord("FMP authority influence requires recognized requestedAuthorityChange");
  }
  if (!Array.isArray(input.influenceSources)) {
    invalidRecord("FMP authority influence requires recognized influenceSources");
  }
  const influenceSources = [...new Set(input.influenceSources)];
  if (influenceSources.length === 0 || influenceSources.some((source) => !INFLUENCE_SOURCES.has(source))) {
    invalidRecord("FMP authority influence requires recognized influenceSources");
  }
  // Default sort compares UTF-16 code units: the same order the verifier checks.
  influenceSources.sort();
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
    recordDigest: familiarAuthorityInfluenceV1Digest(body),
  });
}

export interface AssertFamiliarAuthorityInfluenceOptions {
  /**
   * recordDigest as committed outside the record when it was produced (for
   * example anchored in Immaculate evidence lineage). When supplied, the record
   * must carry exactly this digest.
   */
  expectedRecordDigest?: Digest;
}

/**
 * Structural and decision-table consistency check for a stored or transported
 * FamiliarAuthorityInfluenceV1 record. It proves that the record has exactly
 * the v1 field set with recognized enums, canonical values and
 * `authorityChanged: false`; that decision/reasonCode follow from
 * influenceSources and requestedAuthorityChange; and that recordDigest is the
 * digest of the body it travels with. So an edit that is not resealed, or a
 * reseal that leaves decision and sources disagreeing, is rejected.
 *
 * On its own it is NOT tamper evidence. recordDigest is a public, unkeyed
 * digest, so a record edited consistently (for example sources, decision and
 * reasonCode changed together from a memory-sourced REJECT to an
 * authority-resolution HOLD) and resealed passes. Detecting that needs a
 * commitment held outside the record: pass `options.expectedRecordDigest` and
 * the verifier also requires recordDigest to equal it. A valid record is still
 * only Familiar-side evidence: HOLD_EXTERNAL_AUTHORITY_VERIFICATION is never an
 * admission, and Immaculate remains the authority boundary.
 */
export function assertFamiliarAuthorityInfluenceV1(
  value: unknown,
  options: AssertFamiliarAuthorityInfluenceOptions = {},
): asserts value is FamiliarAuthorityInfluenceV1 {
  const { expectedRecordDigest } = options;
  if (expectedRecordDigest !== undefined && !isDigest(expectedRecordDigest)) {
    invalidRecord("expectedRecordDigest must be sha256:<64 lowercase hex>");
  }
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
  if (
    !isDigest(recordDigest) ||
    recordDigest !== familiarAuthorityInfluenceV1Digest(body as Omit<FamiliarAuthorityInfluenceV1, "recordDigest">)
  ) {
    throw new FamiliarValidationError(
      "FMP_AUTHORITY_INFLUENCE_DIGEST_MISMATCH",
      "recordDigest does not match the record body",
    );
  }
  if (expectedRecordDigest !== undefined && recordDigest !== expectedRecordDigest) {
    throw new FamiliarValidationError(
      "FMP_AUTHORITY_INFLUENCE_COMMITMENT_MISMATCH",
      "recordDigest does not match the externally committed digest",
    );
  }
}
