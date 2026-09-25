import { createHash } from "node:crypto";
import { canonicalizeFamiliarValue, sha256DigestCanonical } from "./canonicalize.js";
import { contextBoundaryAllowsUse, contextUseReceiptV11Digest, type ContextTaintClass, type ContextUseReceiptV11 } from "./context-boundary.js";
import { FamiliarValidationError, isDigest } from "./validate.js";
import type { Digest } from "./types.js";

export const AROBI_ORIGIN_LABEL_V1_SCHEMA = "arobi.origin-label.v1" as const;
export const FAMILIAR_MEMORY_PLANE_EVIDENCE_V1_SCHEMA = "arobi.familiar-memory-plane-evidence.v1" as const;

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
   * honored for a TRUSTED crossing and is recorded as caller-asserted.
   */
  trustedSourceClass?: FamiliarTrustedSourceClass;
}

export interface FamiliarMemoryPlaneEvidenceV1 {
  schemaVersion: typeof FAMILIAR_MEMORY_PLANE_EVIDENCE_V1_SCHEMA;
  contextUseReceiptDigest: Digest;
  parentReceiptDigest: Digest;
  crossedValueDigest: Digest;
  originLabel: ArobiOriginLabelV1;
  originLabelDigest: Digest;
  sourceClassBasis: FamiliarOriginSourceClassBasis;
  boundaryDecision: ContextUseReceiptV11["decision"];
  admissibleForMemorySelection: boolean;
  authorityEpoch: number;
  identityEpoch: number;
  sourceCompartment: string;
  destinationCompartment: string;
  downstreamEffectIds: string[];
  createdAt: string;
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

/** Same normalization as Immaculate memory-security.ts uniqueSorted. */
function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort() as T[];
}

/** Matches Immaculate canonicalEffectDigest(domain, value) for JSON-safe values. */
function arobiDomainDigest(domain: string, value: unknown): Digest {
  const normalized = JSON.parse(JSON.stringify(value));
  const canonical = canonicalizeFamiliarValue(normalized);
  const hex = createHash("sha256").update(`${domain}\n${canonical}`, "utf8").digest("hex");
  return `sha256:${hex}`;
}

function failAdapter(message: string): never {
  throw new FamiliarValidationError("FMP_MEMORY_PLANE_ADAPTER_INVALID", message);
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
 * Mirrors Immaculate validateOriginLabelV1 (apps/harness/src/memory-security.ts)
 * and uses the same reason codes, plus runtime checks on the two enum fields.
 * Returns an empty array when the label is well formed.
 */
export function validateArobiOriginLabelV1(label: ArobiOriginLabelV1): string[] {
  const errors: string[] = [];
  if (label.schemaVersion !== AROBI_ORIGIN_LABEL_V1_SCHEMA) errors.push("unsupported_origin_label_schema");
  if (!ORIGIN_SOURCE_CLASSES.has(label.sourceClass)) errors.push("origin_label_invalid_source_class");
  if (!CONTENT_ACTIVITY_CLASSES.has(label.contentActivityClass)) errors.push("origin_label_invalid_content_activity_class");
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
  } else if (label.parentOriginDigests.some((parent) => !isDigest(parent))) {
    errors.push("origin_label_invalid_parent_digest");
  }
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
  return arobiDomainDigest("arobi/origin-label/v1", {
    ...label,
    parentOriginDigests: uniqueSorted(label.parentOriginDigests),
  });
}

/**
 * Compatibility bridge only. Familiar remains owner of context-compartment
 * isolation; this adapter produces bounded provenance evidence for the Arobi
 * Memory Plane without constructing a second memory store or authority system.
 */
export function adaptFamiliarContextUseToMemoryPlane(
  input: FamiliarMemoryPlaneAdapterInput,
): FamiliarMemoryPlaneEvidenceV1 {
  const { receipt } = input;
  if (receipt.kind !== "arobi.familiar-context-use.v1.1") {
    failAdapter("receipt must be an arobi.familiar-context-use.v1.1 receipt");
  }
  if (!isDigest(receipt.parentReceiptDigest) || !isDigest(receipt.crossedValueDigest)) {
    failAdapter("receipt parentReceiptDigest and crossedValueDigest must be sha256:<64 lowercase hex>");
  }
  const parentOriginDigests = input.parentOriginDigests ?? [];
  if (!Array.isArray(parentOriginDigests) || parentOriginDigests.some((parent) => !isDigest(parent))) {
    failAdapter("parentOriginDigests must be sha256:<64 lowercase hex> digests");
  }
  const { sourceClassBasis, ...mapped } = resolveOrigin(receipt.taintClass, input.trustedSourceClass);
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
  const core = {
    schemaVersion: FAMILIAR_MEMORY_PLANE_EVIDENCE_V1_SCHEMA,
    contextUseReceiptDigest: contextUseReceiptV11Digest(receipt),
    parentReceiptDigest: receipt.parentReceiptDigest,
    crossedValueDigest: receipt.crossedValueDigest,
    originLabel,
    originLabelDigest,
    sourceClassBasis,
    boundaryDecision: receipt.decision,
    admissibleForMemorySelection: contextBoundaryAllowsUse(receipt),
    authorityEpoch: receipt.authorityEpoch,
    identityEpoch: receipt.identityEpoch,
    sourceCompartment: receipt.sourceCompartment,
    destinationCompartment: receipt.destinationCompartment,
    downstreamEffectIds: uniqueSorted(receipt.downstreamEffectIds),
    createdAt: receipt.createdAt,
  };
  return {
    ...core,
    evidenceDigest: sha256DigestCanonical(core),
  };
}

/**
 * Mirrors Immaculate originTransformationIsMonotone
 * (apps/harness/src/memory-security.ts): a transformation may preserve an
 * origin class or degrade it to MODEL_DERIVED / EXTERNAL_UNTRUSTED. It may not
 * silently claim a stronger first-party origin.
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
 * separately verified provenance establishes only MODEL_DERIVED, so it cannot
 * claim SYSTEM_CANONICAL or OPERATOR_TRUSTED; derived/untrusted/active content
 * can never be relabelled as a first-party origin because a model summarized,
 * translated, repeated or agreed with it.
 */
export function familiarTaintCanClaimOrigin(
  taintClass: ContextTaintClass,
  claimed: ArobiOriginSourceClass,
  verifiedTrustedSourceClass?: FamiliarTrustedSourceClass,
): boolean {
  return arobiOriginTransformationIsMonotone(resolveOrigin(taintClass, verifiedTrustedSourceClass).sourceClass, claimed);
}
