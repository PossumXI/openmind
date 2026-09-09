import { sha256DigestCanonical } from "./canonicalize.js";
import { contextBoundaryAllowsUse, contextUseReceiptV11Digest, type ContextUseReceiptV11 } from "./context-boundary.js";
import { isDigest } from "./validate.js";
import type { Digest } from "./types.js";

export const CONTEXT_INFLUENCE_TYPES = [
  "DIRECT_PARAMETER",
  "POLICY_INPUT",
  "RETRIEVAL_CONTEXT",
  "PLANNING_CONTEXT",
  "TOOL_SELECTION",
  "TARGET_SELECTION",
  "NO_MATERIAL_INFLUENCE",
] as const;

export type ContextInfluenceType = (typeof CONTEXT_INFLUENCE_TYPES)[number];

export interface ContextInfluenceEdgeV1 {
  kind: "arobi.context-influence";
  version: 1;
  contextReceiptDigest: Digest;
  downstreamEffectId: string;
  influenceType: ContextInfluenceType;
  derivedValueDigest?: Digest;
  decisionNodeDigest: Digest;
  influenceDigest: Digest;
  createdAt: string;
}

export interface ContextInfluenceInput {
  contextReceipt: ContextUseReceiptV11;
  downstreamEffectId: string;
  influenceType: ContextInfluenceType;
  /** Only the deterministic derived value that crossed the governed boundary, never raw source content. */
  derivedValue?: unknown;
  /** Observable decision-node projection, e.g. selected tool/target/parameter record. Never hidden reasoning text. */
  decisionNode: unknown;
  createdAt?: string;
}

const INFLUENCE_TYPE_SET = new Set<string>(CONTEXT_INFLUENCE_TYPES);

function nonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`FMP context influence requires ${label}`);
  return trimmed;
}

function core(edge: Omit<ContextInfluenceEdgeV1, "influenceDigest"> | ContextInfluenceEdgeV1) {
  return {
    kind: edge.kind,
    version: edge.version,
    contextReceiptDigest: edge.contextReceiptDigest,
    downstreamEffectId: edge.downstreamEffectId,
    influenceType: edge.influenceType,
    ...(edge.derivedValueDigest ? { derivedValueDigest: edge.derivedValueDigest } : {}),
    decisionNodeDigest: edge.decisionNodeDigest,
    createdAt: edge.createdAt,
  };
}

export function contextInfluenceDigest(edge: Omit<ContextInfluenceEdgeV1, "influenceDigest"> | ContextInfluenceEdgeV1): Digest {
  return sha256DigestCanonical(core(edge));
}

/**
 * Create an observable influence edge only after the existing compartment boundary permits use.
 * This record never captures raw memory/tool content, free-form reasoning, or chain-of-thought.
 */
export function buildContextInfluenceEdge(input: ContextInfluenceInput): ContextInfluenceEdgeV1 {
  if (!contextBoundaryAllowsUse(input.contextReceipt)) {
    throw new Error("FMP context influence requires an allowed context-use receipt");
  }
  const effectId = nonEmpty(input.downstreamEffectId, "downstreamEffectId");
  if (!INFLUENCE_TYPE_SET.has(input.influenceType)) {
    throw new Error("FMP context influence requires a supported influenceType");
  }
  if (input.influenceType === "NO_MATERIAL_INFLUENCE" && input.derivedValue !== undefined) {
    throw new Error("NO_MATERIAL_INFLUENCE cannot carry a derived value");
  }
  if (input.influenceType !== "NO_MATERIAL_INFLUENCE" && input.decisionNode === undefined) {
    throw new Error("material context influence requires an observable decision node");
  }

  const createdAt = input.createdAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new Error("FMP context influence requires valid createdAt");
  }

  const edgeWithoutDigest: Omit<ContextInfluenceEdgeV1, "influenceDigest"> = {
    kind: "arobi.context-influence",
    version: 1,
    contextReceiptDigest: contextUseReceiptV11Digest(input.contextReceipt),
    downstreamEffectId: effectId,
    influenceType: input.influenceType,
    ...(input.derivedValue !== undefined
      ? { derivedValueDigest: sha256DigestCanonical(input.derivedValue) }
      : {}),
    decisionNodeDigest: sha256DigestCanonical(input.decisionNode),
    createdAt,
  };

  return {
    ...edgeWithoutDigest,
    influenceDigest: contextInfluenceDigest(edgeWithoutDigest),
  };
}

export function assertContextInfluenceEdgeV1(value: unknown): asserts value is ContextInfluenceEdgeV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("FMP context influence must be an object");
  }
  const edge = value as Record<string, unknown>;
  if (edge.kind !== "arobi.context-influence" || edge.version !== 1) {
    throw new Error("unsupported FMP context influence kind/version");
  }
  if (typeof edge.downstreamEffectId !== "string" || !edge.downstreamEffectId.trim()) {
    throw new Error("FMP context influence requires downstreamEffectId");
  }
  if (typeof edge.influenceType !== "string" || !INFLUENCE_TYPE_SET.has(edge.influenceType)) {
    throw new Error("FMP context influence has invalid influenceType");
  }
  if (!isDigest(edge.contextReceiptDigest) || !isDigest(edge.decisionNodeDigest) || !isDigest(edge.influenceDigest)) {
    throw new Error("FMP context influence requires valid digests");
  }
  if (edge.derivedValueDigest !== undefined && !isDigest(edge.derivedValueDigest)) {
    throw new Error("FMP context influence derivedValueDigest is invalid");
  }
  if (edge.influenceType === "NO_MATERIAL_INFLUENCE" && edge.derivedValueDigest !== undefined) {
    throw new Error("NO_MATERIAL_INFLUENCE cannot claim a derived value");
  }
  if (typeof edge.createdAt !== "string" || !Number.isFinite(Date.parse(edge.createdAt))) {
    throw new Error("FMP context influence requires valid createdAt");
  }
  if (edge.influenceDigest !== contextInfluenceDigest(edge as unknown as ContextInfluenceEdgeV1)) {
    throw new Error("FMP context influence digest mismatch");
  }
}
