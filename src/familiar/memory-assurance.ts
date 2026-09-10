import { sha256DigestCanonical } from "./canonicalize.js";
import { isDigest } from "./validate.js";
import type { Digest } from "./types.js";

export type MemoryInfluenceVerdict = "BOUNDED" | "UNBOUNDED" | "INCONCLUSIVE";

export interface MemoryWriteAttestationV1 {
  kind: "arobi.familiar-memory-write-attestation";
  version: 1;
  memoryId: string;
  memoryDigest: Digest;
  sourceOriginDigest: Digest;
  authorPrincipal: string;
  authorityEpoch: number;
  contextBoundaryReceiptDigest: Digest;
  sanitizerReceiptDigest: Digest;
  createdAt: string;
  validUntil?: string;
  signer: string;
  attestationDigest: Digest;
  signature: string;
}

export interface MemoryInfluenceReceiptV1 {
  kind: "arobi.familiar-memory-influence";
  version: 1;
  retrievalId: string;
  retrievedMemoryRoot: Digest;
  acceptedMemoryRoot: Digest;
  rejectedMemoryRoot: Digest;
  authorityEpoch: number;
  retrievalPolicyDigest: Digest;
  contextUseReceiptDigest: Digest;
  perturbationChallengeDigest?: Digest;
  deniedIntentFingerprintDigest?: Digest;
  influenceVerdict: MemoryInfluenceVerdict;
  verifierDigest: Digest;
  createdAt: string;
  receiptDigest: Digest;
}

export type MemoryWriteSigner = (input: {
  digest: Digest;
  signer: string;
}) => Promise<string> | string;

export type MemoryWriteSignatureVerifier = (input: {
  digest: Digest;
  signer: string;
  signature: string;
}) => Promise<boolean> | boolean;

function nonEmpty(value: string, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`);
  return value.trim();
}

function digest(value: Digest, label: string): Digest {
  if (!isDigest(value)) throw new Error(`${label} must be sha256:<64 lowercase hex>`);
  return value;
}

function epoch(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("authorityEpoch must be a non-negative safe integer");
  return value;
}

function timestamp(value: string, label: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${label} must be an ISO-8601 timestamp`);
  return value;
}

function memoryWriteCore(input: Omit<MemoryWriteAttestationV1, "attestationDigest" | "signature">): Omit<MemoryWriteAttestationV1, "attestationDigest" | "signature"> {
  return {
    kind: "arobi.familiar-memory-write-attestation",
    version: 1,
    memoryId: nonEmpty(input.memoryId, "memoryId"),
    memoryDigest: digest(input.memoryDigest, "memoryDigest"),
    sourceOriginDigest: digest(input.sourceOriginDigest, "sourceOriginDigest"),
    authorPrincipal: nonEmpty(input.authorPrincipal, "authorPrincipal"),
    authorityEpoch: epoch(input.authorityEpoch),
    contextBoundaryReceiptDigest: digest(input.contextBoundaryReceiptDigest, "contextBoundaryReceiptDigest"),
    sanitizerReceiptDigest: digest(input.sanitizerReceiptDigest, "sanitizerReceiptDigest"),
    createdAt: timestamp(input.createdAt, "createdAt"),
    ...(input.validUntil ? { validUntil: timestamp(input.validUntil, "validUntil") } : {}),
    signer: nonEmpty(input.signer, "signer")
  };
}

/**
 * Creates a signed provenance statement over digests only. The signing implementation is injected
 * so FMP cannot silently substitute an LLM assertion for a cryptographic signature.
 */
export async function buildMemoryWriteAttestation(
  input: Omit<MemoryWriteAttestationV1, "kind" | "version" | "attestationDigest" | "signature">,
  sign: MemoryWriteSigner
): Promise<MemoryWriteAttestationV1> {
  const core = memoryWriteCore({
    kind: "arobi.familiar-memory-write-attestation",
    version: 1,
    ...input
  });
  if (core.validUntil && Date.parse(core.validUntil) <= Date.parse(core.createdAt)) {
    throw new Error("validUntil must be later than createdAt");
  }
  const attestationDigest = sha256DigestCanonical(core);
  const signature = nonEmpty(await sign({ digest: attestationDigest, signer: core.signer }), "signature");
  return { ...core, attestationDigest, signature };
}

export async function verifyMemoryWriteAttestation(
  attestation: MemoryWriteAttestationV1,
  options: {
    expectedAuthorityEpoch?: number;
    now?: Date;
    verifySignature: MemoryWriteSignatureVerifier;
  }
): Promise<{ valid: boolean; reasons: string[]; recomputedDigest: Digest }> {
  const reasons: string[] = [];
  let core: Omit<MemoryWriteAttestationV1, "attestationDigest" | "signature">;
  try {
    if (attestation.kind !== "arobi.familiar-memory-write-attestation" || attestation.version !== 1) {
      throw new Error("unsupported memory-write attestation schema");
    }
    core = memoryWriteCore(attestation);
  } catch (error) {
    const fallback = sha256DigestCanonical({ invalid: true });
    return { valid: false, reasons: [error instanceof Error ? error.message : String(error)], recomputedDigest: fallback };
  }
  const recomputedDigest = sha256DigestCanonical(core);
  if (attestation.attestationDigest !== recomputedDigest) reasons.push("attestationDigest does not match signed fields");
  if (options.expectedAuthorityEpoch !== undefined && attestation.authorityEpoch !== options.expectedAuthorityEpoch) reasons.push("memory write belongs to a different authority epoch");
  const now = (options.now ?? new Date()).getTime();
  if (attestation.validUntil && Date.parse(attestation.validUntil) < now) reasons.push("memory write attestation is expired");
  let signatureValid = false;
  try {
    signatureValid = await options.verifySignature({
      digest: recomputedDigest,
      signer: attestation.signer,
      signature: attestation.signature
    });
  } catch {
    reasons.push("memory write signature verifier failed");
  }
  if (!signatureValid) reasons.push("memory write signature is invalid or unverified");
  return { valid: reasons.length === 0, reasons, recomputedDigest };
}

function influenceCore(input: Omit<MemoryInfluenceReceiptV1, "receiptDigest">): Omit<MemoryInfluenceReceiptV1, "receiptDigest"> {
  if (!["BOUNDED", "UNBOUNDED", "INCONCLUSIVE"].includes(input.influenceVerdict)) throw new Error("unsupported influenceVerdict");
  return {
    kind: "arobi.familiar-memory-influence",
    version: 1,
    retrievalId: nonEmpty(input.retrievalId, "retrievalId"),
    retrievedMemoryRoot: digest(input.retrievedMemoryRoot, "retrievedMemoryRoot"),
    acceptedMemoryRoot: digest(input.acceptedMemoryRoot, "acceptedMemoryRoot"),
    rejectedMemoryRoot: digest(input.rejectedMemoryRoot, "rejectedMemoryRoot"),
    authorityEpoch: epoch(input.authorityEpoch),
    retrievalPolicyDigest: digest(input.retrievalPolicyDigest, "retrievalPolicyDigest"),
    contextUseReceiptDigest: digest(input.contextUseReceiptDigest, "contextUseReceiptDigest"),
    ...(input.perturbationChallengeDigest ? { perturbationChallengeDigest: digest(input.perturbationChallengeDigest, "perturbationChallengeDigest") } : {}),
    ...(input.deniedIntentFingerprintDigest ? { deniedIntentFingerprintDigest: digest(input.deniedIntentFingerprintDigest, "deniedIntentFingerprintDigest") } : {}),
    influenceVerdict: input.influenceVerdict,
    verifierDigest: digest(input.verifierDigest, "verifierDigest"),
    createdAt: timestamp(input.createdAt, "createdAt")
  };
}

/** Receipt contains only roots/digests; raw prompts and memory content are intentionally absent. */
export function buildMemoryInfluenceReceipt(
  input: Omit<MemoryInfluenceReceiptV1, "kind" | "version" | "receiptDigest">
): MemoryInfluenceReceiptV1 {
  const core = influenceCore({
    kind: "arobi.familiar-memory-influence",
    version: 1,
    ...input
  });
  return { ...core, receiptDigest: sha256DigestCanonical(core) };
}

export function verifyMemoryInfluenceReceipt(
  receipt: MemoryInfluenceReceiptV1,
  options: {
    currentAuthorityEpoch: number;
    requireBounded?: boolean;
    expectedRetrievalPolicyDigest?: Digest;
  }
): { valid: boolean; reasons: string[]; recomputedDigest: Digest } {
  const reasons: string[] = [];
  let core: Omit<MemoryInfluenceReceiptV1, "receiptDigest">;
  try {
    if (receipt.kind !== "arobi.familiar-memory-influence" || receipt.version !== 1) throw new Error("unsupported memory influence schema");
    core = influenceCore(receipt);
  } catch (error) {
    const fallback = sha256DigestCanonical({ invalid: true });
    return { valid: false, reasons: [error instanceof Error ? error.message : String(error)], recomputedDigest: fallback };
  }
  const recomputedDigest = sha256DigestCanonical(core);
  if (receipt.receiptDigest !== recomputedDigest) reasons.push("receiptDigest does not match memory influence fields");
  if (receipt.authorityEpoch !== options.currentAuthorityEpoch) reasons.push("memory influence belongs to a different authority epoch");
  if (options.requireBounded && receipt.influenceVerdict !== "BOUNDED") reasons.push(`consequential memory influence must be BOUNDED, observed ${receipt.influenceVerdict}`);
  if (options.expectedRetrievalPolicyDigest && receipt.retrievalPolicyDigest !== options.expectedRetrievalPolicyDigest) reasons.push("retrieval policy digest does not match the current consequential policy");
  return { valid: reasons.length === 0, reasons, recomputedDigest };
}

/**
 * Commitment bound into RuntimeAdmission/EffectClosure when persistent memory materially influenced
 * a consequential proposal. The root contains no authority grant and no raw memory content.
 */
export function computeMemoryContextRoot(input: {
  contextUseReceiptDigest: Digest;
  memoryInfluenceReceiptDigest: Digest;
  acceptedMemoryRoot: Digest;
  authorityEpoch: number;
  retrievalPolicyDigest: Digest;
}): Digest {
  return sha256DigestCanonical({
    schema: "arobi.familiar-memory-context-root.v1",
    context_use_receipt_digest: digest(input.contextUseReceiptDigest, "contextUseReceiptDigest"),
    memory_influence_receipt_digest: digest(input.memoryInfluenceReceiptDigest, "memoryInfluenceReceiptDigest"),
    accepted_memory_root: digest(input.acceptedMemoryRoot, "acceptedMemoryRoot"),
    authority_epoch: epoch(input.authorityEpoch),
    retrieval_policy_digest: digest(input.retrievalPolicyDigest, "retrievalPolicyDigest"),
    may_authorize: false
  });
}
