import { sha256DigestCanonical } from "./canonicalize.js";
import type { FamiliarPayloadVault, FamiliarPayloadOpenResult } from "./payload-vault.js";
import type {
  FamiliarPromotionCommitStore,
  FamiliarPromotionCommitV1,
} from "./promotion-store.js";
import {
  retrieveFamiliarMemories,
  type FamiliarRetrievalRanker,
  type FamiliarRetrievalRequest,
  type FamiliarRetrievalResult,
} from "./retrieval.js";
import type { Digest } from "./types.js";

export type CommittedFamiliarRetrievalResult = FamiliarRetrievalResult & {
  promotionCommitId: string;
  promotionCommitDigest: Digest;
  payload: FamiliarPayloadOpenResult;
};

export interface CommittedFamiliarRetrievalRequest extends FamiliarRetrievalRequest {}

/**
 * Recall only from authoritative promotion commits.
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
  commits: FamiliarPromotionCommitStore;
  vault: FamiliarPayloadVault;
  request: CommittedFamiliarRetrievalRequest;
  ranker?: FamiliarRetrievalRanker;
}): Promise<CommittedFamiliarRetrievalResult[]> {
  const commits = await args.commits.read({
    tenantId: args.request.tenantId,
    familiarId: args.request.familiarId,
    identityEpoch: args.request.identityEpoch,
  });

  const byArtifactDigest = new Map<Digest, FamiliarPromotionCommitV1>();
  const memoryIds = new Set<string>();
  for (const commit of commits) {
    if (memoryIds.has(commit.memoryId)) {
      throw new Error("FMP committed retrieval found multiple promotion commits for one memory id");
    }
    memoryIds.add(commit.memoryId);
    const artifactDigest = sha256DigestCanonical(commit.memory);
    if (artifactDigest !== commit.memoryDigest) {
      throw new Error("FMP committed retrieval memory digest does not match promotion commit");
    }
    if (byArtifactDigest.has(artifactDigest)) {
      throw new Error("FMP committed retrieval found duplicate memory artifact digests");
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
      throw new Error("FMP committed retrieval selected memory without an authoritative promotion commit");
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
