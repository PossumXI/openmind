import { sha256DigestCanonical } from "./canonicalize.js";
import type { FamiliarForgetSurfaceResult } from "./forgetting.js";
import type { FamiliarPromotionCommitV1 } from "./promotion-store.js";

/**
 * Current OpenMind graph profile that is relevant to the FMP forgetting gate.
 *
 * This profile is deliberately narrow. It refers only to the repository's
 * existing `hivemind graph` implementation whose snapshots are constructed from
 * supported source files/tree-sitter code extraction and persisted to the
 * `codebase` table. It does NOT assert that all possible future graph systems
 * are non-memory projections.
 */
export const OPENMIND_CURRENT_GRAPH_PROFILE = Object.freeze({
  profile: "hivemind-codebase-graph",
  graphGenerator: "hivemind-graph",
  graphSchemaVersion: 1,
  sourceDomain: "repository-source-files",
  cloudTableFamily: "codebase",
  familiarContentIngestion: false,
} as const);

export const OPENMIND_CURRENT_GRAPH_PROFILE_DIGEST =
  sha256DigestCanonical(OPENMIND_CURRENT_GRAPH_PROFILE);

/**
 * FMP controlled-forgetting adapter for the CURRENT OpenMind graph profile.
 *
 * `NOT_APPLICABLE` is correct because the current graph is a codebase AST /
 * dependency graph and has no session-event, wiki-summary, familiar-memory or
 * protected-payload ingestion path. No graph rows are deleted because doing so
 * would destroy unrelated source-code evidence without improving forgetting.
 *
 * Future rule: if a memory/entity/conversation graph is introduced, do not
 * broaden this profile. Add a distinct graph profile + erasure implementation
 * and keep forgetting INCOMPLETE until that new controlled surface verifies.
 */
export async function eraseCurrentOpenMindGraphProjection(
  _commit: FamiliarPromotionCommitV1,
): Promise<FamiliarForgetSurfaceResult> {
  return {
    surface: "GRAPH_PROJECTION",
    state: "NOT_APPLICABLE",
    verificationDigest: sha256DigestCanonical({
      kind: "arobi.familiar-graph-erasure-classification",
      version: 1,
      profileDigest: OPENMIND_CURRENT_GRAPH_PROFILE_DIGEST,
      state: "NOT_APPLICABLE",
      reasonCode: "CURRENT_GRAPH_IS_CODEBASE_ONLY",
    }),
    detail:
      `Current OpenMind graph profile ${OPENMIND_CURRENT_GRAPH_PROFILE.profile} ` +
      `(${OPENMIND_CURRENT_GRAPH_PROFILE_DIGEST}) is repository-source/codebase-only and does not ingest familiar/session/summary payloads; no memory-derived graph projection exists to erase.`,
  };
}

export const currentOpenMindGraphProjectionAdapter = Object.freeze({
  erase: eraseCurrentOpenMindGraphProjection,
});
