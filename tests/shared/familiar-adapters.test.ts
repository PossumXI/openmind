import { describe, expect, it } from "vitest";
import {
  FAMILIAR_ADAPTER_REGISTRY_V1,
  FAMILIAR_ADAPTER_REGISTRY_V1_DIGEST,
  FAMILIAR_MEMORY_CLASSES,
  FamiliarValidationError,
  MEMORY_SUPPORT_STATES,
  assertFamiliarAdapterRegistryV1,
  assertFamiliarMemoryArtifactV1,
  assignFamiliarAdapters,
  familiarAdapterRanker,
  familiarAdapterRegistryDigest,
  familiarLineageFrom,
  familiarMemoryApplicability,
  familiarMemoryValidity,
  familiarRouteDigest,
  retrieveFamiliarMemories,
  routeFamiliarMemories,
  sha256DigestCanonical,
  type Digest,
  type FamiliarAdapterRegistryV1,
  type FamiliarMemoryArtifactV1,
  type FamiliarRouteSignalsV1,
  type FamiliarRouteV1,
  type FamiliarTurnV1,
} from "../../src/familiar/index.js";

const NOW = "2026-10-24T12:00:00.000Z";
const D = (n: number) => `sha256:${n.toString(16).padStart(64, "0")}` as Digest;

function memory(overrides: Partial<FamiliarMemoryArtifactV1> = {}): FamiliarMemoryArtifactV1 {
  return {
    kind: "arobi.familiar-memory",
    version: 1,
    memoryId: "memory-1",
    familiarId: "familiar-1",
    tenantId: "tenant-1",
    identityEpoch: 1,
    memoryClass: "EPISODIC",
    contentDigest: D(1),
    originLabelDigest: D(2),
    sourceArtifacts: [],
    transformationChain: [],
    trustClass: "OBSERVED",
    supportState: "OBSERVED",
    mayInform: true,
    mayAuthorize: false,
    revision: 1,
    createdAt: "2026-10-20T12:00:00.000Z",
    ...overrides,
  };
}

const candidate = (value: FamiliarMemoryArtifactV1) => ({ artifactDigest: sha256DigestCanonical(value), memory: value });

function turn(overrides: Partial<FamiliarTurnV1> = {}): FamiliarTurnV1 {
  return { now: NOW, intents: ["BUILD"], tools: [], ...overrides };
}

function copyRegistry(): FamiliarAdapterRegistryV1 {
  return JSON.parse(JSON.stringify(FAMILIAR_ADAPTER_REGISTRY_V1)) as FamiliarAdapterRegistryV1;
}

function validationCode(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof FamiliarValidationError) return error.code;
    throw error;
  }
  return undefined;
}

function activationOf(route: FamiliarRouteV1, adapterId: string): number {
  return route.activations.find((activation) => activation.adapterId === adapterId)!.activation;
}

describe("Familiar adapter registry", () => {
  it("validates, is frozen, and is pinned by its digest", () => {
    expect(() => assertFamiliarAdapterRegistryV1(FAMILIAR_ADAPTER_REGISTRY_V1)).not.toThrow();
    expect(Object.isFrozen(FAMILIAR_ADAPTER_REGISTRY_V1.adapters[0].receptors.intents)).toBe(true);
    expect(familiarAdapterRegistryDigest(FAMILIAR_ADAPTER_REGISTRY_V1)).toBe(FAMILIAR_ADAPTER_REGISTRY_V1_DIGEST);
    // A copy with the same content has the same digest: the pin is over content, not identity.
    expect(familiarAdapterRegistryDigest(copyRegistry())).toBe(FAMILIAR_ADAPTER_REGISTRY_V1_DIGEST);
  });

  it("holds the nine families, every adapter empty until memories exist", () => {
    expect(FAMILIAR_ADAPTER_REGISTRY_V1.adapters.map((adapter) => adapter.family).sort()).toEqual([
      "ACTIVE_THOUGHT", "AUTOBIOGRAPHICAL", "CREATIVE", "ENVIRONMENTAL", "EPISODIC", "PROCEDURAL", "PROJECT",
      "REFLECTIVE", "SEMANTIC",
    ]);
  });

  it("refuses a revision that leaves a memory class with nowhere to go", () => {
    const registry = copyRegistry();
    const creative = registry.adapters.find((adapter) => adapter.adapterId === "creative")!;
    creative.rules = creative.rules.filter((rule) => rule.ruleId !== "creative.idea");
    expect(validationCode(() => assertFamiliarAdapterRegistryV1(registry))).toBe("FMP_ADAPTER_UNHOMED_CLASS");
  });

  it("keeps the cortical directions: feedforward rises, feedback descends, lateral joins peers", () => {
    const downward = copyRegistry();
    downward.pathways.push({ kind: "FEEDFORWARD", from: "procedural", to: "episodic", weight: 0.1 });
    expect(validationCode(() => assertFamiliarAdapterRegistryV1(downward))).toBe("FMP_ADAPTER_PATHWAY_DIRECTION");
    const upward = copyRegistry();
    upward.pathways.push({ kind: "FEEDBACK", from: "episodic", to: "procedural", weight: 0.1 });
    expect(validationCode(() => assertFamiliarAdapterRegistryV1(upward))).toBe("FMP_ADAPTER_PATHWAY_DIRECTION");
    const crossTier = copyRegistry();
    crossTier.pathways.push({ kind: "LATERAL", from: "episodic", to: "reflective", weight: 0.1 });
    expect(validationCode(() => assertFamiliarAdapterRegistryV1(crossTier))).toBe("FMP_ADAPTER_PATHWAY_DIRECTION");
    // A lateral link is one unordered pair; naming it the other way round repeats it.
    const repeated = copyRegistry();
    repeated.pathways.push({ kind: "LATERAL", from: "semantic", to: "creative", weight: 0.2 });
    expect(validationCode(() => assertFamiliarAdapterRegistryV1(repeated))).toBe("FMP_ADAPTER_INVALID");
  });

  it("refuses malformed revisions", () => {
    const cases: Array<(registry: FamiliarAdapterRegistryV1) => void> = [
      (registry) => { registry.adapters[1].adapterId = registry.adapters[0].adapterId; },
      (registry) => { registry.adapters[0].rules.push({ ruleId: "environmental.empty", role: "ASSOCIATION", priority: 0 }); },
      (registry) => { registry.adapters[0].rules.push({ ...registry.adapters[1].rules[0] }); },
      (registry) => { (registry.adapters[0].receptors.intents as Record<string, number>).DREAM = 0.5; },
      (registry) => { registry.adapters[0].receptors.channels.TOOLS = 1.5; },
      (registry) => { registry.adapters[0].modulation.RISK = -2; },
      (registry) => { registry.adapters[0].budget.maxNotes = 0; },
      (registry) => { registry.adapters[0].retention.halfLifeDays = 0; },
      (registry) => { registry.scoring.weights.semantic = 0.5; },
      (registry) => { registry.scoring.historicalFactor = 2; },
      (registry) => { registry.settle.passes = 9; },
      (registry) => { registry.pathways.push({ kind: "FEEDFORWARD", from: "episodic", to: "nowhere", weight: 0.1 }); },
      (registry) => { registry.pathways.push({ kind: "FEEDFORWARD", from: "episodic", to: "procedural", weight: 0 }); },
      (registry) => { registry.registryVersion = "next"; },
    ];
    for (const [index, mutate] of cases.entries()) {
      const registry = copyRegistry();
      mutate(registry);
      expect(validationCode(() => assertFamiliarAdapterRegistryV1(registry)), `case ${index}`).toMatch(/^FMP_ADAPTER_/);
    }
  });
});

describe("assignFamiliarAdapters", () => {
  it("routes every memory somewhere, by a rule that exists and matches, the same way every time", () => {
    const rules = new Map(
      FAMILIAR_ADAPTER_REGISTRY_V1.adapters.flatMap((adapter) => adapter.rules.map((rule) => [rule.ruleId, { adapter, rule }] as const)),
    );
    for (const memoryClass of FAMILIAR_MEMORY_CLASSES) {
      for (const supportState of MEMORY_SUPPORT_STATES) {
        for (const derived of [false, true]) {
          const value = memory({ memoryClass, supportState, transformationChain: derived ? [D(9)] : [] });
          const assignment = assignFamiliarAdapters(value);
          expect(assignFamiliarAdapters(value)).toEqual(assignment);
          const primary = rules.get(assignment.primary.ruleId)!;
          expect(primary.rule.role).toBe("PRIMARY");
          expect(primary.adapter.adapterId).toBe(assignment.primary.adapterId);
          expect(primary.rule.memoryClasses).toContain(memoryClass);
          for (const association of assignment.associations) {
            expect(association.adapterId).not.toBe(assignment.primary.adapterId);
            expect(rules.get(association.ruleId)!.adapter.adapterId).toBe(association.adapterId);
          }
          expect(assignment.registryDigest).toBe(FAMILIAR_ADAPTER_REGISTRY_V1_DIGEST);
        }
      }
    }
  });

  it("gives each memory class its home family", () => {
    const homes = Object.fromEntries(
      FAMILIAR_MEMORY_CLASSES.map((memoryClass) => [memoryClass, assignFamiliarAdapters(memory({ memoryClass })).primary.family]),
    );
    expect(homes).toEqual({
      EPISODIC: "EPISODIC",
      CORE: "AUTOBIOGRAPHICAL",
      PREFERENCE: "AUTOBIOGRAPHICAL",
      RELATIONSHIP: "SEMANTIC",
      PROCEDURAL: "PROCEDURAL",
      SKILL: "PROCEDURAL",
      EVIDENCE: "EPISODIC",
      HYPOTHESIS: "CREATIVE",
      EXTERNAL_OBSERVATION: "ENVIRONMENTAL",
      AUTHORITY_REFERENCE: "EPISODIC",
    });
  });

  it("moves a memory to the next adapter as its lineage grows, and keeps the way back", () => {
    const evidence = memory({ memoryId: "evidence-1", memoryClass: "EVIDENCE", trustClass: "VERIFIED_SYSTEM" });
    const lineage = familiarLineageFrom([evidence]);
    const interpretation = memory({
      memoryId: "inference-1",
      memoryClass: "HYPOTHESIS",
      trustClass: "DERIVED",
      supportState: "ASSERTED",
      sourceArtifacts: [sha256DigestCanonical(evidence)],
      transformationChain: [D(7)],
    });
    // An idea grounded in outcome evidence is an evaluation of what happened.
    const asInference = assignFamiliarAdapters(interpretation, FAMILIAR_ADAPTER_REGISTRY_V1, { lineage });
    expect(asInference.primary).toEqual({ adapterId: "reflective", family: "REFLECTIVE", ruleId: "reflective.outcome-interpretation" });
    expect(asInference.associations.map((membership) => membership.ruleId)).toEqual(["episodic.lineage", "creative.idea"]);
    expect(asInference.lifecycle).toBe("UNDER_EVALUATION");
    // Relying on it does not make it true.
    expect(assignFamiliarAdapters(interpretation, FAMILIAR_ADAPTER_REGISTRY_V1, { lineage, reliedUpon: 4 }).lifecycle).toBe("UNDER_EVALUATION");

    // Corroborated, it is knowledge: routed through the semantic adapter, with pathways back to where it came from.
    const corroborated = { ...interpretation, supportState: "CORROBORATED" as const, revision: 2, previousDigest: sha256DigestCanonical(interpretation) };
    const asKnowledge = assignFamiliarAdapters(corroborated, FAMILIAR_ADAPTER_REGISTRY_V1, { lineage });
    expect(asKnowledge.primary).toEqual({ adapterId: "semantic", family: "SEMANTIC", ruleId: "semantic.corroborated-inference" });
    expect(asKnowledge.associations.map((membership) => membership.adapterId)).toEqual(["episodic", "creative", "reflective"]);
    expect(asKnowledge.lifecycle).toBe("VALIDATED");
    expect(assignFamiliarAdapters(corroborated, FAMILIAR_ADAPTER_REGISTRY_V1, { lineage, reliedUpon: 2 }).lifecycle).toBe("APPLIED");

    // Without a view of its sources the router cannot see the evidence, and keeps it with the ideas.
    expect(assignFamiliarAdapters(interpretation).primary.adapterId).toBe("creative");
  });

  it("joins a scoped memory to the adapters of the environment it was captured in", () => {
    const scoped = memory({
      scope: {
        bindings: [
          { kind: "REPOSITORY", id: "asgard" },
          { kind: "APPLICATION", id: "ullumii-desktop" },
          { kind: "TASK", id: "task-1" },
        ],
        dependencies: [],
        observedAt: NOW,
      },
    });
    expect(assignFamiliarAdapters(scoped).associations).toEqual([
      { adapterId: "environmental", family: "ENVIRONMENTAL", ruleId: "environmental.bound" },
      { adapterId: "project", family: "PROJECT", ruleId: "project.bound" },
      { adapterId: "active_thought", family: "ACTIVE_THOUGHT", ruleId: "active_thought.task" },
    ]);
  });

  it("keeps conflicts visible to the reflective adapter and never pushes anything forward", () => {
    const contested = assignFamiliarAdapters(memory({ memoryClass: "RELATIONSHIP", supportState: "CONTESTED" }));
    expect(contested.associations).toContainEqual({ adapterId: "reflective", family: "REFLECTIVE", ruleId: "reflective.contested" });
    expect(contested.lifecycle).toBe("CONTESTED");
    expect(assignFamiliarAdapters(memory()).lifecycle).toBe("CAPTURED");
    expect(assignFamiliarAdapters(memory(), FAMILIAR_ADAPTER_REGISTRY_V1, { reliedUpon: 1 }).lifecycle).toBe("APPLIED");
    expect(assignFamiliarAdapters(memory({ memoryClass: "PROCEDURAL", transformationChain: [D(3)] }), FAMILIAR_ADAPTER_REGISTRY_V1, { reliedUpon: 9 }).lifecycle).toBe("UNDER_EVALUATION");
    for (const supportState of ["SUPERSEDED", "QUARANTINED", "FORGOTTEN"] as const) {
      expect(assignFamiliarAdapters(memory({ supportState })).lifecycle).toBe(supportState);
    }
    expect(validationCode(() => assignFamiliarAdapters(memory(), FAMILIAR_ADAPTER_REGISTRY_V1, { reliedUpon: -1 }))).toBe("FMP_ROUTE_INVALID");
  });
});

describe("applicability and validity", () => {
  const scope = {
    bindings: [{ kind: "REPOSITORY" as const, id: "asgard" }, { kind: "TASK" as const, id: "task-1" }],
    dependencies: [{ name: "runtime:node", digest: D(20) }],
    observedAt: NOW,
  };

  it("tells a memory that applies here from one that only might, one that held then, and one from elsewhere", () => {
    expect(familiarMemoryApplicability(undefined, undefined).applicability).toBe("UNSCOPED");
    const here = { bindings: [{ kind: "REPOSITORY" as const, id: "asgard" }, { kind: "TASK" as const, id: "task-1" }], facts: [{ name: "runtime:node", digest: D(20) }] };
    expect(familiarMemoryApplicability(scope, here)).toEqual({ applicability: "MATCH", sameTask: true, mismatched: [], changed: [] });
    expect(familiarMemoryApplicability(scope, { ...here, facts: [] }).applicability).toBe("PARTIAL");
    expect(familiarMemoryApplicability(scope, { ...here, facts: [{ name: "runtime:node", digest: D(21) }] })).toEqual({
      applicability: "CONFLICT", sameTask: true, mismatched: [], changed: ["runtime:node"],
    });
    expect(familiarMemoryApplicability(scope, { ...here, bindings: [{ kind: "REPOSITORY", id: "openjaws" }] }).applicability).toBe("OUT_OF_SCOPE");
    // Another task in the same repository is still relevant; it is just not this task's working state.
    expect(familiarMemoryApplicability(scope, { ...here, bindings: [{ kind: "REPOSITORY", id: "asgard" }, { kind: "TASK", id: "task-2" }] })).toEqual({
      applicability: "PARTIAL", sameTask: false, mismatched: [], changed: [],
    });
  });

  it("keeps historical truth apart from current validity", () => {
    const nowMillis = Date.parse(NOW);
    expect(familiarMemoryValidity(memory(), "MATCH", nowMillis)).toBe("CURRENT");
    expect(familiarMemoryValidity(memory(), "CONFLICT", nowMillis)).toBe("NEEDS_REVALIDATION");
    expect(familiarMemoryValidity(memory({ supersededBy: D(5) }), "MATCH", nowMillis)).toBe("SUPERSEDED");
    expect(familiarMemoryValidity(memory({ supportState: "CONTESTED" }), "MATCH", nowMillis)).toBe("CONTESTED");
    expect(familiarMemoryValidity(memory({ expiresAt: "2026-10-24T11:59:59.000Z" }), "MATCH", nowMillis)).toBe("EXPIRED");
    expect(familiarMemoryValidity(memory({ expiresAt: "not a time" }), "MATCH", nowMillis)).toBe("EXPIRED");
    expect(familiarMemoryValidity(memory({ supportState: "QUARANTINED" }), "MATCH", nowMillis)).toBe("WITHDRAWN");
  });

  it("validates a memory's scope when it has one, and still accepts memory without one", () => {
    expect(() => assertFamiliarMemoryArtifactV1(memory())).not.toThrow();
    expect(() => assertFamiliarMemoryArtifactV1(memory({ scope }))).not.toThrow();
    const bad = [
      { ...scope, bindings: [...scope.bindings, { kind: "REPOSITORY", id: "openjaws" }] },
      { ...scope, bindings: [{ kind: "GALAXY", id: "x" }] },
      { ...scope, bindings: [{ kind: "PROJECT", id: "" }] },
      { ...scope, dependencies: [{ name: "runtime:node", digest: "sha256:nope" }] },
      { ...scope, dependencies: [scope.dependencies[0], scope.dependencies[0]] },
      { bindings: [], dependencies: [], observedAt: NOW },
      { ...scope, observedAt: "yesterday" },
    ];
    for (const [index, value] of bad.entries()) {
      expect(validationCode(() => assertFamiliarMemoryArtifactV1({ ...memory(), scope: value })), `case ${index}`).toMatch(/^FMP_INVALID_/);
    }
  });
});

describe("the settle", () => {
  it("cannot be excited by modulators alone", () => {
    const quiet = routeFamiliarMemories({
      turn: turn({ intents: [], modulators: { NOVELTY: 1, REWARD: 1, RISK: 1, URGENCY: 1, SALIENCE: 1 } }),
      candidates: [],
    });
    expect(quiet.activations.every((activation) => activation.activation === 0)).toBe(true);
    expect(quiet.selected).toEqual([]);
  });

  it("settles the same way whatever order the adapters are listed in, within bounds", () => {
    const reordered = copyRegistry();
    reordered.adapters.reverse();
    const busy = turn({
      intents: ["BUILD", "REVIEW", "CREATE"],
      tools: ["shell"],
      environment: { bindings: [{ kind: "REPOSITORY", id: "asgard" }, { kind: "TASK", id: "task-1" }], facts: [] },
      modulators: { RISK: 0.7, URGENCY: 0.4 },
    });
    const a = routeFamiliarMemories({ turn: busy, candidates: [] });
    const b = routeFamiliarMemories({ registry: reordered, turn: busy, candidates: [] });
    for (const activation of a.activations) {
      const other = b.activations.find((entry) => entry.adapterId === activation.adapterId)!;
      expect(other.activation).toBe(activation.activation);
      expect(activation.activation).toBeGreaterThanOrEqual(0);
      expect(activation.activation).toBeLessThanOrEqual(1);
      expect(activation.gain).toBeGreaterThanOrEqual(0);
      expect(activation.gain).toBeLessThanOrEqual(2);
    }
  });

  it("carries evidence up the feedforward pathway", () => {
    // A recall turn excites the episodic and semantic adapters; the reflective one has no recall receptor and is
    // reached only through the feedforward pathways from them.
    const recall = turn({ intents: ["RECALL"] });
    const reflective = activationOf(routeFamiliarMemories({ turn: recall, candidates: [] }), "reflective");
    expect(reflective).toBeGreaterThan(0);
    const cut = copyRegistry();
    cut.pathways = cut.pathways.filter((pathway) => !(pathway.to === "reflective" && pathway.kind === "FEEDFORWARD"));
    expect(activationOf(routeFamiliarMemories({ registry: cut, turn: recall, candidates: [] }), "reflective")).toBeLessThan(reflective);
  });

  it("is symmetric along a lateral link and asymmetric across tiers", () => {
    const pair: FamiliarAdapterRegistryV1 = {
      ...copyRegistry(),
      adapters: [
        {
          adapterId: "left", family: "CREATIVE", tier: "ASSOCIATION", purpose: "One side.",
          rules: [{ ruleId: "left.all", role: "PRIMARY", priority: 100, memoryClasses: [...FAMILIAR_MEMORY_CLASSES] }],
          receptors: { intents: { CREATE: 0.5 }, channels: {} }, modulation: {}, retention: { halfLifeDays: null }, budget: { maxNotes: 1 },
        },
        {
          adapterId: "right", family: "SEMANTIC", tier: "ASSOCIATION", purpose: "The other side.",
          rules: [], receptors: { intents: { BUILD: 0.5 }, channels: {} }, modulation: {}, retention: { halfLifeDays: null }, budget: { maxNotes: 1 },
        },
        {
          adapterId: "above", family: "REFLECTIVE", tier: "LIMBIC", purpose: "A tier up.",
          rules: [], receptors: { intents: { REVIEW: 0.5 }, channels: {} }, modulation: {}, retention: { halfLifeDays: null }, budget: { maxNotes: 1 },
        },
      ],
      pathways: [
        { kind: "LATERAL", from: "left", to: "right", weight: 0.3 },
        { kind: "FEEDFORWARD", from: "left", to: "above", weight: 0.4 },
        { kind: "FEEDBACK", from: "above", to: "left", weight: 0.1 },
      ],
    };
    assertFamiliarAdapterRegistryV1(pair);
    const settled = (intents: FamiliarTurnV1["intents"]) => routeFamiliarMemories({ registry: pair, turn: turn({ intents }), candidates: [] });
    expect(activationOf(settled(["CREATE"]), "right")).toBe(activationOf(settled(["BUILD"]), "left"));
    // Up the hierarchy the evidence carries more (0.4) than attention carries back down (0.1).
    expect(activationOf(settled(["CREATE"]), "above")).toBeGreaterThan(activationOf(settled(["REVIEW"]), "left"));
  });

  it("lets modulators scale gain without touching trust", () => {
    const value = memory({ memoryClass: "HYPOTHESIS" });
    const signals = new Map([[sha256DigestCanonical(value), { semantic: 0.8 }]]);
    const calm = routeFamiliarMemories({ turn: turn({ intents: ["CREATE"] }), candidates: [candidate(value)], signals });
    const risky = routeFamiliarMemories({ turn: turn({ intents: ["CREATE"], modulators: { RISK: 1 } }), candidates: [candidate(value)], signals });
    const gain = (route: FamiliarRouteV1, adapterId: string) => route.activations.find((entry) => entry.adapterId === adapterId)!.gain;
    expect(gain(risky, "reflective")).toBe(1.5);
    expect(gain(risky, "creative")).toBe(0.6);
    expect(risky.selected[0].terms.provenance).toBe(calm.selected[0].terms.provenance);
    expect(risky.selected[0].score).toBeLessThan(calm.selected[0].score);
  });
});

describe("routeFamiliarMemories", () => {
  it("keeps each adapter within its budget and the working set within its bound", () => {
    const episodes = [1, 2, 3].map((n) => memory({ memoryId: `episode-${n}`, contentDigest: D(100 + n) }));
    const signals = new Map(episodes.map((value) => [sha256DigestCanonical(value), { semantic: 0.9 }] as const));
    const route = routeFamiliarMemories({ turn: turn({ intents: ["RECALL"] }), candidates: episodes.map(candidate), signals });
    expect(route.considered).toBe(3);
    expect(route.selected).toHaveLength(2);
    expect(route.selected.every((entry) => entry.contributor.adapterId === "episodic")).toBe(true);
    const bounded = routeFamiliarMemories({ turn: turn({ intents: ["RECALL"] }), candidates: episodes.map(candidate), signals, maxNotes: 1 });
    expect(bounded.selected).toHaveLength(1);
  });

  it("keeps history as history: down-weighted when the turn looks forward, weighed in full when it looks back", () => {
    const scope = (digest: Digest) => ({ bindings: [{ kind: "REPOSITORY" as const, id: "asgard" }], dependencies: [{ name: "dependency:vite", digest }], observedAt: NOW });
    const current = memory({ memoryId: "procedure-now", memoryClass: "PROCEDURAL", scope: scope(D(31)) });
    const stale = memory({ memoryId: "procedure-then", memoryClass: "PROCEDURAL", scope: scope(D(30)) });
    const environment = { bindings: [{ kind: "REPOSITORY" as const, id: "asgard" }], facts: [{ name: "dependency:vite", digest: D(31) }] };
    const signals = new Map([current, stale].map((value) => [sha256DigestCanonical(value), { semantic: 0.9 }] as const));
    const build = routeFamiliarMemories({ turn: turn({ intents: ["BUILD"], environment }), candidates: [candidate(stale), candidate(current)], signals });
    expect(build.selected.map((entry) => [entry.memoryId, entry.applicability, entry.validity, entry.use])).toEqual([
      ["procedure-now", "MATCH", "CURRENT", "ORDINARY"],
      ["procedure-then", "CONFLICT", "NEEDS_REVALIDATION", "HISTORICAL_REFERENCE"],
    ]);
    const thenOnBuild = build.selected[1];
    expect(thenOnBuild.score).toBe(Math.round(thenOnBuild.relevance * thenOnBuild.activation * 0.25 * 1e6) / 1e6);
    const review = routeFamiliarMemories({ turn: turn({ intents: ["REVIEW", "BUILD"], environment }), candidates: [candidate(stale), candidate(current)], signals });
    const thenOnReview = review.selected.find((entry) => entry.memoryId === "procedure-then")!;
    expect(thenOnReview.score).toBe(Math.round(thenOnReview.relevance * thenOnReview.activation * 1e6) / 1e6);
    // Another repository's procedure is out of scope: no environment term, and history at best.
    const elsewhere = memory({ memoryId: "procedure-elsewhere", memoryClass: "PROCEDURAL", scope: { ...scope(D(31)), bindings: [{ kind: "REPOSITORY", id: "openjaws" }] } });
    const routed = routeFamiliarMemories({ turn: turn({ intents: ["BUILD"], environment }), candidates: [candidate(elsewhere)], signals: new Map([[sha256DigestCanonical(elsewhere), { semantic: 0.9 }]]) });
    expect(routed.selected[0]).toMatchObject({ applicability: "OUT_OF_SCOPE", use: "HISTORICAL_REFERENCE", terms: { environment: 0 } });
  });

  it("lets the live task's working set carry a memory only while the turn runs in that task", () => {
    const preference = memory({
      memoryId: "preference-1",
      memoryClass: "PREFERENCE",
      trustClass: "OPERATOR_AUTHORED",
      scope: { bindings: [{ kind: "TASK", id: "task-1" }], dependencies: [], observedAt: NOW },
    });
    const signals = new Map([[sha256DigestCanonical(preference), { semantic: 0.2 }]]);
    const inTask = (taskId: string) =>
      routeFamiliarMemories({
        turn: turn({ intents: ["BUILD"], environment: { bindings: [{ kind: "TASK", id: taskId }], facts: [] } }),
        candidates: [candidate(preference)],
        signals,
      }).selected[0];
    expect(inTask("task-1").contributor).toEqual({ adapterId: "active_thought", family: "ACTIVE_THOUGHT", ruleId: "active_thought.task", via: "ASSOCIATION" });
    expect(inTask("task-2").contributor).toEqual({ adapterId: "autobiographical", family: "AUTOBIOGRAPHICAL", ruleId: "autobiographical.identity", via: "PRIMARY" });
  });

  it("lets age lower a memory's rank only in a family that decays", () => {
    const oldEpisode = memory({ memoryId: "episode-old", createdAt: "2025-10-24T12:00:00.000Z" });
    const oldIdea = memory({ memoryId: "idea-old", memoryClass: "HYPOTHESIS", createdAt: "2016-10-24T12:00:00.000Z" });
    const signals = new Map([oldEpisode, oldIdea].map((value) => [sha256DigestCanonical(value), { semantic: 0.5 }] as const));
    const route = routeFamiliarMemories({ turn: turn({ intents: ["RECALL", "CREATE"] }), candidates: [candidate(oldEpisode), candidate(oldIdea)], signals });
    const byId = new Map(route.selected.map((entry) => [entry.memoryId, entry]));
    expect(byId.get("episode-old")!.terms.temporal).toBeLessThan(0.15);
    expect(byId.get("idea-old")!.terms.temporal).toBe(1);
  });

  it("routes the same way every time, whatever order the candidates arrive in", () => {
    const values = [
      memory({ memoryId: "a", memoryClass: "EPISODIC" }),
      memory({ memoryId: "b", memoryClass: "PROCEDURAL", trustClass: "VERIFIED_SYSTEM", supportState: "CORROBORATED" }),
      memory({ memoryId: "c", memoryClass: "HYPOTHESIS", trustClass: "DERIVED", supportState: "ASSERTED" }),
      memory({ memoryId: "d", memoryClass: "PREFERENCE", trustClass: "OPERATOR_AUTHORED" }),
    ];
    const signals = new Map<Digest, FamiliarRouteSignalsV1>(values.map((value, index) => [sha256DigestCanonical(value), { semantic: 0.2 * (index + 1), graph: 0.1, reliedUpon: index }]));
    const input = { turn: turn({ intents: ["BUILD", "PLAN"] as FamiliarTurnV1["intents"], tools: ["shell", "shell"] }), signals };
    const forward = routeFamiliarMemories({ ...input, candidates: values.map(candidate) });
    const backward = routeFamiliarMemories({ ...input, candidates: [...values].reverse().map(candidate) });
    expect(backward).toEqual(forward);
    expect(familiarRouteDigest(backward)).toBe(familiarRouteDigest(forward));
    expect(forward).toMatchObject({ kind: "arobi.familiar-route", admission: "NOT_EVALUATED", mayAuthorize: false });
  });

  it("refuses a malformed turn or signal instead of guessing", () => {
    const cases: Array<() => unknown> = [
      () => routeFamiliarMemories({ turn: turn({ now: "2026-10-24 12:00" }), candidates: [] }),
      () => routeFamiliarMemories({ turn: turn({ intents: ["DREAM" as never] }), candidates: [] }),
      () => routeFamiliarMemories({ turn: turn({ tools: [""] }), candidates: [] }),
      () => routeFamiliarMemories({ turn: turn({ environment: { bindings: [{ kind: "TASK", id: "a" }, { kind: "TASK", id: "b" }], facts: [] } }), candidates: [] }),
      () => routeFamiliarMemories({ turn: turn({ environment: { bindings: [], facts: [{ name: "x", digest: "sha256:no" as Digest }] } }), candidates: [] }),
      () => routeFamiliarMemories({ turn: turn({ modulators: { RISK: Number.NaN } }), candidates: [] }),
      () => routeFamiliarMemories({ turn: turn(), candidates: [candidate(memory())], signals: new Map([[sha256DigestCanonical(memory()), { semantic: Number.POSITIVE_INFINITY }]]) }),
      () => routeFamiliarMemories({ turn: turn(), candidates: [], maxNotes: 0 }),
    ];
    for (const [index, run] of cases.entries()) expect(validationCode(run), `case ${index}`).toBe("FMP_ROUTE_INVALID");
  });
});

describe("familiarAdapterRanker inside retrieveFamiliarMemories", () => {
  it("reorders and bounds the scoped candidates and never sees anything outside them", async () => {
    const mine = [1, 2, 3].map((n) => memory({ memoryId: `mine-${n}`, contentDigest: D(200 + n) }));
    const foreign = memory({ memoryId: "theirs", tenantId: "tenant-2", contentDigest: D(300) });
    const expired = memory({ memoryId: "expired", contentDigest: D(301), expiresAt: "2026-10-01T00:00:00.000Z" });
    const signals = new Map([...mine, foreign, expired].map((value, index) => [sha256DigestCanonical(value), { semantic: 0.3 + 0.2 * index }] as const));
    const routes: FamiliarRouteV1[] = [];
    const results = await retrieveFamiliarMemories(
      { readCurrentMemories: async () => [...mine, foreign, expired] },
      {
        tenantId: "tenant-1",
        familiarId: "familiar-1",
        identityEpoch: 1,
        allowedSupportStates: ["OBSERVED", "CORROBORATED"],
        allowedTrustClasses: ["OBSERVED", "VERIFIED_SYSTEM"],
        now: NOW,
      },
      familiarAdapterRanker({ turn: turn({ intents: ["RECALL"] }), signals, onRoute: (route) => routes.push(route) }),
    );
    expect(routes).toHaveLength(1);
    expect(routes[0].considered).toBe(3);
    // The episodic adapter's budget is two.
    expect(results.map((result) => result.memory.memoryId)).toEqual(["mine-3", "mine-2"]);
    expect(results.map((result) => result.score)).toEqual(routes[0].selected.map((entry) => entry.score));
  });
});
