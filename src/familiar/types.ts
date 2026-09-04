export type Digest = `sha256:${string}`;

export const FAMILIAR_MEMORY_CLASSES = [
  "EPISODIC",
  "CORE",
  "PREFERENCE",
  "RELATIONSHIP",
  "PROCEDURAL",
  "SKILL",
  "EVIDENCE",
  "HYPOTHESIS",
  "EXTERNAL_OBSERVATION",
  "AUTHORITY_REFERENCE",
] as const;
export type FamiliarMemoryClass = (typeof FAMILIAR_MEMORY_CLASSES)[number];

export const MEMORY_TRUST_CLASSES = [
  "OPERATOR_AUTHORED",
  "VERIFIED_SYSTEM",
  "OBSERVED",
  "DERIVED",
  "EXTERNAL_UNTRUSTED",
] as const;
export type MemoryTrustClass = (typeof MEMORY_TRUST_CLASSES)[number];

export const MEMORY_SUPPORT_STATES = [
  "ASSERTED",
  "OBSERVED",
  "CORROBORATED",
  "CONTESTED",
  "SUPERSEDED",
  "QUARANTINED",
  "FORGOTTEN",
] as const;
export type MemorySupportState = (typeof MEMORY_SUPPORT_STATES)[number];

export const MEMORY_MUTATION_OPERATIONS = [
  "CREATE",
  "PROMOTE",
  "CORRECT",
  "MERGE",
  "SUPERSEDE",
  "REVOKE",
  "QUARANTINE",
  "FORGET",
] as const;
export type MemoryMutationOperation = (typeof MEMORY_MUTATION_OPERATIONS)[number];

export type ControlledErasureState =
  | "VERIFIED"
  | "FAILED"
  | "NOT_APPLICABLE"
  | "OUTSIDE_CONTROL";

export interface FamiliarManifestV1 {
  kind: "arobi.familiar-manifest";
  version: 1;
  manifestId: string;
  familiarId: string;
  tenantId: string;
  principalBinding: string;
  genesisDigest: Digest;
  identityEpoch: number;
  constitutionDigest: Digest;
  personalityDigest: Digest;
  memoryRoot: Digest;
  coreMemoryRoot: Digest;
  skillRoot: Digest;
  policyEpoch: number;
  authorityEpoch: number;
  previousContinuityDigest?: Digest;
  createdAt: string;
  signatureRef?: string;
}

export interface FamiliarMemoryArtifactV1 {
  kind: "arobi.familiar-memory";
  version: 1;
  memoryId: string;
  familiarId: string;
  tenantId: string;
  identityEpoch: number;
  memoryClass: FamiliarMemoryClass;
  contentDigest: Digest;
  encryptedPayloadRef?: string;
  originLabelDigest: Digest;
  sourceArtifacts: Digest[];
  transformationChain: Digest[];
  trustClass: MemoryTrustClass;
  supportState: MemorySupportState;
  mayInform: boolean;
  /** Structural safety invariant: memory is never live execution authority. */
  mayAuthorize: false;
  revision: number;
  previousDigest?: Digest;
  supersededBy?: Digest;
  createdAt: string;
  expiresAt?: string;
}

export interface MemoryMutationReceiptV1 {
  kind: "arobi.familiar-memory-mutation";
  version: 1;
  mutationId: string;
  familiarId: string;
  tenantId: string;
  identityEpoch: number;
  operation: MemoryMutationOperation;
  actorRef: string;
  reasonDigest: Digest;
  policyEpoch: number;
  previousDigests: Digest[];
  nextDigest?: Digest;
  evidenceDigests: Digest[];
  createdAt: string;
}

export interface ContextUseReceiptV1 {
  kind: "arobi.familiar-context-use";
  version: 1;
  receiptId: string;
  familiarId: string;
  tenantId: string;
  identityEpoch: number;
  purposeDigest: Digest;
  retrieved: Digest[];
  opened: Digest[];
  reliedUpon: Digest[];
  rejectedOrConflicting: Digest[];
  proposalDigest: Digest;
  familiarContinuityDigest: Digest;
  createdAt: string;
}

export interface FamiliarContinuityAttestationV1 {
  kind: "arobi.familiar-continuity";
  version: 1;
  attestationId: string;
  familiarId: string;
  tenantId: string;
  identityEpoch: number;
  memoryRoot: Digest;
  coreMemoryRoot: Digest;
  modelDigest: Digest;
  runtimeDigest: Digest;
  policyEpoch: number;
  authorityEpoch: number;
  toolCapabilityDigest: Digest;
  previousContinuityDigest?: Digest;
  createdAt: string;
  signatureRef?: string;
}

export interface ControlledErasureSurfaceV1 {
  surface:
    | "CANONICAL_PAYLOAD"
    | "EMBEDDING_INDEX"
    | "GRAPH_PROJECTION"
    | "SUMMARY_PROJECTION"
    | "LIVE_CACHE"
    | string;
  state: ControlledErasureState;
  verificationDigest?: Digest;
  detail?: string;
}

export interface MemoryTombstoneReceiptV1 {
  kind: "arobi.familiar-memory-tombstone";
  version: 1;
  tombstoneId: string;
  memoryId: string;
  forgottenDigest: Digest;
  familiarId: string;
  tenantId: string;
  identityEpoch: number;
  mutationReceiptDigest: Digest;
  surfaces: ControlledErasureSurfaceV1[];
  invalidatedDerivedDigests: Digest[];
  createdAt: string;
}

export interface FamiliarCapsuleV1 {
  kind: "arobi.familiar-capsule";
  version: 1;
  capsuleId: string;
  familiarId: string;
  tenantId: string;
  identityEpoch: number;
  manifestDigest: Digest;
  continuityDigest: Digest;
  selectedMemoryDigests: Digest[];
  selectedSkillDigests: Digest[];
  privacyConstraintDigests: Digest[];
  provenanceDigests: Digest[];
  /** Identity/memory can move; execution authority cannot. */
  authorityPortable: false;
  createdAt: string;
}
