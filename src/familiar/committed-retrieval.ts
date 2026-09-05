import { sha256DigestCanonical } from "./canonicalize.js";
import type { FamiliarForgetCommitV1 } from "./forget-store.js";
import type { FamiliarPayloadOpenResult } from "./payload-vault.js";
import type { FamiliarPromotionCommitV1 } from "./promotion-store.js";
import {
  retrieveFamiliarMemories,
  type FamiliarRetrievalRanker,
  type FamiliarRetrievalRequest,
  type FamiliarRetrievalResult,
} from "./retrieval.js";
import type { Digest } from "./types.js";

export interface FamiliarPromotionCommitSource {
  read(args: {
    tenantId: string;
    familiarId: string;
    identityEpoch: number;
  }): Promise<FamiliarPromotionCommitV1[]>;
}

export interface FamiliarForgetCommitSource {
  read(args: {
    tenantId: string;
    familiarId: string;
    identityEpoch: number;
  }): Promise<FamiliarForgetCommitV1[]>;
}

export interface FamiliarPayloadOpenSource {
  open(commit: FamiliarPromotionCommitV1): Promise<FamiliarPayloadOpenResult>;
}

export type CommittedFamiliarRetrievalResult = FamiliarRetrievalResult & {
  promotionCommitId: string;
  promotionCommitDigest: Digest;
  payload: FamiliarPayloadOpenResult;
};

export interface CommittedFamiliarRetrievalRequest extends FamiliarRetrievalRequest {}

/**
 * Recall only from authoritative promotion commits that do not have a verified
 * authoritative forget commit.
 *
 * Sources are deliberately structural interfaces rather than concrete write-
 * oriented store classes. Production write paths may use the normal stores;
 * synchronous recall/shadow paths may use SELECT-only adapters without schema
 * `ensure()`/DDL side effects.
 *
 * The forget ledger is a required dependency, not an optional enhancement: a
 * caller may not bypass forgetting merely by omitting the tombstone source.
 *
 * The ranker receives memory metadata/digests only. Protected plaintext is
 * opened after scope/policy/ranking has selected a committed artifact, so a
 * vector/semantic ranker never gets a chance to broaden tenant/familiar scope
 * by searching plaintext globally.
 *
 * Payload failure is explicit on each result. The caller may record an artifact
 * as `retrieved`, but it must not record it as `opened`/`reliedUpon` unless
 * `payload.state === "AVAILABLE"`.
 */
export async function retrieveCommittedFamiliarMemories(args: {
  commits: FamiliarPromotionCommitSource;
  forgets: FamiliarForgetCommitSource;
  vault: FamiliarPayloadOpenSource;
  request: CommittedFamiliarRetrievalRequest;
  ranker?: FamiliarRetrievalRanker;
}): Promise<CommittedFamiliarRetrievalResult[]> {
  const [allPromotions, forgetCommits] = await Promise.all([
    args.commits.read({
      tenantId: args.request.tenantId,
      familiarId: args.request.familiarId,
      identityEpoch: args.request.identityEpoch,
    }),
    args.forgets.read({
      tenantId: args.request.tenantId,
      familiarId: args.request.familiarId,
      identityEpoch: args.request.identityEpoch,
    }),
  ]);

  const forgottenPromotionIds = new Set<string>();
  for (const forget of forgetCommits) {
    if (forgottenPromotionIds.has(forget.promotionCommitId)) {
      throw new Error("FMP committed retrieval found duplicate forget commits for one promotion");
    }
    forgottenPromotionIds.add(forget.promotionCommitId);
  }

  const commits = allPromotions.filter((commit) => {
    const forgotten = forgetCommits.find(
      (entry) => entry.promotionCommitId === commit.commitId,
    );
    if (!forgotten) return true;
    const promotionDigest = sha256DigestCanonical(commit);
    if (
      forgotten.promotionCommitDigest !== promotionDigest ||
      forgotten.memoryId !== commit.memoryId ||
      forgotten.memoryDigest !== commit.memoryDigest
    ) {
      throw new Error("FMP forget commit does not match the promotion it attempts to suppress");
    }
    return false;
  });

  const knownPromotionIds = new Set(allPromotions.map((commit) => commit.commitId));
  for (const forget of forgetCommits) {
    if (!knownPromotionIds.has(forget.promotionCommitId)) {
      // A verified orphan tombstone is evidence corruption/incomplete history,
      // not a reason to suppress some unrelated memory silently.
      throw new Error("FMP committed retrieval found forget commit without matching promotion history");
    }
  }

  const byArtifactDigest = new Map<Digest, FamiliarPromotionCommitV1>();
  const memoryIds = new Set<string>();
  for (const commit of commits) {
    if (memoryIds.has(commit.memoryId)) {
      throw new Error("FMP committed retrieval found multiple live promotion commits for one memory id");
    }
    memoryIds.add(commit.memoryId);
    const artifactDigest = sha256DigestCanonical(commit.memory);
    if (artifactDigest !== commit.memoryDigest) {
      throw new Error("FMP committed retrieval memory digest does not match promotion commit");
    }
    if (byArtifactDigest.has(artifactDigest)) {
      throw new Error("FMP committed retrieval found duplicate live memory artifact digests");
    }
    byArtifactDigest.set(artifactDigest, commit);
  }

  const metadata = await retrieveFamiliarMemories(
    {
      readCurrentMemories: async ({ tenantId, familiarId }) => {
        if (tenantId !== args.request.tenantId || familiarId !== args.request.familiarId) {
          throw new Error("FMP committed retrieval source was called with unexpected scope");
        }
        return commits.map((commit) => commit.memory);
      },
    },
    args.request,
    args.ranker,
  );

  const results: CommittedFamiliarRetrievalResult[] = [];
  for (const result of metadata) {
    const commit = byArtifactDigest.get(result.artifactDigest);
    if (!commit) {
      throw new Error("FMP committed retrieval selected memory without an authoritative live promotion commit");
    }
    results.push({
      ...result,
      promotionCommitId: commit.commitId,
      promotionCommitDigest: sha256DigestCanonical(commit),
      payload: await args.vault.open(commit),
    });
  }
  return results;
}

export function openedCommittedArtifactDigests(
  results: readonly CommittedFamiliarRetrievalResult[],
): Digest[] {
  return results
    .filter((result) => result.payload.state === "AVAILABLE")
    .map((result) => result.artifactDigest);
}
