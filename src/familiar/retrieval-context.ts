import { buildContextUseReceipt } from "./context-use.js";
import { sha256DigestCanonical } from "./canonicalize.js";
import type {
  ContextUseReceiptV1,
  Digest,
} from "./types.js";
import type { FamiliarRetrievalResult } from "./retrieval.js";

export interface FamiliarContextUseSink {
  writeContextUse(value: unknown): Promise<{ rowId: string; digest: Digest }>;
}

export interface RecordRetrievedContextUseInput {
  tenantId: string;
  familiarId: string;
  identityEpoch: number;
  purpose: unknown;
  proposal: unknown;
  familiarContinuityDigest: Digest;
  retrieved: readonly FamiliarRetrievalResult[];
  opened: readonly Digest[];
  reliedUpon: readonly Digest[];
  rejectedOrConflicting?: readonly Digest[];
  receiptId?: string;
  createdAt?: string;
}

export interface RecordedRetrievedContextUse {
  receipt: ContextUseReceiptV1;
  receiptDigest: Digest;
  persistence?: {
    rowId: string;
    digest: Digest;
  };
}

function assertScope(input: RecordRetrievedContextUseInput): void {
  if (!input.tenantId.trim() || !input.familiarId.trim()) {
    throw new Error("FMP retrieved-context receipt requires non-empty tenantId and familiarId");
  }
  if (!Number.isSafeInteger(input.identityEpoch) || input.identityEpoch < 0) {
    throw new Error("FMP retrieved-context receipt requires a non-negative identityEpoch");
  }

  const seen = new Set<Digest>();
  for (const candidate of input.retrieved) {
    if (candidate.memory.tenantId !== input.tenantId) {
      throw new Error("FMP retrieved-context candidate crosses tenant scope");
    }
    if (candidate.memory.familiarId !== input.familiarId) {
      throw new Error("FMP retrieved-context candidate crosses familiar scope");
    }
    if (candidate.memory.identityEpoch !== input.identityEpoch) {
      throw new Error("FMP retrieved-context candidate crosses identity epoch");
    }
    if (candidate.memory.mayAuthorize !== false) {
      throw new Error("FMP retrieved-context candidate violates memory authority boundary");
    }
    const expectedDigest = sha256DigestCanonical(candidate.memory);
    if (candidate.artifactDigest !== expectedDigest) {
      throw new Error("FMP retrieved-context candidate digest does not match canonical memory");
    }
    if (seen.has(candidate.artifactDigest)) {
      throw new Error("FMP retrieved-context candidates contain a duplicate artifact digest");
    }
    seen.add(candidate.artifactDigest);
  }
}

function ensureSelectedFromRetrieved(
  selected: readonly Digest[],
  retrieved: ReadonlySet<Digest>,
  label: string,
): void {
  const seen = new Set<Digest>();
  for (const digest of selected) {
    if (!retrieved.has(digest)) {
      throw new Error(`FMP ${label} digest was not present in the actual retrieval result`);
    }
    if (seen.has(digest)) {
      throw new Error(`FMP ${label} contains a duplicate digest`);
    }
    seen.add(digest);
  }
}

/**
 * Converts an actual scoped retrieval result into the evidence record for a
 * consequential proposal.
 *
 * The caller cannot invent the `retrieved` set: it is derived from the
 * structured retrieval results supplied here. Opened/relied/rejected digests
 * must all refer to that exact set, and the existing ContextUseReceipt
 * validator additionally enforces reliedUpon/rejected ⊆ opened ⊆ retrieved.
 *
 * This record remains evidence only. It carries no approval, permission, route
 * grant, consent, role, or execution capability.
 */
export async function recordRetrievedContextUse(
  input: RecordRetrievedContextUseInput,
  sink?: FamiliarContextUseSink,
): Promise<RecordedRetrievedContextUse> {
  assertScope(input);

  const retrieved = input.retrieved.map((candidate) => candidate.artifactDigest);
  const retrievedSet = new Set(retrieved);
  ensureSelectedFromRetrieved(input.opened, retrievedSet, "opened");
  ensureSelectedFromRetrieved(input.reliedUpon, retrievedSet, "reliedUpon");
  ensureSelectedFromRetrieved(
    input.rejectedOrConflicting ?? [],
    retrievedSet,
    "rejectedOrConflicting",
  );

  const receipt = buildContextUseReceipt({
    tenantId: input.tenantId,
    familiarId: input.familiarId,
    identityEpoch: input.identityEpoch,
    purpose: input.purpose,
    retrieved,
    opened: input.opened,
    reliedUpon: input.reliedUpon,
    rejectedOrConflicting: input.rejectedOrConflicting,
    proposal: input.proposal,
    familiarContinuityDigest: input.familiarContinuityDigest,
    receiptId: input.receiptId,
    createdAt: input.createdAt,
  });
  const receiptDigest = sha256DigestCanonical(receipt);

  if (!sink) return { receipt, receiptDigest };

  const persistence = await sink.writeContextUse(receipt);
  if (persistence.digest !== receiptDigest) {
    throw new Error("FMP persisted context-use digest does not match canonical receipt digest");
  }
  return { receipt, receiptDigest, persistence };
}
