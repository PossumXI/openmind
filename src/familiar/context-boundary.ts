import { randomUUID } from "node:crypto";
import { sha256DigestCanonical } from "./canonicalize.js";
import { isDigest } from "./validate.js";
import type { ContextUseReceiptV1, Digest } from "./types.js";

export type ContextCompartment =
  | "PARENT_AGENT"
  | "WORKER_AGENT"
  | "TOOL_RESULT"
  | "EXTERNAL_INPUT"
  | "MEMORY_RECALL"
  | "POLICY_ENGINE"
  | "VERIFIER"
  | string;

export type ContextTaintClass =
  | "TRUSTED"
  | "DERIVED"
  | "EXTERNAL_UNTRUSTED"
  | "ACTIVE_CONTENT"
  | "UNKNOWN";

export type ContextBoundaryDecision =
  | "ALLOW_SCHEMA_VALIDATED"
  | "HOLD"
  | "REJECT";

export interface ContextBoundaryProcessorRef {
  identity: string;
  version: string;
}

export interface ContextBoundaryValidatorRef extends ContextBoundaryProcessorRef {
  schemaDigest: Digest;
}

/**
 * Additive V1.1 evidence for the memory -> execution-context boundary.
 * It binds the existing V1 retrieval/use receipt to the compartment crossing
 * without placing raw memory/tool content in the receipt.
 */
export interface ContextUseReceiptV11 {
  kind: "arobi.familiar-context-use.v1.1";
  version: "1.1";
  receiptId: string;
  parentReceiptDigest: Digest;
  tenantId: string;
  familiarId: string;
  identityEpoch: number;
  authorityEpoch: number;
  sourceCompartment: ContextCompartment;
  destinationCompartment: ContextCompartment;
  allowedDerivationCompartments: ContextCompartment[];
  rawContentCrossed: boolean;
  sanitizer: ContextBoundaryProcessorRef;
  validator: ContextBoundaryValidatorRef;
  taintClass: ContextTaintClass;
  crossedValueDigest: Digest;
  freshUntil: string;
  downstreamEffectIds: string[];
  decision: ContextBoundaryDecision;
  decisionReason: string;
  createdAt: string;
}

export interface ContextBoundaryInput {
  parentReceipt: ContextUseReceiptV1;
  authorityEpoch: number;
  sourceCompartment: ContextCompartment;
  destinationCompartment: ContextCompartment;
  allowedDerivationCompartments?: readonly ContextCompartment[];
  rawContentCrossed: boolean;
  sanitizer: ContextBoundaryProcessorRef;
  validator: ContextBoundaryValidatorRef;
  taintClass: ContextTaintClass;
  crossedValue: unknown;
  freshUntil: string;
  downstreamEffectIds?: readonly string[];
  highRiskPath: boolean;
  receiptId?: string;
  createdAt?: string;
}

function nonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`FMP context boundary requires ${label}`);
  return trimmed;
}

function validTime(value: string, label: string): number {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error(`FMP context boundary requires valid ${label}`);
  return time;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

export function contextUseReceiptV11Digest(receipt: ContextUseReceiptV11): Digest {
  return sha256DigestCanonical(receipt);
}

/**
 * CONTEXT-INJECTION invariant:
 * - high-risk paths never permit raw external/tool/memory content to cross into
 *   a parent-agent compartment;
 * - only a schema-validated derived value may cross;
 * - stale boundary evidence is held;
 * - context evidence never grants authority.
 */
export function buildContextUseReceiptV11(input: ContextBoundaryInput): ContextUseReceiptV11 {
  const nowIso = input.createdAt ?? new Date().toISOString();
  const now = validTime(nowIso, "createdAt");
  const freshUntil = validTime(input.freshUntil, "freshUntil");
  if (!Number.isSafeInteger(input.authorityEpoch) || input.authorityEpoch < 0) {
    throw new Error("FMP context boundary requires a non-negative authorityEpoch");
  }
  if (!isDigest(input.validator.schemaDigest)) {
    throw new Error("FMP context boundary requires a valid validator schema digest");
  }

  const sourceCompartment = nonEmpty(input.sourceCompartment, "sourceCompartment");
  const destinationCompartment = nonEmpty(input.destinationCompartment, "destinationCompartment");
  const sanitizer = {
    identity: nonEmpty(input.sanitizer.identity, "sanitizer.identity"),
    version: nonEmpty(input.sanitizer.version, "sanitizer.version"),
  };
  const validator = {
    identity: nonEmpty(input.validator.identity, "validator.identity"),
    version: nonEmpty(input.validator.version, "validator.version"),
    schemaDigest: input.validator.schemaDigest,
  };

  let decision: ContextBoundaryDecision = "ALLOW_SCHEMA_VALIDATED";
  let decisionReason = "schema-validated derived value may cross the governed compartment boundary";

  if (freshUntil < now) {
    decision = "HOLD";
    decisionReason = "context boundary evidence is stale";
  } else if (input.highRiskPath && input.rawContentCrossed) {
    decision = "REJECT";
    decisionReason = "raw content cannot cross a high-risk governed context boundary";
  } else if (
    input.highRiskPath &&
    destinationCompartment === "PARENT_AGENT" &&
    (input.taintClass === "EXTERNAL_UNTRUSTED" || input.taintClass === "ACTIVE_CONTENT")
  ) {
    decision = "HOLD";
    decisionReason = "untrusted or active content requires validated derivation before parent-agent context use";
  }

  return {
    kind: "arobi.familiar-context-use.v1.1",
    version: "1.1",
    receiptId: input.receiptId?.trim() || randomUUID(),
    parentReceiptDigest: sha256DigestCanonical(input.parentReceipt),
    tenantId: input.parentReceipt.tenantId,
    familiarId: input.parentReceipt.familiarId,
    identityEpoch: input.parentReceipt.identityEpoch,
    authorityEpoch: input.authorityEpoch,
    sourceCompartment,
    destinationCompartment,
    allowedDerivationCompartments: uniqueStrings(input.allowedDerivationCompartments ?? []),
    rawContentCrossed: input.rawContentCrossed,
    sanitizer,
    validator,
    taintClass: input.taintClass,
    crossedValueDigest: sha256DigestCanonical(input.crossedValue),
    freshUntil: input.freshUntil,
    downstreamEffectIds: uniqueStrings(input.downstreamEffectIds ?? []),
    decision,
    decisionReason,
    createdAt: nowIso,
  };
}

export function contextBoundaryAllowsUse(receipt: ContextUseReceiptV11): boolean {
  return receipt.decision === "ALLOW_SCHEMA_VALIDATED" && !receipt.rawContentCrossed;
}

export function bindContextReceiptToEffect(
  receipt: ContextUseReceiptV11,
  effectId: string,
): ContextUseReceiptV11 {
  const id = nonEmpty(effectId, "effectId");
  return {
    ...receipt,
    downstreamEffectIds: uniqueStrings([...receipt.downstreamEffectIds, id]),
  };
}
