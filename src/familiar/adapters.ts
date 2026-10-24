import { sha256DigestCanonical, sha256DomainDigestCanonical } from "./canonicalize.js";
import type { FamiliarRetrievalCandidate, FamiliarRetrievalRanker } from "./retrieval.js";
import {
  FAMILIAR_MEMORY_CLASSES,
  FAMILIAR_SCOPE_BINDING_KINDS,
  MEMORY_SUPPORT_STATES,
  MEMORY_TRUST_CLASSES,
  type Digest,
  type FamiliarMemoryArtifactV1,
  type FamiliarMemoryClass,
  type FamiliarMemoryScopeV1,
  type FamiliarScopeBindingKind,
  type FamiliarScopeBindingV1,
  type FamiliarScopeDependencyV1,
  type MemorySupportState,
  type MemoryTrustClass,
} from "./types.js";
import { FamiliarValidationError, isDigest } from "./validate.js";

/*
 * Familiar adapters (FMP v1.2, additive): memory organized the way a brain organizes it, over the one memory plane
 * that already exists.
 *
 * An adapter is a logical family of memory (episodic, semantic, procedural, creative...) declared in a versioned,
 * digest-pinned registry. It is not a store. Every memory stays one canonical FamiliarMemoryArtifactV1, and the
 * adapters it belongs to are computed from that artifact, its lineage and its use receipts under the registry's rules.
 * None of that is stored as truth (INV-FMP-005), so a registry revision never leaves a stale assignment behind, and
 * the model never decides where a memory goes: as a memory's lineage grows (a hypothesis grounded in evidence, then
 * corroborated), the same rules route it through the next adapter, and the ones it came from stay associated.
 *
 * Every adapter is a cortical column with the same ports:
 *   layer IV     receptors   how strongly the turn's features (intents, tools, environment, task, content) excite it;
 *   layer II/III lateral    symmetric links to its peers in the same tier;
 *   layer V      budget      how many notes it may contribute to the working set;
 *   layer VI     feedback    outcomes recorded against a route adjust its weights only at the next reviewed registry
 *                            revision, never silently at run time;
 *   layer I      modulation  novelty, reward, risk, urgency and salience scale its gain. They never add trust or
 *                            authority, and they cannot excite an adapter that nothing else excites.
 * Columns sit in tiers along the cortical input-to-output pathway (association, limbic, executive, motor), joined by
 * asymmetric feedforward and feedback pathways and symmetric lateral ones. A turn settles in a fixed number of
 * synchronous passes, so the same history and the same turn always settle the same way.
 *
 * Routing is relevance only (INV-FMP-011). It runs as the ranker of retrieveFamiliarMemories, so it only ever sees
 * memories that already passed the tenant, familiar, identity-epoch, support, trust and expiry filters, and what it
 * returns are candidates. Admission stays with the context boundary and Immaculate's memory-use policy; a high score
 * never overrides them.
 */

// ---------------------------------------------------------------------------------------------------------------
// Vocabulary

export const FAMILIAR_ADAPTER_FAMILIES = [
  "ACTIVE_THOUGHT",
  "EPISODIC",
  "SEMANTIC",
  "PROCEDURAL",
  "CREATIVE",
  "AUTOBIOGRAPHICAL",
  "PROJECT",
  "ENVIRONMENTAL",
  "REFLECTIVE",
] as const;
export type FamiliarAdapterFamily = (typeof FAMILIAR_ADAPTER_FAMILIES)[number];

/** Tiers in the order evidence flows (feedforward). Feedback runs the other way. */
export const FAMILIAR_ADAPTER_TIERS = ["ASSOCIATION", "LIMBIC", "EXECUTIVE", "MOTOR"] as const;
export type FamiliarAdapterTier = (typeof FAMILIAR_ADAPTER_TIERS)[number];

/** What a turn is doing, as the caller's own deterministic classification of it. */
export const FAMILIAR_TURN_INTENTS = ["RECALL", "BUILD", "CREATE", "PLAN", "REVIEW", "PERSONAL", "ACT"] as const;
export type FamiliarTurnIntent = (typeof FAMILIAR_TURN_INTENTS)[number];

/**
 * Receptor channels besides intents: tools are in play, an environment is bound, a task is bound, and how well the
 * turn's content matches the adapter's own memories.
 */
export const FAMILIAR_RECEPTOR_CHANNELS = ["TOOLS", "ENVIRONMENT", "TASK", "CONTENT"] as const;
export type FamiliarReceptorChannel = (typeof FAMILIAR_RECEPTOR_CHANNELS)[number];

export const FAMILIAR_MODULATORS = ["NOVELTY", "REWARD", "RISK", "URGENCY", "SALIENCE"] as const;
export type FamiliarModulator = (typeof FAMILIAR_MODULATORS)[number];

export const FAMILIAR_PATHWAY_KINDS = ["FEEDFORWARD", "FEEDBACK", "LATERAL"] as const;
export type FamiliarPathwayKind = (typeof FAMILIAR_PATHWAY_KINDS)[number];

/**
 * Where a memory is in its development. Nothing is pushed forward: a hypothesis can stay one, an event can stay
 * uninterpreted, and the last four are FMP support states, kept as they are.
 */
export const FAMILIAR_LIFECYCLE_STAGES = [
  "CAPTURED",
  "UNDER_EVALUATION",
  "VALIDATED",
  "APPLIED",
  "CONTESTED",
  "SUPERSEDED",
  "QUARANTINED",
  "FORGOTTEN",
] as const;
export type FamiliarLifecycleStage = (typeof FAMILIAR_LIFECYCLE_STAGES)[number];

/** Contextual applicability: does a memory apply in the environment the turn runs in. */
export const FAMILIAR_APPLICABILITY = ["MATCH", "PARTIAL", "UNSCOPED", "CONFLICT", "OUT_OF_SCOPE"] as const;
export type FamiliarApplicability = (typeof FAMILIAR_APPLICABILITY)[number];

/** Current validity: is it still correct, as far as the canonical record and the environment can tell. */
export const FAMILIAR_VALIDITY = ["CURRENT", "NEEDS_REVALIDATION", "EXPIRED", "CONTESTED", "SUPERSEDED", "WITHDRAWN"] as const;
export type FamiliarValidity = (typeof FAMILIAR_VALIDITY)[number];

/** A memory that is not current or does not apply here is still history: it can explain why, never instruct now. */
export type FamiliarMemoryUse = "ORDINARY" | "HISTORICAL_REFERENCE";

// ---------------------------------------------------------------------------------------------------------------
// Registry contract

export interface FamiliarAdapterRuleV1 {
  /** Unique across the registry; every assignment names the rule that made it. */
  ruleId: string;
  role: "PRIMARY" | "ASSOCIATION";
  /** Among matching PRIMARY rules the highest priority wins; ties go to registry order. */
  priority: number;
  /** Every present constraint must hold; within one, any listed value does. */
  memoryClasses?: FamiliarMemoryClass[];
  trustClasses?: MemoryTrustClass[];
  supportStates?: MemorySupportState[];
  /** The memory's scope binds at least one of these kinds. */
  scopeKinds?: FamiliarScopeBindingKind[];
  /** At least one source artifact, resolved through the lineage view, is of one of these classes. */
  lineageIncludes?: FamiliarMemoryClass[];
  /** Whether the memory was derived (its transformation chain is not empty). */
  derived?: boolean;
}

export interface FamiliarAdapterReceptorsV1 {
  intents: Partial<Record<FamiliarTurnIntent, number>>;
  channels: Partial<Record<FamiliarReceptorChannel, number>>;
}

export interface FamiliarAdapterV1 {
  adapterId: string;
  family: FamiliarAdapterFamily;
  tier: FamiliarAdapterTier;
  /** What it holds, in one sentence, for whatever explains a route. */
  purpose: string;
  rules: FamiliarAdapterRuleV1[];
  receptors: FamiliarAdapterReceptorsV1;
  /** Layer I: each modulator's effect on this adapter's gain, from -1 to 1. */
  modulation: Partial<Record<FamiliarModulator, number>>;
  /** null: age never lowers its memories' rank. Otherwise their temporal term halves every halfLifeDays. */
  retention: { halfLifeDays: number | null };
  /** Layer V: the most notes it contributes to one working set. */
  budget: { maxNotes: number };
}

export interface FamiliarAdapterPathwayV1 {
  kind: FamiliarPathwayKind;
  from: string;
  /** For LATERAL the pair is unordered: one entry, one weight, both ways. */
  to: string;
  weight: number;
}

export interface FamiliarAdapterScoringV1 {
  /** S(m|q): the six relevance terms' weights. They sum to one. */
  weights: {
    semantic: number;
    graph: number;
    temporal: number;
    environment: number;
    provenance: number;
    utility: number;
  };
  trust: Record<MemoryTrustClass, number>;
  support: Record<MemorySupportState, number>;
  applicability: Record<FamiliarApplicability, number>;
  /** An association carries this share of its adapter's activation; the primary carries all of its own. */
  associationFactor: number;
  /** The reliance count at which the utility term reaches one half. */
  utilityHalfSaturation: number;
  /** A historical reference's score is scaled by this, except on turns whose intents look back. */
  historicalFactor: number;
  historyIntents: FamiliarTurnIntent[];
}

export interface FamiliarAdapterRegistryV1 {
  kind: "arobi.familiar-adapter-registry";
  version: 1;
  registryVersion: string;
  adapters: FamiliarAdapterV1[];
  pathways: FamiliarAdapterPathwayV1[];
  scoring: FamiliarAdapterScoringV1;
  settle: { passes: number };
  /** The working set: at most this many notes across every adapter. */
  maxNotes: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Registry validation

const ID_RE = /^[a-z][a-z0-9_.-]{0,63}$/;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const MAX_ADAPTERS = 32;
const MAX_RULES = 16;
const MAX_PATHWAYS = 256;
const TIER_RANK: Record<FamiliarAdapterTier, number> = { ASSOCIATION: 1, LIMBIC: 2, EXECUTIVE: 3, MOTOR: 4 };

function fail(code: string, message: string): never {
  throw new FamiliarValidationError(code, message);
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("FMP_ADAPTER_INVALID", `${label} must be an object`);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail("FMP_ADAPTER_INVALID", `${label} must be a plain object`);
  return value as Record<string, unknown>;
}

function inRange(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    fail("FMP_ADAPTER_INVALID", `${label} must be a number from ${min} to ${max}`);
  }
  return value;
}

function integerInRange(value: unknown, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    fail("FMP_ADAPTER_INVALID", `${label} must be an integer from ${min} to ${max}`);
  }
  return value as number;
}

function oneOf<T extends readonly string[]>(value: unknown, values: T, label: string, code = "FMP_ADAPTER_INVALID"): T[number] {
  if (typeof value !== "string" || !values.includes(value)) fail(code, `${label} has unsupported value ${String(value)}`);
  return value as T[number];
}

function enumList<T extends readonly string[]>(value: unknown, values: T, label: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length === 0) fail("FMP_ADAPTER_INVALID", `${label} must be a non-empty array when present`);
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    const checked = oneOf(entry, values, `${label}[${index}]`);
    if (seen.has(checked)) fail("FMP_ADAPTER_INVALID", `${label} lists ${checked} twice`);
    seen.add(checked);
  });
}

function weightMap<T extends readonly string[]>(value: unknown, keys: T, min: number, label: string): void {
  const record = plainRecord(value, label);
  for (const [key, weight] of Object.entries(record)) {
    oneOf(key, keys, `${label} key`);
    inRange(weight, min, 1, `${label}.${key}`);
  }
}

function completeWeightMap<T extends readonly string[]>(value: unknown, keys: T, label: string): void {
  const record = plainRecord(value, label);
  for (const key of Object.keys(record)) oneOf(key, keys, `${label} key`);
  for (const key of keys) inRange(record[key], 0, 1, `${label}.${key}`);
}

function validateRule(value: unknown, label: string): FamiliarAdapterRuleV1 {
  const rule = plainRecord(value, label);
  if (typeof rule.ruleId !== "string" || !ID_RE.test(rule.ruleId)) fail("FMP_ADAPTER_INVALID", `${label}.ruleId must match ${ID_RE}`);
  oneOf(rule.role, ["PRIMARY", "ASSOCIATION"] as const, `${label}.role`);
  integerInRange(rule.priority, 0, 1000, `${label}.priority`);
  enumList(rule.memoryClasses, FAMILIAR_MEMORY_CLASSES, `${label}.memoryClasses`);
  enumList(rule.trustClasses, MEMORY_TRUST_CLASSES, `${label}.trustClasses`);
  enumList(rule.supportStates, MEMORY_SUPPORT_STATES, `${label}.supportStates`);
  enumList(rule.scopeKinds, FAMILIAR_SCOPE_BINDING_KINDS, `${label}.scopeKinds`);
  enumList(rule.lineageIncludes, FAMILIAR_MEMORY_CLASSES, `${label}.lineageIncludes`);
  if (rule.derived !== undefined && typeof rule.derived !== "boolean") fail("FMP_ADAPTER_INVALID", `${label}.derived must be boolean`);
  const constraints = ["memoryClasses", "trustClasses", "supportStates", "scopeKinds", "lineageIncludes", "derived"];
  if (!constraints.some((key) => rule[key] !== undefined)) fail("FMP_ADAPTER_INVALID", `${label} must constrain something`);
  return rule as unknown as FamiliarAdapterRuleV1;
}

/** An unconditional PRIMARY rule constrains the memory class and nothing else, so every class it names has a home. */
function unconditionalPrimary(rule: FamiliarAdapterRuleV1): boolean {
  return (
    rule.role === "PRIMARY" &&
    rule.memoryClasses !== undefined &&
    rule.trustClasses === undefined &&
    rule.supportStates === undefined &&
    rule.scopeKinds === undefined &&
    rule.lineageIncludes === undefined &&
    rule.derived === undefined
  );
}

/**
 * A registry revision is reviewed and digest-pinned like the skills index. Beyond shape, it must route every memory
 * class somewhere (assignment is total), and its pathways must keep the cortical directions: feedforward rises a tier,
 * feedback descends one, lateral joins peers in one tier.
 */
export function assertFamiliarAdapterRegistryV1(value: unknown): asserts value is FamiliarAdapterRegistryV1 {
  const registry = plainRecord(value, "FamiliarAdapterRegistryV1");
  if (registry.kind !== "arobi.familiar-adapter-registry") fail("FMP_ADAPTER_INVALID", "kind must be arobi.familiar-adapter-registry");
  if (registry.version !== 1) fail("FMP_ADAPTER_INVALID", "version must be 1");
  if (typeof registry.registryVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(registry.registryVersion)) {
    fail("FMP_ADAPTER_INVALID", "registryVersion must be MAJOR.MINOR.PATCH");
  }
  const adapters = registry.adapters;
  if (!Array.isArray(adapters) || adapters.length === 0 || adapters.length > MAX_ADAPTERS) {
    fail("FMP_ADAPTER_INVALID", `adapters must hold 1 to ${MAX_ADAPTERS} entries`);
  }
  const tiers = new Map<string, FamiliarAdapterTier>();
  const ruleIds = new Set<string>();
  const homed = new Set<string>();
  adapters.forEach((entry, index) => {
    const label = `adapters[${index}]`;
    const adapter = plainRecord(entry, label);
    if (typeof adapter.adapterId !== "string" || !ID_RE.test(adapter.adapterId)) fail("FMP_ADAPTER_INVALID", `${label}.adapterId must match ${ID_RE}`);
    if (tiers.has(adapter.adapterId)) fail("FMP_ADAPTER_INVALID", `adapterId ${adapter.adapterId} appears twice`);
    oneOf(adapter.family, FAMILIAR_ADAPTER_FAMILIES, `${label}.family`);
    tiers.set(adapter.adapterId, oneOf(adapter.tier, FAMILIAR_ADAPTER_TIERS, `${label}.tier`));
    if (typeof adapter.purpose !== "string" || adapter.purpose.trim() === "" || adapter.purpose.length > 280) {
      fail("FMP_ADAPTER_INVALID", `${label}.purpose must be a sentence of at most 280 characters`);
    }
    const rules = adapter.rules;
    if (!Array.isArray(rules) || rules.length > MAX_RULES) fail("FMP_ADAPTER_INVALID", `${label}.rules must hold at most ${MAX_RULES}`);
    rules.forEach((ruleValue, ruleIndex) => {
      const rule = validateRule(ruleValue, `${label}.rules[${ruleIndex}]`);
      if (ruleIds.has(rule.ruleId)) fail("FMP_ADAPTER_INVALID", `ruleId ${rule.ruleId} appears twice`);
      ruleIds.add(rule.ruleId);
      if (unconditionalPrimary(rule)) for (const memoryClass of rule.memoryClasses ?? []) homed.add(memoryClass);
    });
    const receptors = plainRecord(adapter.receptors, `${label}.receptors`);
    weightMap(receptors.intents, FAMILIAR_TURN_INTENTS, 0, `${label}.receptors.intents`);
    weightMap(receptors.channels, FAMILIAR_RECEPTOR_CHANNELS, 0, `${label}.receptors.channels`);
    weightMap(adapter.modulation, FAMILIAR_MODULATORS, -1, `${label}.modulation`);
    const retention = plainRecord(adapter.retention, `${label}.retention`);
    if (retention.halfLifeDays !== null) inRange(retention.halfLifeDays, 1 / 24, 36_500, `${label}.retention.halfLifeDays`);
    integerInRange(plainRecord(adapter.budget, `${label}.budget`).maxNotes, 1, 20, `${label}.budget.maxNotes`);
  });
  for (const memoryClass of FAMILIAR_MEMORY_CLASSES) {
    if (!homed.has(memoryClass)) fail("FMP_ADAPTER_UNHOMED_CLASS", `no unconditional PRIMARY rule routes ${memoryClass}`);
  }

  const pathways = registry.pathways;
  if (!Array.isArray(pathways) || pathways.length > MAX_PATHWAYS) fail("FMP_ADAPTER_INVALID", `pathways must hold at most ${MAX_PATHWAYS}`);
  const seenPathways = new Set<string>();
  pathways.forEach((entry, index) => {
    const label = `pathways[${index}]`;
    const pathway = plainRecord(entry, label);
    const kind = oneOf(pathway.kind, FAMILIAR_PATHWAY_KINDS, `${label}.kind`);
    const from = tiers.get(String(pathway.from));
    const to = tiers.get(String(pathway.to));
    if (!from || !to) fail("FMP_ADAPTER_INVALID", `${label} must join two adapters in the registry`);
    if (pathway.from === pathway.to) fail("FMP_ADAPTER_INVALID", `${label} must join two different adapters`);
    inRange(pathway.weight, Number.MIN_VALUE, 1, `${label}.weight`);
    if (kind === "FEEDFORWARD" && !(TIER_RANK[from] < TIER_RANK[to])) fail("FMP_ADAPTER_PATHWAY_DIRECTION", `${label}: feedforward must rise to a higher tier`);
    if (kind === "FEEDBACK" && !(TIER_RANK[from] > TIER_RANK[to])) fail("FMP_ADAPTER_PATHWAY_DIRECTION", `${label}: feedback must descend to a lower tier`);
    if (kind === "LATERAL" && from !== to) fail("FMP_ADAPTER_PATHWAY_DIRECTION", `${label}: lateral links join peers in one tier`);
    const key = kind === "LATERAL" ? `LATERAL:${[pathway.from, pathway.to].sort().join("|")}` : `${kind}:${pathway.from}>${pathway.to}`;
    if (seenPathways.has(key)) fail("FMP_ADAPTER_INVALID", `${label} repeats a pathway`);
    seenPathways.add(key);
  });

  const scoring = plainRecord(registry.scoring, "scoring");
  const weights = plainRecord(scoring.weights, "scoring.weights");
  const termNames = ["semantic", "graph", "temporal", "environment", "provenance", "utility"] as const;
  for (const key of Object.keys(weights)) oneOf(key, termNames, "scoring.weights key");
  const total = termNames.reduce((sum, term) => sum + inRange(weights[term], 0, 1, `scoring.weights.${term}`), 0);
  if (Math.abs(total - 1) > 1e-9) fail("FMP_ADAPTER_INVALID", "scoring.weights must sum to 1");
  completeWeightMap(scoring.trust, MEMORY_TRUST_CLASSES, "scoring.trust");
  completeWeightMap(scoring.support, MEMORY_SUPPORT_STATES, "scoring.support");
  completeWeightMap(scoring.applicability, FAMILIAR_APPLICABILITY, "scoring.applicability");
  inRange(scoring.associationFactor, 0, 1, "scoring.associationFactor");
  inRange(scoring.utilityHalfSaturation, Number.MIN_VALUE, 1_000, "scoring.utilityHalfSaturation");
  inRange(scoring.historicalFactor, 0, 1, "scoring.historicalFactor");
  if (!Array.isArray(scoring.historyIntents)) fail("FMP_ADAPTER_INVALID", "scoring.historyIntents must be an array");
  if (scoring.historyIntents.length > 0) enumList(scoring.historyIntents, FAMILIAR_TURN_INTENTS, "scoring.historyIntents");
  integerInRange(plainRecord(registry.settle, "settle").passes, 1, 4, "settle.passes");
  integerInRange(registry.maxNotes, 1, 50, "maxNotes");
}

const registryDigests = new WeakMap<FamiliarAdapterRegistryV1, Digest>();
const validatedRegistries = new WeakSet<FamiliarAdapterRegistryV1>();

/** A registry is validated before it routes anything; a frozen one only once. */
function checkedRegistry(registry: FamiliarAdapterRegistryV1): FamiliarAdapterRegistryV1 {
  if (validatedRegistries.has(registry)) return registry;
  assertFamiliarAdapterRegistryV1(registry);
  if (Object.isFrozen(registry)) validatedRegistries.add(registry);
  return registry;
}

/** The digest a registry revision is pinned and recorded by. */
export function familiarAdapterRegistryDigest(registry: FamiliarAdapterRegistryV1): Digest {
  const cached = registryDigests.get(registry);
  if (cached) return cached;
  const computed = sha256DomainDigestCanonical("arobi.familiar-adapter-registry.v1", registry);
  if (Object.isFrozen(registry)) registryDigests.set(registry, computed);
  return computed;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

// ---------------------------------------------------------------------------------------------------------------
// The registry every familiar starts with: nine adapters, all empty until memories exist. Its weights are starting
// values, recorded with the reason for each, and calibrated by evaluation (ArobiMemBench) in reviewed revisions.

export const FAMILIAR_ADAPTER_REGISTRY_V1: FamiliarAdapterRegistryV1 = deepFreeze({
  kind: "arobi.familiar-adapter-registry",
  version: 1,
  registryVersion: "1.0.0",
  adapters: [
    {
      adapterId: "environmental",
      family: "ENVIRONMENTAL",
      tier: "ASSOCIATION",
      purpose: "Observations about the application, tool, runtime or situation the work runs in.",
      rules: [
        { ruleId: "environmental.observation", role: "PRIMARY", priority: 100, memoryClasses: ["EXTERNAL_OBSERVATION"] },
        { ruleId: "environmental.bound", role: "ASSOCIATION", priority: 0, scopeKinds: ["APPLICATION", "RUNTIME"] },
      ],
      receptors: { intents: { BUILD: 0.5, ACT: 0.6, REVIEW: 0.3 }, channels: { TOOLS: 0.4, ENVIRONMENT: 0.8, CONTENT: 0.5 } },
      modulation: { NOVELTY: 0.2, RISK: 0.2 },
      // An environment changes under it: last month's reading of a runtime matters less than this week's.
      retention: { halfLifeDays: 30 },
      budget: { maxNotes: 2 },
    },
    {
      adapterId: "project",
      family: "PROJECT",
      tier: "ASSOCIATION",
      purpose: "The history, constraints, decisions and current state of a project, repository or brand.",
      rules: [{ ruleId: "project.bound", role: "ASSOCIATION", priority: 0, scopeKinds: ["PROJECT", "REPOSITORY", "BRAND"] }],
      receptors: { intents: { BUILD: 0.6, PLAN: 0.6, CREATE: 0.3, REVIEW: 0.4 }, channels: { ENVIRONMENT: 0.8, CONTENT: 0.5 } },
      modulation: { URGENCY: 0.2 },
      // A project's early decisions still bind it; whether they still apply is the environment term's question.
      retention: { halfLifeDays: null },
      budget: { maxNotes: 2 },
    },
    {
      adapterId: "episodic",
      family: "EPISODIC",
      tier: "ASSOCIATION",
      purpose: "What happened: events, actions, the evidence they left, and what followed.",
      rules: [
        { ruleId: "episodic.event", role: "PRIMARY", priority: 100, memoryClasses: ["EPISODIC", "EVIDENCE", "AUTHORITY_REFERENCE"] },
        // Derived memory keeps a pathway back to the episodes it came from.
        { ruleId: "episodic.lineage", role: "ASSOCIATION", priority: 0, derived: true, lineageIncludes: ["EPISODIC", "EVIDENCE"] },
      ],
      receptors: { intents: { RECALL: 0.9, REVIEW: 0.6, PLAN: 0.2 }, channels: { CONTENT: 0.7 } },
      modulation: { NOVELTY: 0.3, RISK: 0.3 },
      retention: { halfLifeDays: 120 },
      budget: { maxNotes: 2 },
    },
    {
      adapterId: "semantic",
      family: "SEMANTIC",
      tier: "ASSOCIATION",
      purpose: "What is known: relationships, and inferences that evidence has corroborated.",
      rules: [
        // An inference becomes knowledge when evidence corroborates it, and is routed here from then on.
        { ruleId: "semantic.corroborated-inference", role: "PRIMARY", priority: 300, memoryClasses: ["HYPOTHESIS"], supportStates: ["CORROBORATED"] },
        { ruleId: "semantic.relationship", role: "PRIMARY", priority: 100, memoryClasses: ["RELATIONSHIP"] },
      ],
      receptors: { intents: { BUILD: 0.4, RECALL: 0.4, PLAN: 0.3, REVIEW: 0.3, CREATE: 0.2 }, channels: { CONTENT: 0.8 } },
      modulation: { NOVELTY: 0.3 },
      retention: { halfLifeDays: null },
      budget: { maxNotes: 2 },
    },
    {
      adapterId: "creative",
      family: "CREATIVE",
      tier: "ASSOCIATION",
      purpose: "Ideas, designs, alternatives and experiments, kept for recombination however old they are.",
      rules: [
        { ruleId: "creative.idea", role: "PRIMARY", priority: 100, memoryClasses: ["HYPOTHESIS"] },
        { ruleId: "creative.lineage", role: "ASSOCIATION", priority: 0, lineageIncludes: ["HYPOTHESIS"] },
      ],
      receptors: { intents: { CREATE: 0.9, PLAN: 0.3 }, channels: { CONTENT: 0.6 } },
      // Under risk or urgency the brain leans on what is known and tested, not on what is merely possible.
      modulation: { NOVELTY: 0.2, RISK: -0.4, URGENCY: -0.3 },
      retention: { halfLifeDays: null },
      budget: { maxNotes: 2 },
    },
    {
      adapterId: "autobiographical",
      family: "AUTOBIOGRAPHICAL",
      tier: "LIMBIC",
      purpose: "Approved identity, enduring preferences and personal continuity.",
      rules: [
        { ruleId: "autobiographical.identity", role: "PRIMARY", priority: 100, memoryClasses: ["CORE", "PREFERENCE"] },
        { ruleId: "autobiographical.stated-relationship", role: "ASSOCIATION", priority: 0, memoryClasses: ["RELATIONSHIP"], trustClasses: ["OPERATOR_AUTHORED"] },
      ],
      receptors: { intents: { PERSONAL: 0.9, CREATE: 0.3, PLAN: 0.3 }, channels: { CONTENT: 0.5 } },
      modulation: { SALIENCE: 0.3 },
      retention: { halfLifeDays: null },
      budget: { maxNotes: 1 },
    },
    {
      adapterId: "reflective",
      family: "REFLECTIVE",
      tier: "LIMBIC",
      purpose: "Evaluations of earlier reasoning, decisions and outcomes, and the conflicts still open.",
      rules: [
        // An interpretation grounded in outcome evidence is an evaluation of what happened.
        { ruleId: "reflective.outcome-interpretation", role: "PRIMARY", priority: 200, memoryClasses: ["HYPOTHESIS"], lineageIncludes: ["EVIDENCE"] },
        // The conflict monitor: contested memory stays visible here until it is resolved.
        { ruleId: "reflective.contested", role: "ASSOCIATION", priority: 0, supportStates: ["CONTESTED"] },
      ],
      receptors: { intents: { REVIEW: 0.9, BUILD: 0.3, PLAN: 0.3 }, channels: { CONTENT: 0.5 } },
      modulation: { REWARD: 0.2, RISK: 0.5, SALIENCE: 0.2, URGENCY: -0.2 },
      retention: { halfLifeDays: 180 },
      budget: { maxNotes: 1 },
    },
    {
      adapterId: "active_thought",
      family: "ACTIVE_THOUGHT",
      tier: "EXECUTIVE",
      purpose: "The live task's working state: what this task has already produced and decided.",
      // A memory bound to a task joins that task's working set, and only while the turn runs in that task.
      rules: [{ ruleId: "active_thought.task", role: "ASSOCIATION", priority: 0, scopeKinds: ["TASK"] }],
      receptors: { intents: { BUILD: 0.4, CREATE: 0.4, PLAN: 0.5, ACT: 0.4 }, channels: { TASK: 0.9, CONTENT: 0.5 } },
      modulation: { URGENCY: 0.4 },
      // Working state is compact: yesterday's working set is history, not thought.
      retention: { halfLifeDays: 1 },
      budget: { maxNotes: 2 },
    },
    {
      adapterId: "procedural",
      family: "PROCEDURAL",
      tier: "MOTOR",
      purpose: "How to do things: methods, workflows and skills, under the conditions they were learned in.",
      rules: [{ ruleId: "procedural.method", role: "PRIMARY", priority: 100, memoryClasses: ["PROCEDURAL", "SKILL"] }],
      receptors: { intents: { BUILD: 0.7, ACT: 0.9, CREATE: 0.3 }, channels: { TOOLS: 0.9, CONTENT: 0.5 } },
      modulation: { REWARD: 0.3, RISK: 0.2, URGENCY: 0.3 },
      // A method does not wear out with age; it is revalidated when what it depended on changes.
      retention: { halfLifeDays: null },
      budget: { maxNotes: 2 },
    },
  ],
  pathways: [
    // Feedforward: evidence rises from what happened and where, through evaluation, to the working set and to action.
    { kind: "FEEDFORWARD", from: "episodic", to: "reflective", weight: 0.2 },
    { kind: "FEEDFORWARD", from: "semantic", to: "reflective", weight: 0.1 },
    { kind: "FEEDFORWARD", from: "episodic", to: "autobiographical", weight: 0.1 },
    { kind: "FEEDFORWARD", from: "project", to: "active_thought", weight: 0.2 },
    { kind: "FEEDFORWARD", from: "environmental", to: "active_thought", weight: 0.15 },
    { kind: "FEEDFORWARD", from: "semantic", to: "active_thought", weight: 0.1 },
    { kind: "FEEDFORWARD", from: "reflective", to: "active_thought", weight: 0.15 },
    { kind: "FEEDFORWARD", from: "autobiographical", to: "active_thought", weight: 0.1 },
    { kind: "FEEDFORWARD", from: "active_thought", to: "procedural", weight: 0.3 },
    // Feedback: the working set's attention reaches back down; evaluation recalls episodes; preference shapes ideas.
    { kind: "FEEDBACK", from: "active_thought", to: "project", weight: 0.15 },
    { kind: "FEEDBACK", from: "active_thought", to: "episodic", weight: 0.1 },
    { kind: "FEEDBACK", from: "active_thought", to: "semantic", weight: 0.1 },
    { kind: "FEEDBACK", from: "active_thought", to: "environmental", weight: 0.1 },
    { kind: "FEEDBACK", from: "procedural", to: "active_thought", weight: 0.1 },
    { kind: "FEEDBACK", from: "reflective", to: "episodic", weight: 0.1 },
    { kind: "FEEDBACK", from: "autobiographical", to: "creative", weight: 0.1 },
    // Lateral, symmetric: an idea and a related fact, an episode and its project, a project and its environment.
    { kind: "LATERAL", from: "creative", to: "semantic", weight: 0.2 },
    { kind: "LATERAL", from: "episodic", to: "project", weight: 0.2 },
    { kind: "LATERAL", from: "environmental", to: "project", weight: 0.25 },
    { kind: "LATERAL", from: "episodic", to: "semantic", weight: 0.15 },
    { kind: "LATERAL", from: "autobiographical", to: "reflective", weight: 0.1 },
  ],
  scoring: {
    weights: { semantic: 0.35, graph: 0.1, temporal: 0.15, environment: 0.15, provenance: 0.15, utility: 0.1 },
    trust: { OPERATOR_AUTHORED: 1, VERIFIED_SYSTEM: 1, OBSERVED: 0.8, DERIVED: 0.6, EXTERNAL_UNTRUSTED: 0.3 },
    support: { CORROBORATED: 1, OBSERVED: 0.85, ASSERTED: 0.7, CONTESTED: 0.4, SUPERSEDED: 0.2, QUARANTINED: 0, FORGOTTEN: 0 },
    applicability: { MATCH: 1, PARTIAL: 0.6, UNSCOPED: 0.5, CONFLICT: 0.2, OUT_OF_SCOPE: 0 },
    associationFactor: 0.7,
    utilityHalfSaturation: 3,
    historicalFactor: 0.25,
    historyIntents: ["RECALL", "REVIEW"],
  },
  settle: { passes: 3 },
  maxNotes: 6,
});

// The pin: a registry revision changes this digest, and the change is reviewed with the code that uses it.
export const FAMILIAR_ADAPTER_REGISTRY_V1_DIGEST: Digest =
  "sha256:ea7fcac28a428ef545fbe986a6d668330253eeb73e692ae40aed2971e39271fe";

// ---------------------------------------------------------------------------------------------------------------
// Assignment: which adapters a memory belongs to, computed and explained, never stored

/** Resolves a source artifact digest to its memory class, when that artifact is in the familiar's scoped store. */
export interface FamiliarLineageView {
  classOf(artifactDigest: Digest): FamiliarMemoryClass | undefined;
}

/** A lineage view over memories already in hand, keyed by their canonical artifact digests. */
export function familiarLineageFrom(memories: readonly FamiliarMemoryArtifactV1[]): FamiliarLineageView {
  const classes = new Map<Digest, FamiliarMemoryClass>();
  for (const memory of memories) classes.set(sha256DigestCanonical(memory), memory.memoryClass);
  return { classOf: (artifactDigest) => classes.get(artifactDigest) };
}

export interface FamiliarAssignmentHistory {
  lineage?: FamiliarLineageView;
  /** How many context-use receipts relied upon this memory. */
  reliedUpon?: number;
}

export interface FamiliarAdapterMembershipV1 {
  adapterId: string;
  family: FamiliarAdapterFamily;
  /** The rule that placed it there. */
  ruleId: string;
}

export interface FamiliarAdapterAssignmentV1 {
  kind: "arobi.familiar-adapter-assignment";
  version: 1;
  registryDigest: Digest;
  memoryId: string;
  revision: number;
  primary: FamiliarAdapterMembershipV1;
  /** Every other adapter a rule places it in, in registry order, one membership each. */
  associations: FamiliarAdapterMembershipV1[];
  lifecycle: FamiliarLifecycleStage;
}

function sourceClassesOf(memory: FamiliarMemoryArtifactV1, lineage: FamiliarLineageView | undefined): Set<FamiliarMemoryClass> {
  const classes = new Set<FamiliarMemoryClass>();
  if (!lineage) return classes;
  for (const source of memory.sourceArtifacts) {
    const memoryClass = lineage.classOf(source);
    if (memoryClass) classes.add(memoryClass);
  }
  return classes;
}

function ruleMatches(rule: FamiliarAdapterRuleV1, memory: FamiliarMemoryArtifactV1, sources: Set<FamiliarMemoryClass>): boolean {
  if (rule.memoryClasses && !rule.memoryClasses.includes(memory.memoryClass)) return false;
  if (rule.trustClasses && !rule.trustClasses.includes(memory.trustClass)) return false;
  if (rule.supportStates && !rule.supportStates.includes(memory.supportState)) return false;
  if (rule.scopeKinds && !(memory.scope?.bindings ?? []).some((binding) => rule.scopeKinds!.includes(binding.kind))) return false;
  if (rule.lineageIncludes && !rule.lineageIncludes.some((memoryClass) => sources.has(memoryClass))) return false;
  if (rule.derived !== undefined && (memory.transformationChain.length > 0) !== rule.derived) return false;
  return true;
}

function reliance(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0) fail("FMP_ROUTE_INVALID", "reliedUpon must be a non-negative integer");
  return value;
}

function lifecycleOf(memory: FamiliarMemoryArtifactV1, reliedUpon: number): FamiliarLifecycleStage {
  switch (memory.supportState) {
    case "CONTESTED":
    case "SUPERSEDED":
    case "QUARANTINED":
    case "FORGOTTEN":
      return memory.supportState;
    case "CORROBORATED":
      return reliedUpon > 0 ? "APPLIED" : "VALIDATED";
    default:
      // ASSERTED or OBSERVED. An inference, or anything derived, is a candidate until evidence corroborates it, and
      // relying on it does not make it so. An original record is captured, and applied once something relied on it.
      if (memory.memoryClass === "HYPOTHESIS" || memory.transformationChain.length > 0) return "UNDER_EVALUATION";
      return reliedUpon > 0 ? "APPLIED" : "CAPTURED";
  }
}

/**
 * The adapters a memory belongs to, from the memory, its lineage and its use, under one registry. The same history
 * always gives the same assignment, and every membership names the rule that made it: the highest-priority matching
 * PRIMARY rule places the primary, and each other adapter with a matching rule (an ASSOCIATION rule, or a PRIMARY
 * rule that was outranked) holds one association, so a memory keeps a pathway to where it came from.
 */
export function assignFamiliarAdapters(
  memory: FamiliarMemoryArtifactV1,
  registry: FamiliarAdapterRegistryV1 = FAMILIAR_ADAPTER_REGISTRY_V1,
  history: FamiliarAssignmentHistory = {},
): FamiliarAdapterAssignmentV1 {
  return assignWith(memory, checkedRegistry(registry), history);
}

function assignWith(
  memory: FamiliarMemoryArtifactV1,
  registry: FamiliarAdapterRegistryV1,
  history: FamiliarAssignmentHistory,
): FamiliarAdapterAssignmentV1 {
  const sources = sourceClassesOf(memory, history.lineage);
  let primary: { adapter: FamiliarAdapterV1; rule: FamiliarAdapterRuleV1 } | null = null;
  for (const adapter of registry.adapters) {
    for (const rule of adapter.rules) {
      if (rule.role !== "PRIMARY" || !ruleMatches(rule, memory, sources)) continue;
      if (!primary || rule.priority > primary.rule.priority) primary = { adapter, rule };
    }
  }
  if (!primary) fail("FMP_ADAPTER_UNHOMED_CLASS", `no PRIMARY rule routes ${memory.memoryClass}`);
  const associations: FamiliarAdapterMembershipV1[] = [];
  for (const adapter of registry.adapters) {
    if (adapter.adapterId === primary.adapter.adapterId) continue;
    const rule = adapter.rules.find((candidate) => ruleMatches(candidate, memory, sources));
    if (rule) associations.push({ adapterId: adapter.adapterId, family: adapter.family, ruleId: rule.ruleId });
  }
  return {
    kind: "arobi.familiar-adapter-assignment",
    version: 1,
    registryDigest: familiarAdapterRegistryDigest(registry),
    memoryId: memory.memoryId,
    revision: memory.revision,
    primary: { adapterId: primary.adapter.adapterId, family: primary.adapter.family, ruleId: primary.rule.ruleId },
    associations,
    lifecycle: lifecycleOf(memory, reliance(history.reliedUpon)),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The four properties a memory never collapses into one score. Historical truth is the canonical record itself
// (support, trust, sources); permitted use stays with the context boundary and Immaculate. These two are computed.

/** The environment a turn runs in: what it is bound to, and the facts observed about it now. */
export interface FamiliarEnvironmentV1 {
  bindings: FamiliarScopeBindingV1[];
  facts: FamiliarScopeDependencyV1[];
}

export interface FamiliarApplicabilityV1 {
  applicability: FamiliarApplicability;
  /** The memory is bound to the task the turn runs in. */
  sameTask: boolean;
  /** Binding kinds the turn is bound to differently. */
  mismatched: FamiliarScopeBindingKind[];
  /** Dependencies whose observed value has changed since. */
  changed: string[];
}

/**
 * Does a memory apply where the turn runs. A different project, repository, application, runtime or brand puts it out
 * of scope; a dependency whose value changed puts it in conflict (it held then, and may not now); a binding or
 * dependency the turn cannot observe leaves it partial. A task binding never excludes: an earlier task in the same
 * project is still relevant, and the task only decides whether the memory is part of the live working set.
 */
export function familiarMemoryApplicability(
  scope: FamiliarMemoryScopeV1 | undefined,
  environment: FamiliarEnvironmentV1 | undefined,
): FamiliarApplicabilityV1 {
  if (!scope) return { applicability: "UNSCOPED", sameTask: false, mismatched: [], changed: [] };
  const bound = new Map((environment?.bindings ?? []).map((binding) => [binding.kind, binding.id]));
  const facts = new Map((environment?.facts ?? []).map((fact) => [fact.name, fact.digest]));
  let matched = 0;
  let unknown = 0;
  let sameTask = false;
  const mismatched: FamiliarScopeBindingKind[] = [];
  for (const binding of scope.bindings) {
    const current = bound.get(binding.kind);
    if (binding.kind === "TASK") {
      sameTask = current === binding.id;
      if (sameTask) matched += 1;
      else unknown += 1;
      continue;
    }
    if (current === undefined) unknown += 1;
    else if (current === binding.id) matched += 1;
    else mismatched.push(binding.kind);
  }
  const changed: string[] = [];
  for (const dependency of scope.dependencies) {
    const current = facts.get(dependency.name);
    if (current === undefined) unknown += 1;
    else if (current === dependency.digest) matched += 1;
    else changed.push(dependency.name);
  }
  mismatched.sort();
  changed.sort();
  let applicability: FamiliarApplicability;
  if (mismatched.length > 0) applicability = "OUT_OF_SCOPE";
  else if (changed.length > 0) applicability = "CONFLICT";
  else if (matched > 0 && unknown === 0) applicability = "MATCH";
  else applicability = "PARTIAL";
  return { applicability, sameTask, mismatched, changed };
}

/**
 * Is a memory still correct, as far as its canonical record and the environment can tell. A conflict with the
 * environment means it needs revalidation: what it said was true then, and the conditions it depended on changed.
 */
export function familiarMemoryValidity(
  memory: FamiliarMemoryArtifactV1,
  applicability: FamiliarApplicability,
  nowMillis: number,
): FamiliarValidity {
  if (memory.supportState === "QUARANTINED" || memory.supportState === "FORGOTTEN") return "WITHDRAWN";
  if (memory.supportState === "SUPERSEDED" || memory.supersededBy !== undefined) return "SUPERSEDED";
  if (memory.supportState === "CONTESTED") return "CONTESTED";
  if (memory.expiresAt !== undefined) {
    const expiry = Date.parse(memory.expiresAt);
    // A malformed expiry fails closed, as retrieval does.
    if (!Number.isFinite(expiry) || expiry <= nowMillis) return "EXPIRED";
  }
  if (applicability === "CONFLICT") return "NEEDS_REVALIDATION";
  return "CURRENT";
}

// ---------------------------------------------------------------------------------------------------------------
// The turn, and how the adapters settle on it

export interface FamiliarTurnV1 {
  /** The turn's time. Routing never reads a clock, so a replayed turn routes the same way. */
  now: string;
  intents: FamiliarTurnIntent[];
  /** Tools in play this turn. */
  tools: string[];
  environment?: FamiliarEnvironmentV1;
  /** Layer I signals from 0 to 1: novelty from the subconscious check, risk from the risk ceiling and Crucible, ... */
  modulators?: Partial<Record<FamiliarModulator, number>>;
}

interface NormalizedTurn {
  now: string;
  nowMillis: number;
  intents: FamiliarTurnIntent[];
  tools: string[];
  environment: FamiliarEnvironmentV1;
  modulators: Partial<Record<FamiliarModulator, number>>;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Six decimals: enough for ranking, and a digest that does not move with the last bit of a platform's arithmetic. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function normalizeTurn(turn: FamiliarTurnV1): NormalizedTurn {
  if (typeof turn.now !== "string" || !ISO_UTC_RE.test(turn.now) || !Number.isFinite(Date.parse(turn.now))) {
    fail("FMP_ROUTE_INVALID", "turn.now must be an ISO-8601 UTC timestamp");
  }
  if (!Array.isArray(turn.intents)) fail("FMP_ROUTE_INVALID", "turn.intents must be an array");
  const intents = new Set<FamiliarTurnIntent>();
  turn.intents.forEach((intent, index) => intents.add(oneOf(intent, FAMILIAR_TURN_INTENTS, `turn.intents[${index}]`, "FMP_ROUTE_INVALID")));
  if (!Array.isArray(turn.tools) || turn.tools.some((tool) => typeof tool !== "string" || tool.trim() === "")) {
    fail("FMP_ROUTE_INVALID", "turn.tools must be an array of tool names");
  }
  const bindings = turn.environment?.bindings ?? [];
  const facts = turn.environment?.facts ?? [];
  if (!Array.isArray(bindings) || !Array.isArray(facts)) fail("FMP_ROUTE_INVALID", "turn.environment must hold bindings and facts arrays");
  const kinds = new Set<string>();
  for (const binding of bindings) {
    const kind = oneOf(binding?.kind, FAMILIAR_SCOPE_BINDING_KINDS, "turn.environment binding kind", "FMP_ROUTE_INVALID");
    if (kinds.has(kind)) fail("FMP_ROUTE_INVALID", `turn.environment binds ${kind} twice`);
    kinds.add(kind);
    if (typeof binding.id !== "string" || binding.id.trim() === "") fail("FMP_ROUTE_INVALID", "turn.environment binding ids must be non-empty");
  }
  const names = new Set<string>();
  for (const fact of facts) {
    if (typeof fact?.name !== "string" || fact.name.trim() === "" || names.has(fact.name)) {
      fail("FMP_ROUTE_INVALID", "turn.environment facts need unique, non-empty names");
    }
    names.add(fact.name);
    if (!isDigest(fact.digest)) fail("FMP_ROUTE_INVALID", `turn.environment fact ${fact.name} needs a sha256 digest`);
  }
  const modulators: Partial<Record<FamiliarModulator, number>> = {};
  for (const [key, value] of Object.entries(turn.modulators ?? {})) {
    const modulator = oneOf(key, FAMILIAR_MODULATORS, "turn.modulators key", "FMP_ROUTE_INVALID");
    if (typeof value !== "number" || !Number.isFinite(value)) fail("FMP_ROUTE_INVALID", `turn.modulators.${key} must be a finite number`);
    modulators[modulator] = clamp01(value);
  }
  return {
    now: turn.now,
    nowMillis: Date.parse(turn.now),
    intents: FAMILIAR_TURN_INTENTS.filter((intent) => intents.has(intent)),
    tools: [...new Set(turn.tools)].sort(),
    environment: {
      bindings: [...bindings].map(({ kind, id }) => ({ kind, id })).sort((a, b) => a.kind.localeCompare(b.kind)),
      facts: [...facts].map(({ name, digest }) => ({ name, digest })).sort((a, b) => a.name.localeCompare(b.name)),
    },
    modulators,
  };
}

export interface FamiliarAdapterActivationV1 {
  adapterId: string;
  family: FamiliarAdapterFamily;
  tier: FamiliarAdapterTier;
  /** Layer IV: how strongly the turn's own features excite it, from 0 to 1. */
  receptor: number;
  /** Layer I: the modulators' scaling of everything it receives, from 0 to 2. */
  gain: number;
  /** After the settle, from 0 to 1. */
  activation: number;
}

/**
 * The deterministic settle. Receptors combine their channels as independent causes (noisy-or), so no channel can push
 * a receptor past one:  r_i = 1 - prod_c (1 - w_ic * x_c).  Then, in a fixed number of synchronous passes,
 *   a_i <- clamp( g_i * ( r_i + sum_j W_ff[j->i] a_j + sum_k W_lat[k<->i] a_k + sum_h W_fb[h->i] a_h ), 0, 1 )
 * with every input read from the previous pass, so the order adapters are listed in never changes the result. The
 * gain multiplies what the adapter receives, so a modulator cannot excite an adapter nothing else excites.
 */
function settle(
  registry: FamiliarAdapterRegistryV1,
  turn: NormalizedTurn,
  contentMatch: ReadonlyMap<string, number>,
): FamiliarAdapterActivationV1[] {
  const hasEnvironment = turn.environment.bindings.some((binding) => binding.kind !== "TASK");
  const hasTask = turn.environment.bindings.some((binding) => binding.kind === "TASK");
  const channelInput: Record<FamiliarReceptorChannel, (adapterId: string) => number> = {
    TOOLS: () => (turn.tools.length > 0 ? 1 : 0),
    ENVIRONMENT: () => (hasEnvironment ? 1 : 0),
    TASK: () => (hasTask ? 1 : 0),
    CONTENT: (adapterId) => clamp01(contentMatch.get(adapterId) ?? 0),
  };
  const index = new Map(registry.adapters.map((adapter, position) => [adapter.adapterId, position]));
  const inputs: Array<Array<{ from: number; weight: number }>> = registry.adapters.map(() => []);
  for (const pathway of registry.pathways) {
    const from = index.get(pathway.from)!;
    const to = index.get(pathway.to)!;
    inputs[to].push({ from, weight: pathway.weight });
    if (pathway.kind === "LATERAL") inputs[from].push({ from: to, weight: pathway.weight });
  }
  const receptors = registry.adapters.map((adapter) => {
    let quiet = 1;
    for (const intent of turn.intents) quiet *= 1 - (adapter.receptors.intents[intent] ?? 0);
    for (const channel of FAMILIAR_RECEPTOR_CHANNELS) {
      quiet *= 1 - (adapter.receptors.channels[channel] ?? 0) * channelInput[channel](adapter.adapterId);
    }
    return clamp01(1 - quiet);
  });
  const gains = registry.adapters.map((adapter) => {
    let gain = 1;
    for (const modulator of FAMILIAR_MODULATORS) gain += (adapter.modulation[modulator] ?? 0) * (turn.modulators[modulator] ?? 0);
    return gain < 0 ? 0 : gain > 2 ? 2 : gain;
  });
  let activation = receptors.map((receptor, position) => clamp01(gains[position] * receptor));
  for (let pass = 0; pass < registry.settle.passes; pass += 1) {
    const previous = activation;
    activation = registry.adapters.map((_, position) => {
      let received = receptors[position];
      for (const input of inputs[position]) received += input.weight * previous[input.from];
      return clamp01(gains[position] * received);
    });
  }
  return registry.adapters.map((adapter, position) => ({
    adapterId: adapter.adapterId,
    family: adapter.family,
    tier: adapter.tier,
    receptor: round6(receptors[position]),
    gain: round6(gains[position]),
    activation: round6(activation[position]),
  }));
}

// ---------------------------------------------------------------------------------------------------------------
// Routing: relevance within the adapters, bounded by their budgets. Candidates, never admissions.

/** What the caller's own indexes say about a candidate: lexical or vector similarity, graph proximity, prior use. */
export interface FamiliarRouteSignalsV1 {
  /** Similarity to the turn's content, from 0 to 1. */
  semantic?: number;
  /** Proximity in the memory graph to what the turn touches, from 0 to 1. */
  graph?: number;
  /** How many context-use receipts relied upon this memory. */
  reliedUpon?: number;
}

export interface FamiliarRouteTermsV1 {
  semantic: number;
  graph: number;
  temporal: number;
  environment: number;
  provenance: number;
  utility: number;
}

export interface FamiliarRouteCandidateV1 {
  artifactDigest: Digest;
  memoryId: string;
  /** The pathway that carried it: its primary adapter, an association, or the live task's working set. */
  contributor: FamiliarAdapterMembershipV1 & { via: "PRIMARY" | "ASSOCIATION" };
  primary: FamiliarAdapterMembershipV1;
  associations: FamiliarAdapterMembershipV1[];
  lifecycle: FamiliarLifecycleStage;
  applicability: FamiliarApplicability;
  validity: FamiliarValidity;
  use: FamiliarMemoryUse;
  terms: FamiliarRouteTermsV1;
  /** S(m|q), the weighted sum of the terms. */
  relevance: number;
  /** The contributing pathway's activation. */
  activation: number;
  score: number;
}

export interface FamiliarRouteV1 {
  kind: "arobi.familiar-route";
  version: 1;
  registryDigest: Digest;
  turnDigest: Digest;
  activations: FamiliarAdapterActivationV1[];
  /** The working set's candidates in rank order, within every adapter's budget and the working set's bound. */
  selected: FamiliarRouteCandidateV1[];
  /** How many scoped candidates the route weighed. */
  considered: number;
  /** Relevance only: nothing here is admitted (the context boundary and Immaculate decide that) or authorizes. */
  admission: "NOT_EVALUATED";
  mayAuthorize: false;
}

export interface FamiliarRouteInput {
  registry?: FamiliarAdapterRegistryV1;
  turn: FamiliarTurnV1;
  /** Signals by artifact digest. A candidate without any is weighed on its structure alone. */
  signals?: ReadonlyMap<Digest, FamiliarRouteSignalsV1>;
  lineage?: FamiliarLineageView;
  /** A caller's own, smaller bound on the working set. */
  maxNotes?: number;
}

function signalTerm(value: number | undefined, label: string): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isFinite(value)) fail("FMP_ROUTE_INVALID", `${label} must be a finite number`);
  return clamp01(value);
}

const DAY_MS = 86_400_000;

/**
 * Route a turn across the adapters: settle them on the turn, weigh each scoped candidate within the adapters it
 * belongs to, and keep the best within each adapter's budget.
 *   relevance S(m|q) = w_s*semantic + w_g*graph + w_t*temporal + w_e*environment + w_p*provenance + w_u*utility
 *   score            = S(m|q) * (best pathway's activation) * (historicalFactor for history on forward-looking turns)
 * The temporal term is the primary adapter's half-life decay, so age changes a memory's rank and never its truth.
 * A memory that is not current or does not apply here is kept as a historical reference: down-weighted when the turn
 * looks forward, and weighed in full when it looks back (RECALL, REVIEW).
 */
export function routeFamiliarMemories(
  input: FamiliarRouteInput & { candidates: readonly FamiliarRetrievalCandidate[] },
): FamiliarRouteV1 {
  const registry = checkedRegistry(input.registry ?? FAMILIAR_ADAPTER_REGISTRY_V1);
  const turn = normalizeTurn(input.turn);
  const maxNotes = Math.min(registry.maxNotes, input.maxNotes ?? registry.maxNotes);
  if (!Number.isSafeInteger(maxNotes) || maxNotes < 1) fail("FMP_ROUTE_INVALID", "maxNotes must be a positive integer");
  const adapters = new Map(registry.adapters.map((adapter) => [adapter.adapterId, adapter]));
  const { scoring } = registry;
  const looksBack = turn.intents.some((intent) => scoring.historyIntents.includes(intent));

  const weighed = input.candidates.map((candidate) => {
    const memory = candidate.memory;
    const signals = input.signals?.get(candidate.artifactDigest) ?? {};
    const reliedUpon = reliance(signals.reliedUpon);
    const assignment = assignWith(memory, registry, { lineage: input.lineage, reliedUpon });
    const applicable = familiarMemoryApplicability(memory.scope, turn.environment);
    const validity = familiarMemoryValidity(memory, applicable.applicability, turn.nowMillis);
    const use: FamiliarMemoryUse =
      validity === "CURRENT" && applicable.applicability !== "CONFLICT" && applicable.applicability !== "OUT_OF_SCOPE"
        ? "ORDINARY"
        : "HISTORICAL_REFERENCE";
    const created = Date.parse(memory.createdAt);
    const ageDays = Number.isFinite(created) ? Math.max(0, turn.nowMillis - created) / DAY_MS : Number.POSITIVE_INFINITY;
    const halfLife = adapters.get(assignment.primary.adapterId)!.retention.halfLifeDays;
    const terms: FamiliarRouteTermsV1 = {
      semantic: round6(signalTerm(signals.semantic, "signals.semantic")),
      graph: round6(signalTerm(signals.graph, "signals.graph")),
      temporal: round6(halfLife === null ? 1 : Math.pow(2, -ageDays / halfLife)),
      environment: round6(scoring.applicability[applicable.applicability]),
      provenance: round6(scoring.trust[memory.trustClass] * scoring.support[memory.supportState]),
      utility: round6(reliedUpon / (reliedUpon + scoring.utilityHalfSaturation)),
    };
    const relevance = round6(
      scoring.weights.semantic * terms.semantic +
        scoring.weights.graph * terms.graph +
        scoring.weights.temporal * terms.temporal +
        scoring.weights.environment * terms.environment +
        scoring.weights.provenance * terms.provenance +
        scoring.weights.utility * terms.utility,
    );
    // The live task's working set only holds a memory while the turn runs in that task.
    const pathways = [
      { membership: assignment.primary, via: "PRIMARY" as const },
      ...assignment.associations
        .filter((membership) => membership.family !== "ACTIVE_THOUGHT" || applicable.sameTask)
        .map((membership) => ({ membership, via: "ASSOCIATION" as const })),
    ];
    return { candidate, assignment, applicable, validity, use, terms, relevance, pathways };
  });

  // Layer IV's content input: how well the turn's content matches what each adapter holds.
  const contentMatch = new Map<string, number>();
  for (const entry of weighed) {
    for (const { membership } of entry.pathways) {
      contentMatch.set(membership.adapterId, Math.max(contentMatch.get(membership.adapterId) ?? 0, entry.terms.semantic));
    }
  }
  const activations = settle(registry, turn, contentMatch);
  const activationOf = new Map(activations.map((activation) => [activation.adapterId, activation.activation]));

  const ranked: FamiliarRouteCandidateV1[] = [];
  for (const entry of weighed) {
    let best: { membership: FamiliarAdapterMembershipV1; via: "PRIMARY" | "ASSOCIATION"; value: number } | null = null;
    for (const pathway of entry.pathways) {
      const value = (activationOf.get(pathway.membership.adapterId) ?? 0) * (pathway.via === "PRIMARY" ? 1 : scoring.associationFactor);
      if (!best || value > best.value) best = { ...pathway, value };
    }
    if (!best) continue;
    const historical = entry.use === "HISTORICAL_REFERENCE" && !looksBack ? scoring.historicalFactor : 1;
    // From the reported, rounded factors, so anyone holding the route can recompute every score in it.
    const activation = round6(best.value);
    const score = round6(entry.relevance * activation * historical);
    if (score <= 0) continue;
    ranked.push({
      artifactDigest: entry.candidate.artifactDigest,
      memoryId: entry.candidate.memory.memoryId,
      contributor: { ...best.membership, via: best.via },
      primary: entry.assignment.primary,
      associations: entry.assignment.associations,
      lifecycle: entry.assignment.lifecycle,
      applicability: entry.applicable.applicability,
      validity: entry.validity,
      use: entry.use,
      terms: entry.terms,
      relevance: entry.relevance,
      activation,
      score,
    });
  }
  ranked.sort((a, b) => b.score - a.score || a.artifactDigest.localeCompare(b.artifactDigest));

  // Layer V: each adapter contributes at most its budget, and the working set holds at most maxNotes.
  const spent = new Map<string, number>();
  const selected: FamiliarRouteCandidateV1[] = [];
  for (const candidate of ranked) {
    if (selected.length >= maxNotes) break;
    const adapterId = candidate.contributor.adapterId;
    const used = spent.get(adapterId) ?? 0;
    if (used >= adapters.get(adapterId)!.budget.maxNotes) continue;
    spent.set(adapterId, used + 1);
    selected.push(candidate);
  }

  return {
    kind: "arobi.familiar-route",
    version: 1,
    registryDigest: familiarAdapterRegistryDigest(registry),
    turnDigest: sha256DomainDigestCanonical("arobi.familiar-turn.v1", {
      now: turn.now,
      intents: turn.intents,
      tools: turn.tools,
      environment: turn.environment,
      modulators: turn.modulators,
    }),
    activations,
    selected,
    considered: input.candidates.length,
    admission: "NOT_EVALUATED",
    mayAuthorize: false,
  };
}

/** The digest a route is recorded by, beside the context-use receipt of what it led to. */
export function familiarRouteDigest(route: FamiliarRouteV1): Digest {
  return sha256DomainDigestCanonical("arobi.familiar-route.v1", route);
}

/**
 * The adapter route as retrieveFamiliarMemories' ranker. Retrieval applies every load-bearing scope and policy filter
 * before calling it, and refuses anything it returns from outside that set, so routing can reorder and bound the
 * scoped candidates and can never widen them. onRoute receives the full route, for its digest and its explanation.
 */
export function familiarAdapterRanker(
  input: FamiliarRouteInput & { onRoute?: (route: FamiliarRouteV1) => void },
): FamiliarRetrievalRanker {
  return (candidates) => {
    const route = routeFamiliarMemories({ ...input, candidates });
    input.onRoute?.(route);
    return route.selected.map((candidate) => ({ artifactDigest: candidate.artifactDigest, score: candidate.score }));
  };
}
