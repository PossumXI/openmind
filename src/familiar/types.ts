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

/**
 * FMP v1.2 (additive): the kinds of environment a memory can be bound to. A memory bound to a repository applies in
 * that repository; one bound to a task belongs to that task's working set. Tenant and familiar isolation are not a
 * scope: they stay the canonical, load-bearing filter (INV-FMP-004).
 */
export const FAMILIAR_SCOPE_BINDING_KINDS = [
  "PROJECT",
  "REPOSITORY",
  "APPLICATION",
  "RUNTIME",
  "BRAND",
  "TASK",
] as const;
export type FamiliarScopeBindingKind = (typeof FAMILIAR_SCOPE_BINDING_KINDS)[number];

export interface FamiliarScopeBindingV1 {
  kind: FamiliarScopeBindingKind;
  /** Opaque, stable identity of that environment (a repository id, an application id, a task id). */
  id: string;
}

/** A condition the memory depended on when it was observed: a named fact and the digest of its value then. */
export interface FamiliarScopeDependencyV1 {
  /** e.g. "runtime:node", "dependency:vite", "permission:repository-write". */
  name: string;
  digest: Digest;
}

/**
 * FMP v1.2 (additive): where a memory applies and what it depended on. Absent on unscoped memory, which applies
 * wherever its tenant and familiar do. Captured with the memory and never inferred later.
 */
export interface FamiliarMemoryScopeV1 {
  /** At most one binding per kind. */
  bindings: FamiliarScopeBindingV1[];
  dependencies: FamiliarScopeDependencyV1[];
  observedAt: string;
}

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
  /** FMP v1.2 (additive): where this memory applies and what it depended on when observed. */
  scope?: FamiliarMemoryScopeV1;
  /** FMP v1.3 (additive): links the writer recorded when this memory was written. Never inferred from its content. */
  links?: FamiliarMemoryLinksV1;
}

/**
 * FMP v1.3: what a memory was explicitly linked to when it was written. Diffusion reads these as RELATION and
 * EPISODE links; nothing here is guessed from text, and a link never carries authority.
 */
export interface FamiliarMemoryLinksV1 {
  /** Memories a person or the writing surface explicitly related to this one, by artifact digest. */
  related?: Digest[];
  /** The episode this memory was written in: one conversation, task or session, by its id. */
  episode?: string;
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
