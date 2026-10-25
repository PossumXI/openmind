import { describe, expect, it } from "vitest";
import {
  diffuseFamiliarActivation,
  familiarDiffusionGraph,
  familiarDiffusionSignals,
  fractionalAnisotropy,
  type FamiliarDiffusionEdgeV1,
  type FamiliarDiffusionNodeV1,
} from "../../src/familiar/diffusion.js";
import type { Digest, FamiliarMemoryArtifactV1 } from "../../src/familiar/types.js";
import { routeFamiliarMemories } from "../../src/familiar/adapters.js";
import { sha256DigestCanonical } from "../../src/familiar/canonicalize.js";

const d = (n: number) => `sha256:${n.toString(16).padStart(64, "0")}` as Digest;
const nodes = (count: number, barriers: number[] = []): FamiliarDiffusionNodeV1[] =>
  Array.from({ length: count }, (_, i) => ({ digest: d(i + 1), barrier: barriers.includes(i + 1) }));

describe("familiar memory diffusion (FMP v1.3)", () => {
  it("FA is 0 for even links in every direction and 1 for a single direction", () => {
    expect(fractionalAnisotropy([1, 1, 1, 1, 1])).toBe(0);
    expect(fractionalAnisotropy([1, 0, 0, 0, 0])).toBe(1);
    expect(fractionalAnisotropy([0, 0, 0, 0, 0])).toBe(0);
    const partial = fractionalAnisotropy([1, 0.5, 0, 0, 0]);
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(1);
  });

  it("spreads further along a strong direction than a weak one (anisotropy)", () => {
    const edges: FamiliarDiffusionEdgeV1[] = [
      { from: d(2), to: d(1), direction: "LINEAGE" },
      { from: d(1), to: d(3), direction: "EPISODE" },
    ];
    const result = diffuseFamiliarActivation({ nodes: nodes(3), edges, seeds: new Map([[d(1), 1]]) });
    expect(result.activation.get(d(2))!).toBeGreaterThan(result.activation.get(d(3))!);
    expect(result.activation.get(d(1))).toBe(1);
  });

  it("restricts spread at a barrier: out-of-scope memory gets nothing and passes nothing", () => {
    const edges: FamiliarDiffusionEdgeV1[] = [
      { from: d(1), to: d(2), direction: "RELATION" },
      { from: d(2), to: d(3), direction: "RELATION" },
    ];
    const result = diffuseFamiliarActivation({ nodes: nodes(3, [2]), edges, seeds: new Map([[d(1), 1]]), bValue: 4 });
    expect(result.activation.get(d(2))).toBe(0);
    expect(result.activation.get(d(3))).toBe(0);
    expect(result.tensors.get(d(2))!.md).toBe(0);
  });

  it("reaches further with a larger b-value and stays within [0, 1]", () => {
    const edges: FamiliarDiffusionEdgeV1[] = [1, 2, 3, 4].map((i) => ({ from: d(i), to: d(i + 1), direction: "RELATION" as const }));
    const shallow = diffuseFamiliarActivation({ nodes: nodes(5), edges, seeds: new Map([[d(1), 1]]), bValue: 1 });
    const deep = diffuseFamiliarActivation({ nodes: nodes(5), edges, seeds: new Map([[d(1), 1]]), bValue: 4 });
    expect(shallow.activation.get(d(4))).toBe(0);
    expect(deep.activation.get(d(4))!).toBeGreaterThan(0);
    for (const value of deep.activation.values()) expect(value >= 0 && value <= 1).toBe(true);
  });

  it("follows the principal direction as a tract and branches at a crossing", () => {
    const straight = diffuseFamiliarActivation({
      nodes: nodes(4),
      edges: [
        { from: d(2), to: d(1), direction: "LINEAGE" },
        { from: d(3), to: d(2), direction: "LINEAGE" },
        { from: d(1), to: d(4), direction: "EPISODE", weight: 0.5 },
      ],
      seeds: new Map([[d(1), 1]]),
    });
    expect(straight.tracts).toEqual([{ seed: d(1), path: [d(1), d(2), d(3)], directions: ["DERIVATION", "DERIVATION"], crossing: false }]);

    const crossing = diffuseFamiliarActivation({
      nodes: nodes(3),
      // Two directions of equal strength from the seed, to different memories: a crossing.
      edges: [
        { from: d(1), to: d(2), direction: "RELATION" },
        { from: d(1), to: d(3), direction: "LINEAGE", weight: 0.7 },
      ],
      seeds: new Map([[d(1), 1]]),
    });
    expect(crossing.tracts.length).toBe(2);
    expect(crossing.tracts.every((tract) => tract.crossing)).toBe(true);
  });

  it("is deterministic and independent of input order", () => {
    const edges: FamiliarDiffusionEdgeV1[] = [
      { from: d(1), to: d(2), direction: "SCOPE" },
      { from: d(2), to: d(3), direction: "LINEAGE", weight: 0.6 },
      { from: d(3), to: d(4), direction: "RELATION" },
    ];
    const a = diffuseFamiliarActivation({ nodes: nodes(4), edges, seeds: new Map([[d(1), 1], [d(4), 0.5]]) });
    const b = diffuseFamiliarActivation({ nodes: nodes(4).reverse(), edges: [...edges].reverse(), seeds: new Map([[d(4), 0.5], [d(1), 1]]) });
    expect(b.digest).toBe(a.digest);
    expect([...b.activation.entries()].sort()).toEqual([...a.activation.entries()].sort());
  });

  it("refuses malformed graphs instead of guessing", () => {
    expect(() => diffuseFamiliarActivation({ nodes: nodes(2), edges: [{ from: d(1), to: d(9), direction: "SCOPE" }], seeds: new Map() })).toThrow(/FMP_DIFFUSION_INVALID/);
    expect(() => diffuseFamiliarActivation({ nodes: nodes(2), edges: [], seeds: new Map([[d(1), 2]]) })).toThrow(/FMP_DIFFUSION_INVALID/);
    expect(() => diffuseFamiliarActivation({ nodes: nodes(2), edges: [], seeds: new Map(), bValue: 5 })).toThrow(/FMP_DIFFUSION_INVALID/);
  });
});

const NOW = "2026-10-24T12:00:00.000Z";
function memory(id: string, overrides: Partial<FamiliarMemoryArtifactV1> = {}): FamiliarMemoryArtifactV1 {
  return {
    kind: "arobi.familiar-memory", version: 1, memoryId: id, familiarId: "familiar-1", tenantId: "tenant-1", identityEpoch: 1,
    memoryClass: "EPISODIC", contentDigest: d(100 + id.length), originLabelDigest: d(2), sourceArtifacts: [], transformationChain: [],
    trustClass: "OBSERVED", supportState: "OBSERVED", mayInform: true, mayAuthorize: false, revision: 1,
    createdAt: "2026-10-20T12:00:00.000Z", ...overrides,
  };
}
const candidate = (value: FamiliarMemoryArtifactV1) => ({ artifactDigest: sha256DigestCanonical(value), memory: value });
const repo = (id: string) => ({ bindings: [{ kind: "REPOSITORY" as const, id }], dependencies: [], observedAt: NOW });

describe("familiar memory diffusion: the bridge to routing", () => {
  const source = candidate(memory("source"));
  const derived = candidate(memory("derived", { sourceArtifacts: [source.artifactDigest, d(77)] }));
  const sibling = candidate(memory("sibling", { scope: repo("asgard") }));
  const peer = candidate(memory("peer", { scope: repo("asgard") }));
  const elsewhere = candidate(memory("elsewhere", { scope: repo("other") }));
  const withdrawn = candidate(memory("withdrawn", { supportState: "QUARANTINED", sourceArtifacts: [source.artifactDigest] }));
  const all = [source, derived, sibling, peer, elsewhere, withdrawn];
  const environment = { bindings: [{ kind: "REPOSITORY" as const, id: "asgard" }], facts: [] };

  it("links only what memories record: sources in the set and shared bindings, with barriers for this turn", () => {
    const graph = familiarDiffusionGraph(all, { now: NOW, environment });
    expect(graph.edges).toContainEqual({ from: derived.artifactDigest, to: source.artifactDigest, direction: "LINEAGE" });
    expect(graph.edges.some((edge) => edge.to === d(77))).toBe(false);
    const [a, b] = [sibling.artifactDigest, peer.artifactDigest].sort();
    expect(graph.edges).toContainEqual({ from: a, to: b, direction: "SCOPE", weight: 1 });
    expect(graph.edges.some((edge) => edge.direction === "SCOPE" && [edge.from, edge.to].includes(elsewhere.artifactDigest))).toBe(false);
    const barrier = new Map(graph.nodes.map((node) => [node.digest, node.barrier]));
    expect(barrier.get(withdrawn.artifactDigest)).toBe(true);
    expect(barrier.get(elsewhere.artifactDigest)).toBe(true);
    expect(barrier.get(source.artifactDigest)).toBe(false);
  });

  it("fills signals.graph from the semantic seeds, keeps the other signals, and lifts a linked memory in the route", () => {
    const signals = new Map([[derived.artifactDigest, { semantic: 0.9, reliedUpon: 2 }]]);
    const turn = { now: NOW, intents: ["BUILD" as const], tools: [], environment };
    const result = familiarDiffusionSignals({ candidates: all, turn, signals, bValue: 2 });
    expect(result.signals.get(derived.artifactDigest)).toMatchObject({ semantic: 0.9, reliedUpon: 2, graph: 1 });
    expect(result.signals.get(source.artifactDigest)!.graph).toBeGreaterThan(0);
    expect(result.signals.get(withdrawn.artifactDigest)!.graph).toBe(0);
    expect(result.signals.get(sibling.artifactDigest)!.graph).toBe(0);
    expect(result.diffusion.tracts[0]).toMatchObject({ seed: derived.artifactDigest, path: [derived.artifactDigest, source.artifactDigest] });

    const pair = [derived, source];
    const plain = routeFamiliarMemories({ turn, candidates: pair, signals });
    const diffused = routeFamiliarMemories({ turn, candidates: pair, signals: result.signals });
    const scoreOf = (route: typeof plain, digest: Digest) => route.selected.find((entry) => entry.artifactDigest === digest)?.score ?? 0;
    expect(scoreOf(diffused, source.artifactDigest)).toBeGreaterThan(scoreOf(plain, source.artifactDigest));
    expect(diffused.selected.find((entry) => entry.artifactDigest === source.artifactDigest)!.terms.graph).toBeGreaterThan(0);
  });

  it("is a no-op without seeds: every graph signal is 0", () => {
    const result = familiarDiffusionSignals({ candidates: all, turn: { now: NOW, environment } });
    for (const value of result.signals.values()) expect(value.graph).toBe(0);
  });
});
