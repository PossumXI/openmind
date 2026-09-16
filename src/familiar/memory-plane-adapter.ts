import { sha256DigestCanonical } from "./canonicalize.js";
import { contextBoundaryAllowsUse, contextUseReceiptV11Digest, type ContextTaintClass, type ContextUseReceiptV11 } from "./context-boundary.js";
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
   * trusted caller; the adapter never guesses it from content.
   */
  trustedSourceClass?: Exclude<ArobiOriginSourceClass, "EXTERNAL_UNTRUSTED" | "MODEL_DERIVED">;
}

export interface FamiliarMemoryPlaneEvidenceV1 {
  schemaVersion: typeof FAMILIAR_MEMORY_PLANE_EVIDENCE_V1_SCHEMA;
  contextUseReceiptDigest: Digest;
  parentReceiptDigest: Digest;
  crossedValueDigest: Digest;
  originLabel: ArobiOriginLabelV1;
  originLabelDigest: Digest;
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

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort() as T[];
}

function mapTaintClass(
  taintClass: ContextTaintClass,
  trustedSourceClass?: FamiliarMemoryPlaneAdapterInput["trustedSourceClass"],
): Pick<ArobiOriginLabelV1, "sourceClass" | "contentActivityClass"> {
  switch (taintClass) {
    case "TRUSTED":
      if (!trustedSourceClass) {
        // Fail conservative: Familiar TRUSTED says the boundary accepted a
        // class, but it does not identify which authoritative origin created it.
        return { sourceClass: "MODEL_DERIVED", contentActivityClass: "UNKNOWN" };
      }
      return { sourceClass: trustedSourceClass, contentActivityClass: "PASSIVE" };
    case "DERIVED":
      return { sourceClass: "MODEL_DERIVED", contentActivityClass: "PASSIVE" };
    case "ACTIVE_CONTENT":
      return { sourceClass: "EXTERNAL_UNTRUSTED", contentActivityClass: "ACTIVE" };
    case "EXTERNAL_UNTRUSTED":
      return { sourceClass: "EXTERNAL_UNTRUSTED", contentActivityClass: "PASSIVE" };
    case "UNKNOWN":
    default:
      return { sourceClass: "EXTERNAL_UNTRUSTED", contentActivityClass: "UNKNOWN" };
  }
}

export function arobiOriginLabelV1Digest(label: ArobiOriginLabelV1): Digest {
  return sha256DigestCanonical({
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
  const mapped = mapTaintClass(input.receipt.taintClass, input.trustedSourceClass);
  const originLabel: ArobiOriginLabelV1 = {
    schemaVersion: AROBI_ORIGIN_LABEL_V1_SCHEMA,
    ...mapped,
    ...(input.producerIdentityDigest ? { producerIdentityDigest: input.producerIdentityDigest } : {}),
    tenantScopeDigest: input.tenantScopeDigest,
    trustDomainDigest: input.trustDomainDigest,
    captureMethodDigest: input.captureMethodDigest,
    parentOriginDigests: uniqueSorted(input.parentOriginDigests ?? []),
    propagationPolicyDigest: input.propagationPolicyDigest,
  };
  const originLabelDigest = arobiOriginLabelV1Digest(originLabel);
  const core = {
    schemaVersion: FAMILIAR_MEMORY_PLANE_EVIDENCE_V1_SCHEMA,
    contextUseReceiptDigest: contextUseReceiptV11Digest(input.receipt),
    parentReceiptDigest: input.receipt.parentReceiptDigest,
    crossedValueDigest: input.receipt.crossedValueDigest,
    originLabel,
    originLabelDigest,
    boundaryDecision: input.receipt.decision,
    admissibleForMemorySelection: contextBoundaryAllowsUse(input.receipt),
    authorityEpoch: input.receipt.authorityEpoch,
    identityEpoch: input.receipt.identityEpoch,
    sourceCompartment: input.receipt.sourceCompartment,
    destinationCompartment: input.receipt.destinationCompartment,
    downstreamEffectIds: uniqueSorted(input.receipt.downstreamEffectIds),
    createdAt: input.receipt.createdAt,
  };
  return {
    ...core,
    evidenceDigest: sha256DigestCanonical(core),
  };
}

/**
 * Trust is monotone across the compatibility bridge. Derived/untrusted/active
 * Familiar content cannot be labelled as SYSTEM_CANONICAL or OPERATOR_TRUSTED
 * merely because a model summarized, translated, repeated or agreed with it.
 */
export function familiarTaintCanClaimOrigin(
  taintClass: ContextTaintClass,
  claimed: ArobiOriginSourceClass,
): boolean {
  if (taintClass === "TRUSTED") return true;
  if (taintClass === "DERIVED") return claimed === "MODEL_DERIVED" || claimed === "EXTERNAL_UNTRUSTED";
  return claimed === "EXTERNAL_UNTRUSTED";
}
