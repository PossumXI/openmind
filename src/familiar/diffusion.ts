import { sha256DomainDigestCanonical } from "./canonicalize.js";
import {
  familiarMemoryApplicability,
  familiarMemoryValidity,
  type FamiliarRouteSignalsV1,
  type FamiliarTurnV1,
} from "./adapters.js";
import type { FamiliarRetrievalCandidate } from "./retrieval.js";
import type { Digest } from "./types.js";
import { FamiliarValidationError, isDigest } from "./validate.js";

/**
 * Memory diffusion (FMP v1.3): how activation spreads through the memory graph, modelled on diffusion MRI.
 *
 * It produces the `graph` term routeFamiliarMemories already takes (signals.graph), and nothing else. It never
 * admits, filters, promotes or changes trust: admission and validity stay with routing, and a memory that routing
 * refuses stays refused whatever its activation. The model, read from diffusion-weighted imaging:
 *
 * - Anisotropy (DTI). Each memory has a diagonal diffusion tensor over five link directions (lineage up to its
 *   sources, derivation down to what was built from it, the same project or environment scope, an explicit
 *   relationship, the same episode). Activation spreads faster along a memory's strong directions than across
 *   them, the way water moves along an axon bundle and slowly across it.
 * - Restriction (the apparent diffusion coefficient). A barrier node, one that is out of scope, conflicting,
 *   withdrawn or expired for this turn, has zero conductance: activation neither enters nor leaves it, the way a
 *   membrane restricts free water. What is measured is the apparent spread, not the free one.
 * - Depth (the b-value). The number of diffusion steps, 1 to 4, sets how far a turn's activation reaches.
 * - Measures. Per memory: eigenvalues (one per direction, sorted), mean diffusivity MD = mean(lambda), and
 *   fractional anisotropy FA in [0, 1] (0 for a memory linked evenly in every direction, 1 for one direction).
 * - Tractography. From each seed, a path follows the principal direction (the largest eigenvalue's direction, then
 *   the most conductive link in it) while conductance holds and no barrier or cycle is met: the reason a memory
 *   surfaced, as a path. Where a second direction is nearly as strong (crossing fibres, the case the tensor model
 *   averages away and q-ball/DSI keep), the tract branches instead of choosing one.
 *
 * Deterministic: inputs are sorted by digest, arithmetic is rounded to six decimals, and the same graph, seeds and
 * profile always give the same activation, tracts and digest.
 */

export const FAMILIAR_DIFFUSION_SCHEMA = "arobi.familiar-diffusion.v1" as const;
export const FAMILIAR_DIFFUSION_DIRECTIONS = ["LINEAGE", "DERIVATION", "SCOPE", "RELATION", "EPISODE"] as const;
export type FamiliarDiffusionDirection = (typeof FAMILIAR_DIFFUSION_DIRECTIONS)[number];

export interface FamiliarDiffusionProfileV1 {
  schema: typeof FAMILIAR_DIFFUSION_SCHEMA;
  /** Free diffusivity per direction, before a memory's own links. */
  diffusivity: Record<FamiliarDiffusionDirection, number>;
  /** Default b-value: diffusion steps (1 to 4). */
  bValue: number;
  /** Largest Euler step; reduced so the scheme stays stable on dense graphs. */
  maxStep: number;
  /** A tract continues only through links at least this conductive. */
  tractThreshold: number;
  /** A second direction this close to the first (lambda2 / lambda1) is a crossing and branches the tract. */
  crossingRatio: number;
  maxTractLength: number;
  maxSeeds: number;
}

export const FAMILIAR_DIFFUSION_PROFILE_V1: FamiliarDiffusionProfileV1 = Object.freeze({
  schema: FAMILIAR_DIFFUSION_SCHEMA,
  // Starting values with their reason: provenance first (lineage, then what was derived), then explicit
  // relationships, then shared scope, then mere co-occurrence in an episode. Calibrated by evaluation in reviewed
  // revisions, like the adapter weights.
  diffusivity: Object.freeze({ LINEAGE: 1, DERIVATION: 0.8, RELATION: 0.7, SCOPE: 0.5, EPISODE: 0.3 }),
  bValue: 2,
  maxStep: 0.25,
  tractThreshold: 0.1,
  crossingRatio: 0.8,
  maxTractLength: 6,
  maxSeeds: 8,
}) as FamiliarDiffusionProfileV1;

export interface FamiliarDiffusionNodeV1 {
  digest: Digest;
  /** Out of scope, conflicting, withdrawn or expired for this turn: restricted, no conductance. */
  barrier?: boolean;
}

export interface FamiliarDiffusionEdgeV1 {
  /** For LINEAGE, `from` is the derived memory and `to` its source; DERIVATION is the same link read downward. */
  from: Digest;
  to: Digest;
  direction: FamiliarDiffusionDirection;
  /** Link strength in (0, 1], default 1. */
  weight?: number;
}

export interface FamiliarDiffusionTensorV1 {
  /** Diagonal tensor: per-direction diffusivity of this memory's links. */
  lambda: Record<FamiliarDiffusionDirection, number>;
  /** Eigenvalues, largest first, with their directions. */
  principal: FamiliarDiffusionDirection[];
  md: number;
  fa: number;
}

export interface FamiliarDiffusionTractV1 {
  seed: Digest;
  path: Digest[];
  directions: FamiliarDiffusionDirection[];
  /** True where this tract is one branch of a crossing. */
  crossing: boolean;
}

export interface FamiliarDiffusionResultV1 {
  schema: typeof FAMILIAR_DIFFUSION_SCHEMA;
  bValue: number;
  /** Normalized activation in [0, 1]: the `graph` signal for routing. */
  activation: Map<Digest, number>;
  tensors: Map<Digest, FamiliarDiffusionTensorV1>;
  tracts: FamiliarDiffusionTractV1[];
  /** Commits the inputs and the outputs, without memory content. */
  digest: Digest;
}

function fail(code: string, message: string): never {
  throw new FamiliarValidationError(code, message);
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

const DIRECTION_SET = new Set<string>(FAMILIAR_DIFFUSION_DIRECTIONS);

/** Code-unit order: the same on every host, unlike localeCompare, so the digest never depends on collation. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const inRange = (value: unknown, min: number, max: number, minOpen = false): boolean =>
  typeof value === "number" && Number.isFinite(value) && (minOpen ? value > min : value >= min) && value <= max;
const integerIn = (value: unknown, min: number, max: number): boolean =>
  Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;

/** A caller-supplied profile is checked field by field: a missing or non-finite value refuses, never poisons. */
function checkedProfile(profile: FamiliarDiffusionProfileV1): FamiliarDiffusionProfileV1 {
  const invalid = (field: string): never => fail("FMP_DIFFUSION_PROFILE_INVALID", `profile.${field} is out of range`);
  if (!profile || profile.schema !== FAMILIAR_DIFFUSION_SCHEMA) fail("FMP_DIFFUSION_PROFILE_INVALID", "unknown diffusion profile");
  if (!profile.diffusivity || typeof profile.diffusivity !== "object") invalid("diffusivity");
  for (const direction of FAMILIAR_DIFFUSION_DIRECTIONS) {
    if (!inRange(profile.diffusivity[direction], 0, 1)) invalid(`diffusivity.${direction}`);
  }
  if (!integerIn(profile.bValue, 1, 4)) invalid("bValue");
  if (!inRange(profile.maxStep, 0, 1, true)) invalid("maxStep");
  if (!inRange(profile.tractThreshold, 0, 1)) invalid("tractThreshold");
  if (!inRange(profile.crossingRatio, 0, 1, true)) invalid("crossingRatio");
  if (!integerIn(profile.maxTractLength, 2, 64)) invalid("maxTractLength");
  if (!integerIn(profile.maxSeeds, 1, 256)) invalid("maxSeeds");
  return profile;
}
const REVERSE: Record<FamiliarDiffusionDirection, FamiliarDiffusionDirection> = {
  LINEAGE: "DERIVATION", DERIVATION: "LINEAGE", SCOPE: "SCOPE", RELATION: "RELATION", EPISODE: "EPISODE",
};

interface Link { to: Digest; direction: FamiliarDiffusionDirection; conductance: number }

/** FA generalized to n eigenvalues: sqrt(n/(n-1)) * |lambda - mean| / |lambda|; 0 when every lambda is 0. */
export function fractionalAnisotropy(lambdas: readonly number[]): number {
  const n = lambdas.length;
  if (n < 2) return 0;
  const norm = Math.sqrt(lambdas.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) return 0;
  const mean = lambdas.reduce((sum, value) => sum + value, 0) / n;
  const spread = Math.sqrt(lambdas.reduce((sum, value) => sum + (value - mean) * (value - mean), 0));
  return round6(Math.min(1, Math.sqrt(n / (n - 1)) * (spread / norm)));
}

/**
 * Activation spread over the memory graph from the turn's seeds, with the measures and tracts that explain it.
 * Seeds are the memories the turn already matched (for example by semantic similarity), with strengths in (0, 1].
 */
export function diffuseFamiliarActivation(input: {
  nodes: readonly FamiliarDiffusionNodeV1[];
  edges: readonly FamiliarDiffusionEdgeV1[];
  seeds: ReadonlyMap<Digest, number>;
  bValue?: number;
  profile?: FamiliarDiffusionProfileV1;
}): FamiliarDiffusionResultV1 {
  const profile = checkedProfile(input.profile ?? FAMILIAR_DIFFUSION_PROFILE_V1);
  const bValue = input.bValue ?? profile.bValue;
  if (!Number.isSafeInteger(bValue) || bValue < 1 || bValue > 4) fail("FMP_DIFFUSION_INVALID", "bValue must be 1 to 4");

  const nodes = [...input.nodes].sort((a, b) => byCodeUnit(a.digest, b.digest));
  const barrier = new Map<Digest, boolean>();
  for (const node of nodes) {
    if (!isDigest(node.digest)) fail("FMP_DIFFUSION_INVALID", "node digest is invalid");
    if (barrier.has(node.digest)) fail("FMP_DIFFUSION_INVALID", "duplicate node");
    barrier.set(node.digest, node.barrier === true);
  }

  // Undirected conductances; a link touching a barrier conducts nothing (restriction).
  const links = new Map<Digest, Link[]>(nodes.map((node) => [node.digest, []]));
  const edgeKeys = new Set<string>();
  const edges = [...input.edges].sort((a, b) => byCodeUnit(`${a.from}|${a.to}|${a.direction}`, `${b.from}|${b.to}|${b.direction}`));
  for (const edge of edges) {
    if (!DIRECTION_SET.has(edge.direction)) fail("FMP_DIFFUSION_INVALID", "edge direction is unknown");
    if (!barrier.has(edge.from) || !barrier.has(edge.to) || edge.from === edge.to) fail("FMP_DIFFUSION_INVALID", "edge must join two distinct known nodes");
    const weight = edge.weight ?? 1;
    if (!(weight > 0 && weight <= 1)) fail("FMP_DIFFUSION_INVALID", "edge weight must be in (0, 1]");
    const key = `${edge.from}|${edge.to}|${edge.direction}`;
    if (edgeKeys.has(key)) fail("FMP_DIFFUSION_INVALID", "duplicate edge");
    edgeKeys.add(key);
    const conductance = barrier.get(edge.from) || barrier.get(edge.to) ? 0 : round6(profile.diffusivity[edge.direction] * weight);
    links.get(edge.from)!.push({ to: edge.to, direction: edge.direction, conductance });
    links.get(edge.to)!.push({ to: edge.from, direction: REVERSE[edge.direction], conductance });
  }

  // Tensors: diagonal, per direction, from the memory's own conducting links.
  const tensors = new Map<Digest, FamiliarDiffusionTensorV1>();
  for (const node of nodes) {
    const lambda = Object.fromEntries(FAMILIAR_DIFFUSION_DIRECTIONS.map((direction) => [direction, 0])) as Record<FamiliarDiffusionDirection, number>;
    for (const link of links.get(node.digest)!) lambda[link.direction] = round6(lambda[link.direction] + link.conductance);
    const values = FAMILIAR_DIFFUSION_DIRECTIONS.map((direction) => lambda[direction]);
    const principal = [...FAMILIAR_DIFFUSION_DIRECTIONS].sort((a, b) => lambda[b] - lambda[a] || FAMILIAR_DIFFUSION_DIRECTIONS.indexOf(a) - FAMILIAR_DIFFUSION_DIRECTIONS.indexOf(b));
    tensors.set(node.digest, { lambda, principal, md: round6(values.reduce((s, v) => s + v, 0) / values.length), fa: fractionalAnisotropy(values) });
  }

  // Seeds.
  const seeds = [...input.seeds.entries()]
    .filter(([digest, strength]) => {
      if (!barrier.has(digest)) fail("FMP_DIFFUSION_INVALID", "seed is not a known node");
      if (!(strength > 0 && strength <= 1)) fail("FMP_DIFFUSION_INVALID", "seed strength must be in (0, 1]");
      return !barrier.get(digest);
    })
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, profile.maxSeeds);

  // Explicit Euler on the graph Laplacian: a_i += dt * sum_j c_ij (a_j - a_i). Conservative and, with
  // dt * max_i sum_j c_ij <= 1, monotone and bounded. Barriers hold nothing.
  const degree = Math.max(0, ...nodes.map((node) => links.get(node.digest)!.reduce((s, l) => s + l.conductance, 0)));
  const dt = degree > 0 ? Math.min(profile.maxStep, 1 / degree) : profile.maxStep;
  let activation = new Map<Digest, number>(nodes.map((node) => [node.digest, 0]));
  for (const [digest, strength] of seeds) activation.set(digest, strength);
  for (let step = 0; step < bValue; step += 1) {
    const next = new Map<Digest, number>();
    for (const node of nodes) {
      const own = activation.get(node.digest)!;
      let flow = 0;
      for (const link of links.get(node.digest)!) flow += link.conductance * (activation.get(link.to)! - own);
      next.set(node.digest, round6(own + dt * flow));
    }
    activation = next;
  }
  const peak = Math.max(0, ...activation.values());
  const normalized = new Map<Digest, number>();
  for (const node of nodes) normalized.set(node.digest, peak > 0 ? round6(activation.get(node.digest)! / peak) : 0);

  // Tractography along principal directions, branching at crossings.
  const tracts: FamiliarDiffusionTractV1[] = [];
  const strongest = (digest: Digest, direction: FamiliarDiffusionDirection, visited: Set<Digest>) =>
    links.get(digest)!
      .filter((link) => link.direction === direction && link.conductance >= profile.tractThreshold && !visited.has(link.to) && !barrier.get(link.to))
      .sort((a, b) => b.conductance - a.conductance || (a.to < b.to ? -1 : 1))[0];
  // maxTractLength bounds the memories on a tract, the seed included.
  const follow = (seed: Digest, path: Digest[], directions: FamiliarDiffusionDirection[], crossing: boolean) => {
    const here = path[path.length - 1];
    const tensor = tensors.get(here)!;
    const visited = new Set(path);
    // An axis has no sign: the way back is already visited, so the tract continues along the strongest direction
    // that still leads somewhere new, and branches when the next one is nearly as strong (a crossing).
    const open = tensor.principal
      .filter((direction) => tensor.lambda[direction] > 0)
      .map((direction) => ({ direction, link: strongest(here, direction, visited) }))
      .filter((entry): entry is { direction: FamiliarDiffusionDirection; link: Link } => entry.link !== undefined);
    const firstLink = open[0]?.link;
    const other = open.slice(1).find((entry) => entry.link.to !== firstLink?.to);
    const branch = other && tensor.lambda[other.direction] >= profile.crossingRatio * tensor.lambda[open[0].direction]
      ? other.link : undefined;
    if (!firstLink || path.length >= profile.maxTractLength) {
      if (path.length > 1) tracts.push({ seed, path, directions, crossing });
      return;
    }
    follow(seed, [...path, firstLink.to], [...directions, firstLink.direction], crossing || Boolean(branch));
    if (branch && branch.to !== firstLink.to) follow(seed, [...path, branch.to], [...directions, branch.direction], true);
  };
  for (const [seed] of seeds) follow(seed, [seed], [], false);

  const digest = sha256DomainDigestCanonical("arobi/familiar-diffusion/v1", {
    profile,
    bValue,
    nodes: nodes.map((node) => [node.digest, node.barrier === true]),
    edges: edges.map((edge) => [edge.from, edge.to, edge.direction, edge.weight ?? 1]),
    seeds,
    activation: [...normalized.entries()],
    tracts: tracts.map((tract) => [tract.seed, tract.path, tract.directions, tract.crossing]),
  });
  return { schema: FAMILIAR_DIFFUSION_SCHEMA, bValue, activation: normalized, tensors, tracts, digest };
}

// ---------------------------------------------------------------------------------------------------------------
// The bridge to routing: the graph from what memories already record, and the signals routing takes.

/**
 * The diffusion graph over the candidates routing will weigh, built only from what each memory records: a LINEAGE
 * link to each of its sources that is also a candidate, and a SCOPE link between memories bound to the same
 * environment (a shared binding kind and id). Nothing is inferred from content. Each memory's SCOPE links share one
 * unit of weight across its scope group, so a large project does not drown a lineage. A candidate that is not
 * CURRENT, or is out of scope or in conflict for this turn, is a barrier.
 */
export function familiarDiffusionGraph(
  candidates: readonly FamiliarRetrievalCandidate[],
  turn: Pick<FamiliarTurnV1, "now" | "environment">,
): { nodes: FamiliarDiffusionNodeV1[]; edges: FamiliarDiffusionEdgeV1[] } {
  const nowMillis = Date.parse(turn.now);
  if (!Number.isFinite(nowMillis)) fail("FMP_DIFFUSION_INVALID", "turn.now must be a timestamp");
  const known = new Set(candidates.map((candidate) => candidate.artifactDigest));
  const nodes = candidates.map(({ artifactDigest, memory }) => {
    const { applicability } = familiarMemoryApplicability(memory.scope, turn.environment);
    const validity = familiarMemoryValidity(memory, applicability, nowMillis);
    return { digest: artifactDigest, barrier: validity !== "CURRENT" || applicability === "OUT_OF_SCOPE" || applicability === "CONFLICT" };
  });

  const edges: FamiliarDiffusionEdgeV1[] = [];
  const groups = new Map<string, Digest[]>();
  for (const { artifactDigest, memory } of candidates) {
    for (const source of new Set(memory.sourceArtifacts)) {
      if (source !== artifactDigest && known.has(source)) edges.push({ from: artifactDigest, to: source, direction: "LINEAGE" });
    }
    for (const binding of memory.scope?.bindings ?? []) {
      const key = `${binding.kind}\u0000${binding.id}`;
      groups.set(key, [...(groups.get(key) ?? []), artifactDigest]);
    }
  }
  const scope = new Map<string, number>();
  for (const members of groups.values()) {
    const sorted = [...new Set(members)].sort();
    if (sorted.length < 2) continue;
    const weight = 1 / (sorted.length - 1);
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        const key = `${sorted[i]}|${sorted[j]}`;
        scope.set(key, Math.min(1, (scope.get(key) ?? 0) + weight));
      }
    }
  }
  for (const [key, weight] of [...scope.entries()].sort(([a], [b]) => byCodeUnit(a, b))) {
    const [from, to] = key.split("|") as [Digest, Digest];
    edges.push({ from, to, direction: "SCOPE", weight: round6(weight) });
  }
  return { nodes, edges };
}

/**
 * Routing signals with the graph term filled in from diffusion: the seeds are the candidates the caller's own
 * index matched (signals.semantic above zero), and each candidate's graph signal is its diffused activation. The
 * other signals pass through unchanged. The diffusion result comes back too, for its digest, tensors and tracts.
 */
export function familiarDiffusionSignals(input: {
  candidates: readonly FamiliarRetrievalCandidate[];
  turn: Pick<FamiliarTurnV1, "now" | "environment">;
  signals?: ReadonlyMap<Digest, FamiliarRouteSignalsV1>;
  bValue?: number;
  profile?: FamiliarDiffusionProfileV1;
}): { signals: Map<Digest, FamiliarRouteSignalsV1>; diffusion: FamiliarDiffusionResultV1 } {
  const { nodes, edges } = familiarDiffusionGraph(input.candidates, input.turn);
  const seeds = new Map<Digest, number>();
  for (const { artifactDigest } of input.candidates) {
    const semantic = input.signals?.get(artifactDigest)?.semantic;
    if (typeof semantic === "number" && Number.isFinite(semantic) && semantic > 0) seeds.set(artifactDigest, Math.min(1, semantic));
  }
  const diffusion = diffuseFamiliarActivation({ nodes, edges, seeds, bValue: input.bValue, profile: input.profile });
  const signals = new Map<Digest, FamiliarRouteSignalsV1>();
  for (const { artifactDigest } of input.candidates) {
    signals.set(artifactDigest, { ...input.signals?.get(artifactDigest), graph: diffusion.activation.get(artifactDigest) ?? 0 });
  }
  return { signals, diffusion };
}
