import { describe, expect, it } from "vitest";
import {
  diffuseFamiliarActivation,
  fractionalAnisotropy,
  type FamiliarDiffusionEdgeV1,
  type FamiliarDiffusionNodeV1,
} from "../../src/familiar/diffusion.js";
import type { Digest } from "../../src/familiar/types.js";

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
