import { sha256DomainDigestCanonical } from "./canonicalize.js";
import {
  contextUseReceiptV11Digest,
  deriveContextBoundaryDecision,
  type ContextBoundaryDecisionFacts,
  type ContextTaintClass,
  type ContextUseReceiptV11,
} from "./context-boundary.js";
import { FamiliarValidationError, isDigest } from "./validate.js";
import type { Digest } from "./types.js";

export const AROBI_ORIGIN_LABEL_V1_SCHEMA = "arobi.origin-label.v1" as const;
export const FAMILIAR_MEMORY_PLANE_EVIDENCE_V1_SCHEMA = "arobi.familiar-memory-plane-evidence.v1" as const;
/** Same domain as Immaculate originLabelV1Digest. */
export const AROBI_ORIGIN_LABEL_V1_DIGEST_DOMAIN = "arobi/origin-label/v1" as const;
export const FAMILIAR_MEMORY_PLANE_EVIDENCE_V1_DIGEST_DOMAIN = "arobi/familiar-memory-plane-evidence/v1" as const;

/**
 * Upper bounds on the receipt metadata the adapter copies into evidence. A
 * receipt that exceeds any bound is refused (FMP_MEMORY_PLANE_ADAPTER_INVALID)
 * rather than truncated. Identifier characters follow Immaculate's SAFE_ID_RE
 * (authority-session-binding.ts), so free text cannot ride along as an id.
 */
export const FAMILIAR_MEMORY_PLANE_EVIDENCE_LIMITS = Object.freeze({
  maxCompartmentLength: 64,
  maxEffectIdLength: 256,
  maxDownstreamEffectIds: 64,
  maxParentOriginDigests: 64,
  maxTimestampLength: 64,
});

const SAFE_ID_CHARS = "[A-Za-z0-9._:@/+-]";
const COMPARTMENT_RE = new RegExp(`^${SAFE_ID_CHARS}{1,${FAMILIAR_MEMORY_PLANE_EVIDENCE_LIMITS.maxCompartmentLength}}$`);
const EFFECT_ID_RE = new RegExp(`^${SAFE_ID_CHARS}{1,${FAMILIAR_MEMORY_PLANE_EVIDENCE_LIMITS.maxEffectIdLength}}$`);

export type ArobiOriginSourceClass =
  | "SYSTEM_CANONICAL"
  | "OPERATOR_TRUSTED"
  | "USER_CONTROLLED"
  | "TOOL_OBSERVED"
  | "EXTERNAL_UNTRUSTED"
  | "MODEL_DERIVED";

export type ArobiContentActivityClass = "PASSIVE" | "ACTIVE" | "UNKNOWN";

/**
 * Where the evidence record's origin sourceClass came from:
 * - FAMILIAR_TAINT_MAPPING: derived conservatively from the Familiar boundary
 *   taint class alone;
 * - CALLER_ASSERTED_PROVENANCE: a caller supplied `trustedSourceClass` for a
 *   TRUSTED crossing. The adapter cannot verify that provenance; consumers
 *   (Memory Plane admission, Immaculate) must resolve it from their own state.
 */
export type FamiliarOriginSourceClassBasis = "FAMILIAR_TAINT_MAPPING" | "CALLER_ASSERTED_PROVENANCE";

export type FamiliarTrustedSourceClass = Exclude<ArobiOriginSourceClass, "EXTERNAL_UNTRUSTED" | "MODEL_DERIVED">;

export interface ArobiOriginLabelV1 {
  schemaVersion: typeof AROBI_ORIGIN_LABEL_V1_SCHEMA;
  sourceClass: ArobiOriginSourceClass;
  contentActivityClass: ArobiContentActivityClass;
  producerIdentityDigest?: Digest;
  tenantScopeDigest: Digest;
  trustDomainDigest: Digest;
  captureMethodDigest: Digest;
  parentOriginDigests: Digest[];
  propagationPolicyDigest: Digest;
}

export interface FamiliarMemoryPlaneAdapterInput {
  receipt: ContextUseReceiptV11;
  tenantScopeDigest: Digest;
  trustDomainDigest: Digest;
  captureMethodDigest: Digest;
  propagationPolicyDigest: Digest;
  parentOriginDigests?: readonly Digest[];
  producerIdentityDigest?: Digest;
  /**
   * TRUSTED is a Familiar boundary taint class, not a complete Arobi source
   * provenance class. A stronger source class must therefore be supplied by a
   * trusted caller; the adapter never guesses it from content. It is only
   * honored for a TRUSTED crossing, requires `producerIdentityDigest` (so the
   * first-party label names the producer it is asserted for), and is recorded
   * as CALLER_ASSERTED_PROVENANCE.
   */
  trustedSourceClass?: FamiliarTrustedSourceClass;
  /**
   * Canonical ISO-8601 instant at which admissibility is evaluated. Defaults to
   * the current time. A receipt whose freshUntil is before this instant is not
   * admissible for memory selection.
   */
  evaluatedAt?: string;
  /**
   * Digest of the receipt as committed outside this call (stored or signed when
   * the receipt was built). When supplied, a receipt whose recomputed
   * contextUseReceiptV11Digest differs is refused. Without it the adapter can
   * only check the receipt against itself: sanitizer/validator statuses cannot
   * be recomputed here, so a receipt edited consistently (statuses and decision
   * together) is indistinguishable from an original.
   */
  expectedContextUseReceiptDigest?: Digest;
}

/**
 * Bridge evidence only. `originLabel` / `originLabelDigest` must not be
 * forwarded without `sourceClassBasis`: OriginLabelV1 has no field for the
 * basis, so once separated from this envelope a caller-asserted
 * SYSTEM_CANONICAL/OPERATOR_TRUSTED label is indistinguishable from a natively
 * resolved one.
 */
export interface FamiliarMemoryPlaneEvidenceV1 {
  schemaVersion: typeof FAMILIAR_MEMORY_PLANE_EVIDENCE_V1_SCHEMA;
  contextUseReceiptDigest: Digest;
  parentReceiptDigest: Digest;
  crossedValueDigest: Digest;
  originLabel: ArobiOriginLabelV1;
  originLabelDigest: Digest;
  sourceClassBasis: FamiliarOriginSourceClassBasis;
  boundaryDecision: ContextUseReceiptV11["decision"];
  /**
   * True only if, at `evaluatedAt`, the receipt is fresh and its decision
   * re-derived from its own fields under the high-risk rules is
   * ALLOW_SCHEMA_VALIDATED (see adaptFamiliarContextUseToMemoryPlane).
   */
  admissibleForMemorySelection: boolean;
  authorityEpoch: number;
  identityEpoch: number;
  sourceCompartment: string;
  destinationCompartment: string;
  downstreamEffectIds: string[];
  createdAt: string;
  freshUntil: string;
  evaluatedAt: string;
  evidenceDigest: Digest;
}

const ORIGIN_SOURCE_CLASSES: ReadonlySet<string> = new Set<ArobiOriginSourceClass>([
  "SYSTEM_CANONICAL",
  "OPERATOR_TRUSTED",
  "USER_CONTROLLED",
  "TOOL_OBSERVED",
  "EXTERNAL_UNTRUSTED",
  "MODEL_DERIVED",
]);

const CONTENT_ACTIVITY_CLASSES: ReadonlySet<string> = new Set<ArobiContentActivityClass>(["PASSIVE", "ACTIVE", "UNKNOWN"]);

const TRUSTED_SOURCE_CLASSES: ReadonlySet<string> = new Set<FamiliarTrustedSourceClass>([
  "SYSTEM_CANONICAL",
  "OPERATOR_TRUSTED",
  "USER_CONTROLLED",
  "TOOL_OBSERVED",
]);

const TAINT_CLASSES: ReadonlySet<string> = new Set<ContextTaintClass>([
  "TRUSTED",
  "DERIVED",
  "EXTERNAL_UNTRUSTED",
  "ACTIVE_CONTENT",
  "UNKNOWN",
]);

const PROCESSOR_STATUSES: ReadonlySet<string> = new Set(["VALID", "INVALID", "UNVERIFIED"]);

const ORIGIN_LABEL_KEYS: ReadonlySet<string> = new Set<keyof ArobiOriginLabelV1>([
  "schemaVersion",
  "sourceClass",
  "contentActivityClass",
  "producerIdentityDigest",
  "tenantScopeDigest",
  "trustDomainDigest",
  "captureMethodDigest",
  "parentOriginDigests",
  "propagationPolicyDigest",
]);

/** Same normalization as Immaculate memory-security.ts uniqueSorted. */
function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort() as T[];
}

function failAdapter(message: string): never {
  throw new FamiliarValidationError("FMP_MEMORY_PLANE_ADAPTER_INVALID", message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Resolves the origin class a Familiar crossing may claim on its own. TRUSTED
 * without caller provenance degrades to MODEL_DERIVED/UNKNOWN; a caller-supplied
 * trustedSourceClass is honored only for TRUSTED and must be a recognized
 * first-party class.
 */
function resolveOrigin(
  taintClass: ContextTaintClass,
  trustedSourceClass: FamiliarTrustedSourceClass | undefined,
): Pick<ArobiOriginLabelV1, "sourceClass" | "contentActivityClass"> & { sourceClassBasis: FamiliarOriginSourceClassBasis } {
  if (trustedSourceClass !== undefined) {
    if (!TRUSTED_SOURCE_CLASSES.has(trustedSourceClass)) {
      failAdapter("trustedSourceClass must be a recognized first-party origin class");
    }
    if (taintClass !== "TRUSTED") {
      failAdapter("trustedSourceClass is only honored for a TRUSTED context crossing");
    }
    return { sourceClass: trustedSourceClass, contentActivityClass: "PASSIVE", sourceClassBasis: "CALLER_ASSERTED_PROVENANCE" };
  }
  switch (taintClass) {
    case "TRUSTED":
      // Fail conservative: Familiar TRUSTED says the boundary accepted a
      // class, but it does not identify which authoritative origin created it.
      return { sourceClass: "MODEL_DERIVED", contentActivityClass: "UNKNOWN", sourceClassBasis: "FAMILIAR_TAINT_MAPPING" };
    case "DERIVED":
      return { sourceClass: "MODEL_DERIVED", contentActivityClass: "PASSIVE", sourceClassBasis: "FAMILIAR_TAINT_MAPPING" };
    case "ACTIVE_CONTENT":
      return { sourceClass: "EXTERNAL_UNTRUSTED", contentActivityClass: "ACTIVE", sourceClassBasis: "FAMILIAR_TAINT_MAPPING" };
    case "EXTERNAL_UNTRUSTED":
      return { sourceClass: "EXTERNAL_UNTRUSTED", contentActivityClass: "PASSIVE", sourceClassBasis: "FAMILIAR_TAINT_MAPPING" };
    case "UNKNOWN":
    default:
      return { sourceClass: "EXTERNAL_UNTRUSTED", contentActivityClass: "UNKNOWN", sourceClassBasis: "FAMILIAR_TAINT_MAPPING" };
  }
}

/**
 * Mirrors Immaculate validateOriginLabelV1 (apps/harness/src/memory-security.ts):
 * the same reason codes in the same order, including one
 * `origin_label_invalid_parent_digest` per malformed parent. Familiar-only
 * additions are appended after those codes and Immaculate does not emit them:
 * `origin_label_invalid_source_class`, `origin_label_invalid_content_activity_class`
 * and `origin_label_unexpected_field` (a key outside the OriginLabelV1 field
 * set; Immaculate digests such a label, Familiar refuses it). A non-object label
 * yields only `origin_label_not_object`, and a non-array parentOriginDigests one
 * parent code (Immaculate would throw or iterate a string). Returns an empty
 * array when the label is well formed.
 */
export function validateArobiOriginLabelV1(label: ArobiOriginLabelV1): string[] {
  if (!isPlainObject(label)) return ["origin_label_not_object"];
  const errors: string[] = [];
  if (label.schemaVersion !== AROBI_ORIGIN_LABEL_V1_SCHEMA) errors.push("unsupported_origin_label_schema");
  for (const [name, value] of [
    ["tenant_scope_digest", label.tenantScopeDigest],
    ["trust_domain_digest", label.trustDomainDigest],
    ["capture_method_digest", label.captureMethodDigest],
    ["propagation_policy_digest", label.propagationPolicyDigest],
  ] as const) {
    if (!isDigest(value)) errors.push(`origin_label_invalid_${name}`);
  }
  if (label.producerIdentityDigest !== undefined && !isDigest(label.producerIdentityDigest)) {
    errors.push("origin_label_invalid_producer_identity_digest");
  }
  if (!Array.isArray(label.parentOriginDigests)) {
    errors.push("origin_label_invalid_parent_digest");
  } else {
    for (const parent of label.parentOriginDigests) {
      if (!isDigest(parent)) errors.push("origin_label_invalid_parent_digest");
    }
  }
  if (!ORIGIN_SOURCE_CLASSES.has(label.sourceClass)) errors.push("origin_label_invalid_source_class");
  if (!CONTENT_ACTIVITY_CLASSES.has(label.contentActivityClass)) errors.push("origin_label_invalid_content_activity_class");
  if (Object.keys(label).some((key) => !ORIGIN_LABEL_KEYS.has(key))) errors.push("origin_label_unexpected_field");
  return errors;
}

/**
 * Domain-separated `arobi/origin-label/v1` digest. For every label that passes
 * validateArobiOriginLabelV1 this is byte-identical to Immaculate
 * originLabelV1Digest; malformed labels fail closed instead of being digested.
 */
export function arobiOriginLabelV1Digest(label: ArobiOriginLabelV1): Digest {
  const errors = validateArobiOriginLabelV1(label);
  if (errors.length > 0) {
    throw new FamiliarValidationError("FMP_INVALID_ORIGIN_LABEL", errors.join(","));
  }
  return sha256DomainDigestCanonical(AROBI_ORIGIN_LABEL_V1_DIGEST_DOMAIN, {
    ...label,
    parentOriginDigests: uniqueSorted(label.parentOriginDigests),
  });
}

function boundedTimestamp(value: unknown, field: string): number {
  if (typeof value !== "string" || value.length > FAMILIAR_MEMORY_PLANE_EVIDENCE_LIMITS.maxTimestampLength) {
    failAdapter(`${field} must be a timestamp string of at most ${FAMILIAR_MEMORY_PLANE_EVIDENCE_LIMITS.maxTimestampLength} characters`);
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time)) failAdapter(`${field} must be a valid timestamp`);
  return time;
}

function canonicalInstant(value: string): number {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    failAdapter("evaluatedAt must be a canonical ISO-8601 timestamp");
  }
  return time;
}

/**
 * Structural checks on a receipt the adapter did not build. Everything copied
 * into evidence is a digest, an enum, a safe integer, or an identifier /
 * timestamp within FAMILIAR_MEMORY_PLANE_EVIDENCE_LIMITS. Returns the decision
 * facts the receipt persists (everything but highRiskPath).
 */
function assertAdaptableReceipt(receipt: ContextUseReceiptV11): Omit<ContextBoundaryDecisionFacts, "highRiskPath"> {
  if (!isPlainObject(receipt) || receipt.kind !== "arobi.familiar-context-use.v1.1") {
    failAdapter("receipt must be an arobi.familiar-context-use.v1.1 receipt");
  }
  if (!isDigest(receipt.parentReceiptDigest) || !isDigest(receipt.crossedValueDigest)) {
    failAdapter("receipt parentReceiptDigest and crossedValueDigest must be sha256:<64 lowercase hex>");
  }
  for (const field of ["authorityEpoch", "identityEpoch"] as const) {
    if (!Number.isSafeInteger(receipt[field]) || receipt[field] < 0) {
      failAdapter(`receipt ${field} must be a non-negative safe integer`);
    }
  }
  if (!TAINT_CLASSES.has(receipt.taintClass)) failAdapter("receipt taintClass must be recognized");
  if (typeof receipt.rawContentCrossed !== "boolean") failAdapter("receipt rawContentCrossed must be a boolean");
  if (!isPlainObject(receipt.sanitizer) || !PROCESSOR_STATUSES.has(receipt.sanitizer.status) ||
    !isPlainObject(receipt.validator) || !PROCESSOR_STATUSES.has(receipt.validator.status)) {
    failAdapter("receipt sanitizer and validator must carry a recognized status");
  }
  for (const field of ["sourceCompartment", "destinationCompartment"] as const) {
    if (typeof receipt[field] !== "string" || !COMPARTMENT_RE.test(receipt[field])) {
      failAdapter(`receipt ${field} must be an identifier of at most ${FAMILIAR_MEMORY_PLANE_EVIDENCE_LIMITS.maxCompartmentLength} characters`);
    }
  }
  const effectIds: unknown = receipt.downstreamEffectIds;
  if (
    !Array.isArray(effectIds) ||
    effectIds.length > FAMILIAR_MEMORY_PLANE_EVIDENCE_LIMITS.maxDownstreamEffectIds ||
    effectIds.some((id) => typeof id !== "string" || !EFFECT_ID_RE.test(id))
  ) {
    failAdapter(
      `receipt downstreamEffectIds must be at most ${FAMILIAR_MEMORY_PLANE_EVIDENCE_LIMITS.maxDownstreamEffectIds} identifiers ` +
      `of at most ${FAMILIAR_MEMORY_PLANE_EVIDENCE_LIMITS.maxEffectIdLength} characters`,
    );
  }
  return {
    createdAtMs: boundedTimestamp(receipt.createdAt, "receipt createdAt"),
    freshUntilMs: boundedTimestamp(receipt.freshUntil, "receipt freshUntil"),
    rawContentCrossed: receipt.rawContentCrossed,
    sanitizerStatus: receipt.sanitizer.status,
    validatorStatus: receipt.validator.status,
    destinationCompartment: receipt.destinationCompartment,
    taintClass: receipt.taintClass,
  };
}

/**
 * Compatibility bridge only. Familiar remains owner of context-compartment
 * isolation; this adapter produces bounded provenance evidence for the Arobi
 * Memory Plane without constructing a second memory store or authority system.
 *
 * The receipt's decision is not taken on trust. It is re-derived from the
 * receipt's own fields with the builder's decision table, once for a high-risk
 * and once for a low-risk path (highRiskPath is not persisted). A decision that
 * matches neither is refused. `admissibleForMemorySelection` requires the
 * high-risk derivation to be ALLOW_SCHEMA_VALIDATED (so untrusted or active
 * content bound for PARENT_AGENT, or raw crossed content, is never admissible
 * even if the original path was low-risk) and freshUntil not before
 * `evaluatedAt`. The high-risk ALLOW also implies the receipt's own decision is
 * ALLOW with verified processors and no raw crossing (contextBoundaryAllowsUse).
 * Processor statuses themselves cannot be recomputed; bind them with
 * `expectedContextUseReceiptDigest`.
 */
export function adaptFamiliarContextUseToMemoryPlane(
  input: FamiliarMemoryPlaneAdapterInput,
): FamiliarMemoryPlaneEvidenceV1 {
  const { receipt } = input;
  const facts = assertAdaptableReceipt(receipt);
  let contextUseReceiptDigest: Digest;
  try {
    contextUseReceiptDigest = contextUseReceiptV11Digest(receipt);
  } catch (error) {
    failAdapter(`receipt is not canonicalizable: ${(error as Error).message}`);
  }
  if (input.expectedContextUseReceiptDigest !== undefined) {
    if (!isDigest(input.expectedContextUseReceiptDigest)) {
      failAdapter("expectedContextUseReceiptDigest must be sha256:<64 lowercase hex>");
    }
    if (input.expectedContextUseReceiptDigest !== contextUseReceiptDigest) {
      throw new FamiliarValidationError(
        "FMP_MEMORY_PLANE_RECEIPT_COMMITMENT_MISMATCH",
        "receipt does not match the externally committed contextUseReceiptDigest",
      );
    }
  }
  const evaluatedAt = input.evaluatedAt ?? new Date().toISOString();
  const evaluatedAtMs = canonicalInstant(evaluatedAt);

  const parentOriginDigests = input.parentOriginDigests ?? [];
  if (
    !Array.isArray(parentOriginDigests) ||
    parentOriginDigests.length > FAMILIAR_MEMORY_PLANE_EVIDENCE_LIMITS.maxParentOriginDigests ||
    parentOriginDigests.some((parent) => !isDigest(parent))
  ) {
    failAdapter(
      `parentOriginDigests must be at most ${FAMILIAR_MEMORY_PLANE_EVIDENCE_LIMITS.maxParentOriginDigests} ` +
      "sha256:<64 lowercase hex> digests",
    );
  }
  const { sourceClassBasis, ...mapped } = resolveOrigin(receipt.taintClass, input.trustedSourceClass);
  if (sourceClassBasis === "CALLER_ASSERTED_PROVENANCE" && input.producerIdentityDigest === undefined) {
    failAdapter("trustedSourceClass requires producerIdentityDigest for the asserted first-party producer");
  }
  const originLabel: ArobiOriginLabelV1 = {
    schemaVersion: AROBI_ORIGIN_LABEL_V1_SCHEMA,
    ...mapped,
    ...(input.producerIdentityDigest !== undefined ? { producerIdentityDigest: input.producerIdentityDigest } : {}),
    tenantScopeDigest: input.tenantScopeDigest,
    trustDomainDigest: input.trustDomainDigest,
    captureMethodDigest: input.captureMethodDigest,
    parentOriginDigests: uniqueSorted(parentOriginDigests),
    propagationPolicyDigest: input.propagationPolicyDigest,
  };
  // Fails closed (FMP_INVALID_ORIGIN_LABEL) on any non-digest label field.
  const originLabelDigest = arobiOriginLabelV1Digest(originLabel);

  const highRisk = deriveContextBoundaryDecision({ ...facts, highRiskPath: true }).decision;
  const lowRisk = deriveContextBoundaryDecision({ ...facts, highRiskPath: false }).decision;
  if (receipt.decision !== highRisk && receipt.decision !== lowRisk) {
    throw new FamiliarValidationError(
      "FMP_MEMORY_PLANE_RECEIPT_DECISION_MISMATCH",
      "receipt decision does not follow from its own boundary fields",
    );
  }

  const core = {
    schemaVersion: FAMILIAR_MEMORY_PLANE_EVIDENCE_V1_SCHEMA,
    contextUseReceiptDigest,
    parentReceiptDigest: receipt.parentReceiptDigest,
    crossedValueDigest: receipt.crossedValueDigest,
    originLabel,
    originLabelDigest,
    sourceClassBasis,
    boundaryDecision: receipt.decision,
    admissibleForMemorySelection: highRisk === "ALLOW_SCHEMA_VALIDATED" && facts.freshUntilMs >= evaluatedAtMs,
    authorityEpoch: receipt.authorityEpoch,
    identityEpoch: receipt.identityEpoch,
    sourceCompartment: receipt.sourceCompartment,
    destinationCompartment: receipt.destinationCompartment,
    downstreamEffectIds: uniqueSorted(receipt.downstreamEffectIds),
    createdAt: receipt.createdAt,
    freshUntil: receipt.freshUntil,
    evaluatedAt,
  };
  return {
    ...core,
    evidenceDigest: sha256DomainDigestCanonical(FAMILIAR_MEMORY_PLANE_EVIDENCE_V1_DIGEST_DOMAIN, core),
  };
}

/**
 * Mirrors Immaculate originTransformationIsMonotone
 * (apps/harness/src/memory-security.ts): a transformation may preserve an
 * origin class or degrade it to MODEL_DERIVED / EXTERNAL_UNTRUSTED. It may not
 * silently claim a stronger first-party origin. Content activity class is not
 * part of this rule (Immaculate's rule has no activity dimension either).
 */
export function arobiOriginTransformationIsMonotone(
  input: ArobiOriginSourceClass,
  output: ArobiOriginSourceClass,
): boolean {
  return output === input || output === "MODEL_DERIVED" || output === "EXTERNAL_UNTRUSTED";
}

/**
 * Trust is monotone across the compatibility bridge. The origin a Familiar
 * crossing establishes on its own (see resolveOrigin) is the transformation
 * input; the claimed class must be a monotone output of it. TRUSTED without
 * caller provenance establishes only MODEL_DERIVED, so it cannot claim
 * SYSTEM_CANONICAL or OPERATOR_TRUSTED; derived/untrusted/active content can
 * never be relabelled as a first-party origin because a model summarized,
 * translated, repeated or agreed with it.
 *
 * `callerAssertedSourceClass` is taken as given: this helper does not verify
 * provenance, so ("TRUSTED", "SYSTEM_CANONICAL", "SYSTEM_CANONICAL") is true.
 * Only pass a class that the caller resolved from its own authoritative state.
 */
export function familiarTaintCanClaimOrigin(
  taintClass: ContextTaintClass,
  claimed: ArobiOriginSourceClass,
  callerAssertedSourceClass?: FamiliarTrustedSourceClass,
): boolean {
  return arobiOriginTransformationIsMonotone(resolveOrigin(taintClass, callerAssertedSourceClass).sourceClass, claimed);
}
