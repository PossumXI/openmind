import { sha256DigestCanonical } from "./canonicalize.js";
import type {
  Digest,
  FamiliarMemoryArtifactV1,
  FamiliarMemoryClass,
  MemorySupportState,
  MemoryTrustClass,
} from "./types.js";

export interface FamiliarRetrievalSource {
  readCurrentMemories(args: {
    tenantId: string;
    familiarId: string;
    identityEpoch: number;
  }): Promise<FamiliarMemoryArtifactV1[]>;
}

export interface FamiliarRetrievalRequest {
  tenantId: string;
  familiarId: string;
  /**
   * Retrieval is identity-epoch scoped in v1. Fork/branch lineage is added in
   * the later continuity/capsule phase and must remain an explicit policy input.
   */
  identityEpoch: number;
  allowedSupportStates: readonly MemorySupportState[];
  allowedTrustClasses: readonly MemoryTrustClass[];
  allowedMemoryClasses?: readonly FamiliarMemoryClass[];
  /** Exclude artifacts whose policy says they may not inform the current task. */
  requireMayInform?: boolean;
  /** ISO timestamp used only for deterministic expiry filtering. */
  now?: string;
  limit?: number;
}

export interface FamiliarRetrievalCandidate {
  artifactDigest: Digest;
  memory: FamiliarMemoryArtifactV1;
}

export interface FamiliarRetrievalRank {
  artifactDigest: Digest;
  score: number;
}

export type FamiliarRetrievalRanker = (
  candidates: readonly FamiliarRetrievalCandidate[],
) => readonly FamiliarRetrievalRank[] | Promise<readonly FamiliarRetrievalRank[]>;

export interface FamiliarRetrievalResult extends FamiliarRetrievalCandidate {
  score?: number;
}

function nonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new Error(`FMP retrieval requires non-empty ${label}`);
}

function boundedLimit(value: number | undefined): number {
  const limit = value ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("FMP retrieval limit must be an integer between 1 and 200");
  }
  return limit;
}

function nonEmptySet<T extends string>(values: readonly T[], label: string): Set<T> {
  if (values.length === 0) throw new Error(`FMP retrieval requires at least one ${label}`);
  return new Set(values);
}

function parseNow(now: string | undefined): number {
  if (now === undefined) return Date.now();
  const value = Date.parse(now);
  if (!Number.isFinite(value)) throw new Error("FMP retrieval now must be a valid timestamp");
  return value;
}

function createdAtMillis(memory: FamiliarMemoryArtifactV1): number {
  const parsed = Date.parse(memory.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isExpired(memory: FamiliarMemoryArtifactV1, nowMillis: number): boolean {
  if (!memory.expiresAt) return false;
  const expiry = Date.parse(memory.expiresAt);
  // Canonical validators should reject malformed timestamps before persistence.
  // Fail closed here if corrupted legacy data reaches the retrieval boundary.
  return !Number.isFinite(expiry) || expiry <= nowMillis;
}

/**
 * Provenance-preserving FMP retrieval.
 *
 * Security ordering is deliberate:
 *   tenant/familiar -> identity epoch -> support -> trust/purpose -> ranking.
 *
 * The ranker receives only candidates that already passed every load-bearing
 * scope/policy filter. A semantic/vector/graph ranker therefore cannot turn a
 * global nearest-neighbor result into an authorized familiar-memory result.
 */
export async function retrieveFamiliarMemories(
  source: FamiliarRetrievalSource,
  request: FamiliarRetrievalRequest,
  ranker?: FamiliarRetrievalRanker,
): Promise<FamiliarRetrievalResult[]> {
  nonEmpty(request.tenantId, "tenantId");
  nonEmpty(request.familiarId, "familiarId");
  if (!Number.isSafeInteger(request.identityEpoch) || request.identityEpoch < 0) {
    throw new Error("FMP retrieval identityEpoch must be a non-negative safe integer");
  }

  const supportStates = nonEmptySet(request.allowedSupportStates, "allowedSupportStates");
  const trustClasses = nonEmptySet(request.allowedTrustClasses, "allowedTrustClasses");
  const memoryClasses = request.allowedMemoryClasses
    ? nonEmptySet(request.allowedMemoryClasses, "allowedMemoryClasses")
    : null;
  const limit = boundedLimit(request.limit);
  const nowMillis = parseNow(request.now);
  const requireMayInform = request.requireMayInform ?? true;

  // The canonical persistence adapter applies tenant/familiar/identity-epoch
  // scope in SQL before returning any rows. We still re-check below as defense
  // in depth against corruption or an alternate source implementation.
  const rows = await source.readCurrentMemories({
    tenantId: request.tenantId,
    familiarId: request.familiarId,
    identityEpoch: request.identityEpoch,
  });

  const filtered: FamiliarRetrievalCandidate[] = [];
  for (const memory of rows) {
    if (memory.tenantId !== request.tenantId || memory.familiarId !== request.familiarId) continue;
    if (memory.identityEpoch !== request.identityEpoch) continue;
    if (!supportStates.has(memory.supportState)) continue;
    if (!trustClasses.has(memory.trustClass)) continue;
    if (memoryClasses && !memoryClasses.has(memory.memoryClass)) continue;
    if (requireMayInform && !memory.mayInform) continue;
    if (memory.mayAuthorize !== false) continue;
    if (isExpired(memory, nowMillis)) continue;

    filtered.push({
      artifactDigest: sha256DigestCanonical(memory),
      memory,
    });
  }

  if (!ranker) {
    return filtered
      .sort((a, b) => {
        const timeDelta = createdAtMillis(b.memory) - createdAtMillis(a.memory);
        if (timeDelta !== 0) return timeDelta;
        if (a.memory.memoryId !== b.memory.memoryId) {
          return a.memory.memoryId.localeCompare(b.memory.memoryId);
        }
        return b.memory.revision - a.memory.revision;
      })
      .slice(0, limit);
  }

  const allowed = new Map(filtered.map((candidate) => [candidate.artifactDigest, candidate]));
  const ranks = await ranker(Object.freeze([...filtered]));
  const seen = new Set<Digest>();
  const ranked: Array<FamiliarRetrievalResult & { score: number }> = [];

  for (const rank of ranks) {
    if (!Number.isFinite(rank.score)) {
      throw new Error("FMP retrieval ranker returned a non-finite score");
    }
    if (seen.has(rank.artifactDigest)) {
      throw new Error("FMP retrieval ranker returned a duplicate artifact digest");
    }
    const candidate = allowed.get(rank.artifactDigest);
    if (!candidate) {
      throw new Error("FMP retrieval ranker returned an artifact outside the scoped candidate set");
    }
    seen.add(rank.artifactDigest);
    ranked.push({ ...candidate, score: rank.score });
  }

  ranked.sort((a, b) => {
    const scoreDelta = b.score - a.score;
    if (scoreDelta !== 0) return scoreDelta;
    return a.artifactDigest.localeCompare(b.artifactDigest);
  });
  return ranked.slice(0, limit);
}
