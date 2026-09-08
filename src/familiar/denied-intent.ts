import { sha256DigestCanonical } from "./canonicalize.js";
import { isDigest } from "./validate.js";
import type { Digest } from "./types.js";

export const DENIED_INTENT_STATE_SCHEMA = "arobi.denied-intent-state.v1" as const;
export const DENIED_INTENT_FINGERPRINT_SCHEMA = "arobi.denied-intent-fingerprint.v1" as const;

export type DeniedIntentSurface = {
  effectClass: string;
  routeClass?: string;
  toolClass?: string;
  workerId?: string;
  encodingClass?: string;
};

/**
 * Semantic inputs are produced by the governed policy/intent-normalization layer.
 * Raw user/tool text is deliberately excluded so a denied objective cannot become
 * long-lived prompt material and surface wording cannot change the fingerprint.
 */
export type DeniedIntentSemanticInput = {
  objectiveClass: string;
  targetDigest: Digest;
  consequenceClass: string;
  consequential: boolean;
};

export type DeniedIntentAttemptInput = DeniedIntentSemanticInput & DeniedIntentSurface & {
  tenantId: string;
  sessionId: string;
  authorityEpoch: number;
  policyEpoch: number;
  observedAt: string;
};

export type DeniedIntentFingerprint = {
  schema: typeof DENIED_INTENT_FINGERPRINT_SCHEMA;
  fingerprint: Digest;
  objectiveClass: string;
  targetDigest: Digest;
  consequenceClass: string;
};

export type DeniedIntentRecord = {
  fingerprint: DeniedIntentFingerprint;
  firstDeniedAt: string;
  lastDeniedAt: string;
  freshUntil: string;
  firstAuthorityEpoch: number;
  lastAuthorityEpoch: number;
  firstPolicyEpoch: number;
  lastPolicyEpoch: number;
  denialCount: number;
  surfaces: Digest[];
};

export type RiskIntentState = {
  schema: typeof DENIED_INTENT_STATE_SCHEMA;
  tenantId: string;
  sessionId: string;
  maxEntries: number;
  escalationThreshold: number;
  saturated: boolean;
  records: DeniedIntentRecord[];
};

export type DeniedIntentDecision = {
  decision: "ALLOW" | "HOLD" | "ESCALATE";
  reason: string;
  fingerprint?: Digest;
  denialCount?: number;
};

export type RiskIntentStateOptions = {
  tenantId: string;
  sessionId: string;
  maxEntries?: number;
  escalationThreshold?: number;
};

function nonEmpty(value: string, label: string): string {
  const normalized = value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, "_");
  if (!normalized) throw new Error(`denied intent requires ${label}`);
  return normalized;
}

function validEpoch(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`denied intent requires non-negative ${label}`);
  return value;
}

function validTime(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`denied intent requires valid ${label}`);
  return parsed;
}

function uniqueSorted(values: readonly Digest[]): Digest[] {
  return [...new Set(values)].sort() as Digest[];
}

function surfaceDigest(input: DeniedIntentSurface): Digest {
  return sha256DigestCanonical({
    effect_class: nonEmpty(input.effectClass, "effectClass"),
    route_class: input.routeClass ? nonEmpty(input.routeClass, "routeClass") : null,
    tool_class: input.toolClass ? nonEmpty(input.toolClass, "toolClass") : null,
    worker_id: input.workerId ? nonEmpty(input.workerId, "workerId") : null,
    encoding_class: input.encodingClass ? nonEmpty(input.encodingClass, "encodingClass") : null,
  });
}

export function buildDeniedIntentFingerprint(input: DeniedIntentSemanticInput): DeniedIntentFingerprint {
  if (!input.consequential) throw new Error("only consequential denied objectives belong in persistent risk intent state");
  if (!isDigest(input.targetDigest)) throw new Error("denied intent requires a valid targetDigest");

  const objectiveClass = nonEmpty(input.objectiveClass, "objectiveClass");
  const consequenceClass = nonEmpty(input.consequenceClass, "consequenceClass");
  const core = {
    schema: DENIED_INTENT_FINGERPRINT_SCHEMA,
    objective_class: objectiveClass,
    target_digest: input.targetDigest,
    consequence_class: consequenceClass,
  };
  return {
    schema: DENIED_INTENT_FINGERPRINT_SCHEMA,
    fingerprint: sha256DigestCanonical(core),
    objectiveClass,
    targetDigest: input.targetDigest,
    consequenceClass,
  };
}

export function createRiskIntentState(options: RiskIntentStateOptions): RiskIntentState {
  const tenantId = options.tenantId.trim();
  const sessionId = options.sessionId.trim();
  if (!tenantId || !sessionId) throw new Error("risk intent state requires tenantId and sessionId");
  const maxEntries = options.maxEntries ?? 32;
  const escalationThreshold = options.escalationThreshold ?? 3;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 256) {
    throw new Error("risk intent maxEntries must be between 1 and 256");
  }
  if (!Number.isSafeInteger(escalationThreshold) || escalationThreshold < 2 || escalationThreshold > 32) {
    throw new Error("risk intent escalationThreshold must be between 2 and 32");
  }
  return {
    schema: DENIED_INTENT_STATE_SCHEMA,
    tenantId,
    sessionId,
    maxEntries,
    escalationThreshold,
    saturated: false,
    records: [],
  };
}

function assertSession(state: RiskIntentState, input: Pick<DeniedIntentAttemptInput, "tenantId" | "sessionId">): void {
  if (state.tenantId !== input.tenantId || state.sessionId !== input.sessionId) {
    throw new Error("denied intent state cannot cross tenant or governed-session boundaries");
  }
}

export function pruneExpiredDeniedIntentState(state: RiskIntentState, nowIso: string): RiskIntentState {
  const now = validTime(nowIso, "now");
  return {
    ...state,
    records: state.records.filter((record) => validTime(record.freshUntil, "freshUntil") >= now),
  };
}

/**
 * Records a denied consequential objective without retaining the raw request.
 * Surface/tool/worker/encoding information is evidence only and does not affect
 * the semantic fingerprint, preventing route switching from resetting denial.
 */
export function recordDeniedIntent(
  state: RiskIntentState,
  input: DeniedIntentAttemptInput,
  freshUntil: string,
): RiskIntentState {
  assertSession(state, input);
  validEpoch(input.authorityEpoch, "authorityEpoch");
  validEpoch(input.policyEpoch, "policyEpoch");
  const deniedAt = validTime(input.observedAt, "observedAt");
  const expiresAt = validTime(freshUntil, "freshUntil");
  if (expiresAt < deniedAt) throw new Error("denied intent freshUntil cannot precede denial");

  const fingerprint = buildDeniedIntentFingerprint(input);
  const surface = surfaceDigest(input);
  const active = pruneExpiredDeniedIntentState(state, input.observedAt);
  const index = active.records.findIndex((record) => record.fingerprint.fingerprint === fingerprint.fingerprint);
  if (index >= 0) {
    const previous = active.records[index];
    const updated: DeniedIntentRecord = {
      ...previous,
      lastDeniedAt: input.observedAt,
      freshUntil,
      lastAuthorityEpoch: input.authorityEpoch,
      lastPolicyEpoch: input.policyEpoch,
      denialCount: previous.denialCount + 1,
      surfaces: uniqueSorted([...previous.surfaces, surface]),
    };
    return {
      ...active,
      records: active.records.map((record, recordIndex) => recordIndex === index ? updated : record),
    };
  }

  if (active.records.length >= active.maxEntries) {
    // Never evict a still-active denied objective to make room for a new one.
    // Saturation fails closed for consequential actions until explicit review/reset.
    return { ...active, saturated: true };
  }

  return {
    ...active,
    records: [
      ...active.records,
      {
        fingerprint,
        firstDeniedAt: input.observedAt,
        lastDeniedAt: input.observedAt,
        freshUntil,
        firstAuthorityEpoch: input.authorityEpoch,
        lastAuthorityEpoch: input.authorityEpoch,
        firstPolicyEpoch: input.policyEpoch,
        lastPolicyEpoch: input.policyEpoch,
        denialCount: 1,
        surfaces: [surface],
      },
    ],
  };
}

/**
 * Correlates the current consequential objective against active session denials.
 * The semantic fingerprint is independent of tool, route, worker, phrasing and
 * encoding surfaces. A matching objective remains held even after epoch changes;
 * only expiry or an explicit state reset can clear it.
 */
export function evaluateDeniedIntentAttempt(
  state: RiskIntentState,
  input: DeniedIntentAttemptInput,
): DeniedIntentDecision {
  assertSession(state, input);
  validEpoch(input.authorityEpoch, "authorityEpoch");
  validEpoch(input.policyEpoch, "policyEpoch");
  const active = pruneExpiredDeniedIntentState(state, input.observedAt);
  if (!input.consequential) return { decision: "ALLOW", reason: "non-consequential objective is outside denied-intent continuity" };
  if (active.saturated) {
    return { decision: "HOLD", reason: "denied-intent state saturated; consequential execution requires explicit review" };
  }

  const candidate = buildDeniedIntentFingerprint(input);
  const match = active.records.find((record) => record.fingerprint.fingerprint === candidate.fingerprint);
  if (!match) return { decision: "ALLOW", reason: "no active denied objective matches this semantic intent" };

  if (match.denialCount >= active.escalationThreshold) {
    return {
      decision: "ESCALATE",
      reason: "previously denied consequential objective persists across execution surfaces",
      fingerprint: match.fingerprint.fingerprint,
      denialCount: match.denialCount,
    };
  }
  return {
    decision: "HOLD",
    reason: "previously denied consequential objective remains held in this governed session",
    fingerprint: match.fingerprint.fingerprint,
    denialCount: match.denialCount,
  };
}
