/**
 * How long Familiar recall's ranking takes: diffusion over the candidates' graph (familiarDiffusionSignals), the route
 * (routeFamiliarMemories) and the diffusion evidence a context-use receipt binds, on synthetic memory sets of several
 * sizes. Prints one JSON report with p50, p95 and max per size. A measurement, not a test: nothing here passes or
 * fails, and the numbers belong to the machine that ran it.
 *
 *   npx tsx scripts/bench-familiar-recall.ts [--sizes 100,1000,5000] [--runs 30]
 */
import { cpus, setPriority } from "node:os";
import { performance } from "node:perf_hooks";
import { familiarDiffusionEvidence, familiarDiffusionSignals } from "../src/familiar/diffusion.js";
import { routeFamiliarMemories, type FamiliarRouteSignalsV1 } from "../src/familiar/adapters.js";
import { sha256DigestCanonical } from "../src/familiar/canonicalize.js";
import type { Digest, FamiliarMemoryArtifactV1 } from "../src/familiar/types.js";

const arg = (name: string, fallback: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const SIZES = arg("sizes", "100,1000,5000").split(",").map(Number);
const RUNS = Number(arg("runs", "30"));
const SEEDS = 20;
const NOW = "2026-10-30T12:00:00.000Z";
const d = (n: number) => `sha256:${n.toString(16).padStart(64, "0")}` as Digest;

try {
  setPriority(0, 10); // below normal, so a measurement never competes with real work
} catch {
  // not permitted here: run at the default priority
}

/** A deterministic memory set: each memory is derived from one or two earlier ones, scopes group 25, episodes 10. */
function memories(count: number) {
  const out: Array<{ artifactDigest: Digest; memory: FamiliarMemoryArtifactV1 }> = [];
  for (let i = 0; i < count; i += 1) {
    const sources = i === 0 ? [] : [out[(i * 7) % i].artifactDigest, ...(i % 3 === 0 && i > 1 ? [out[(i * 13) % i].artifactDigest] : [])];
    const memory: FamiliarMemoryArtifactV1 = {
      kind: "arobi.familiar-memory", version: 1, memoryId: `m-${i}`, familiarId: "familiar-1", tenantId: "tenant-1", identityEpoch: 1,
      memoryClass: i % 5 === 0 ? "SEMANTIC" : "EPISODIC", contentDigest: d(10_000 + i), originLabelDigest: d(2),
      sourceArtifacts: [...new Set(sources)], transformationChain: [], trustClass: "OBSERVED", supportState: "OBSERVED",
      mayInform: true, mayAuthorize: false, revision: 1, createdAt: "2026-10-20T12:00:00.000Z",
      scope: { bindings: [{ kind: "REPOSITORY", id: `repo-${Math.floor(i / 25)}` }], dependencies: [], observedAt: NOW },
      links: { episode: `episode-${Math.floor(i / 10)}` },
    } as FamiliarMemoryArtifactV1;
    out.push({ artifactDigest: sha256DigestCanonical(memory), memory });
  }
  return out;
}

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
const ms = (value: number) => Math.round(value * 100) / 100;

const results = [];
for (const size of SIZES) {
  const candidates = memories(size);
  const environment = { bindings: [{ kind: "REPOSITORY" as const, id: "repo-0" }], facts: [] };
  const turn = { now: NOW, intents: ["BUILD" as const], tools: [], environment };
  const signals = new Map<Digest, FamiliarRouteSignalsV1>();
  for (let s = 0; s < Math.min(SEEDS, size); s += 1) signals.set(candidates[(s * 37) % size].artifactDigest, { semantic: 1 - s / (SEEDS * 2) });
  const timings: number[] = [];
  let tensorCount = 0;
  let tracts = 0;
  for (let run = 0; run < RUNS + 2; run += 1) {
    const started = performance.now();
    const diffused = familiarDiffusionSignals({ candidates, turn, signals });
    const route = routeFamiliarMemories({ turn, candidates, signals: diffused.signals });
    familiarDiffusionEvidence(diffused.diffusion);
    const elapsed = performance.now() - started;
    if (run >= 2) timings.push(elapsed); // two warm-up runs are not counted
    tracts = diffused.diffusion.tracts.length;
    tensorCount = diffused.diffusion.tensors.size;
    if (route.selected.length === 0) throw new Error("the route selected nothing: the bench set is wrong");
  }
  const sorted = [...timings].sort((a, b) => a - b);
  results.push({ memories: size, runs: RUNS, p50Ms: ms(percentile(sorted, 50)), p95Ms: ms(percentile(sorted, 95)), maxMs: ms(sorted[sorted.length - 1]), tracts, memoriesWithTensors: tensorCount });
}

console.log(JSON.stringify({
  schema: "arobi.familiar-recall-bench.v1",
  measured: "familiarDiffusionSignals + routeFamiliarMemories + familiarDiffusionEvidence, per turn",
  node: process.version,
  cpu: cpus()[0]?.model ?? "unknown",
  results,
}, null, 2));
