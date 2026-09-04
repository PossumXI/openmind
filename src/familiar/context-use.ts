import { randomUUID } from "node:crypto";
import { sha256DigestCanonical } from "./canonicalize.js";
import { assertContextUseReceiptV1, isDigest } from "./validate.js";
import type { ContextUseReceiptV1, Digest } from "./types.js";

export type FamiliarContextUseBuildInput = {
  tenantId: string;
  familiarId: string;
  identityEpoch: number;
  purpose: unknown;
  retrieved: readonly Digest[];
  opened: readonly Digest[];
  reliedUpon: readonly Digest[];
  rejectedOrConflicting?: readonly Digest[];
  proposal: unknown;
  familiarContinuityDigest: Digest;
  receiptId?: string;
  createdAt?: string;
};

function uniqueDigests(values: readonly Digest[], label: string): Digest[] {
  const seen = new Set<string>();
  const out: Digest[] = [];
  for (const value of values) {
    if (!isDigest(value)) throw new Error(`${label} contains an invalid digest`);
    if (seen.has(value)) throw new Error(`${label} contains a duplicate digest`);
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * Builds and validates the evidence that links retrieved familiar memory to a
 * consequential proposal. The receipt records exactly what was available,
 * opened, relied upon, and rejected. It contains no execution authority.
 */
export function buildContextUseReceipt(
  input: FamiliarContextUseBuildInput,
): ContextUseReceiptV1 {
  if (!input.tenantId.trim() || !input.familiarId.trim()) {
    throw new Error("FMP context-use receipt requires tenantId and familiarId");
  }
  if (!Number.isSafeInteger(input.identityEpoch) || input.identityEpoch < 0) {
    throw new Error("FMP context-use receipt requires a non-negative identityEpoch");
  }
  if (!isDigest(input.familiarContinuityDigest)) {
    throw new Error("FMP context-use receipt requires a valid continuity digest");
  }

  const receipt: ContextUseReceiptV1 = {
    kind: "arobi.familiar-context-use",
    version: 1,
    receiptId: input.receiptId?.trim() || randomUUID(),
    familiarId: input.familiarId,
    tenantId: input.tenantId,
    identityEpoch: input.identityEpoch,
    purposeDigest: sha256DigestCanonical(input.purpose),
    retrieved: uniqueDigests(input.retrieved, "retrieved"),
    opened: uniqueDigests(input.opened, "opened"),
    reliedUpon: uniqueDigests(input.reliedUpon, "reliedUpon"),
    rejectedOrConflicting: uniqueDigests(
      input.rejectedOrConflicting ?? [],
      "rejectedOrConflicting",
    ),
    proposalDigest: sha256DigestCanonical(input.proposal),
    familiarContinuityDigest: input.familiarContinuityDigest,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  assertContextUseReceiptV1(receipt);
  return receipt;
}
