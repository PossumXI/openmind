import {
  assertFamiliarContinuityAttestationV1,
  assertFamiliarMemoryArtifactV1,
  assertMemoryTombstoneReceiptV1,
} from "./validate.js";
import type {
  Digest,
  FamiliarContinuityAttestationV1,
  FamiliarMemoryArtifactV1,
  MemoryTombstoneReceiptV1,
} from "./types.js";

export type FamiliarConsoleContinuityState =
  | "VERIFIED"
  | "REVIEW_REQUIRED"
  | "HELD"
  | "INCONCLUSIVE"
  | "UNAVAILABLE";

export interface FamiliarMemoryConsoleItemV1 {
  memoryId: string;
  memoryClass: string;
  supportState: FamiliarMemoryArtifactV1["supportState"];
  trustClass: FamiliarMemoryArtifactV1["trustClass"];
  contentPreview?: string;
  contentDigest: Digest;
  originLabelDigest: Digest;
  sourceDigests: Digest[];
  mutationCount: number;
  influencedContextReceiptDigests: Digest[];
  createdAt: string;
}

export interface FamiliarMemoryConsoleSnapshotV1 {
  kind: "arobi.familiar-memory-console";
  version: 1;
  tenantId: string;
  familiarId: string;
  familiarLabel?: string;
  identityEpoch: number;
  continuityState: FamiliarConsoleContinuityState;
  continuityDigest?: Digest;
  memoryRoot?: Digest;
  coreMemoryRoot?: Digest;
  currentModel?: string;
  currentRuntime?: string;
  lastAttestedAt?: string;
  memories: FamiliarMemoryConsoleItemV1[];
  forgetting?: {
    lastTombstoneDigest?: Digest;
    surfaces: Array<{
      surface: string;
      state: "VERIFIED" | "FAILED" | "NOT_APPLICABLE" | "OUTSIDE_CONTROL";
    }>;
  };
}

export interface FamiliarMemoryConsoleBuildInput {
  tenantId: string;
  familiarId: string;
  familiarLabel?: string;
  /**
   * Supplied by verifier/policy. The builder never upgrades continuity to
   * VERIFIED merely because an attestation exists.
   */
  continuityState: FamiliarConsoleContinuityState;
  continuity?: unknown;
  memories: readonly unknown[];
  mutationCountByMemoryId?: Readonly<Record<string, number>>;
  influenceReceiptsByMemoryId?: Readonly<Record<string, readonly Digest[]>>;
  previewByMemoryId?: Readonly<Record<string, string>>;
  latestTombstone?: unknown;
  currentModel?: string;
  currentRuntime?: string;
}

function ensureScope(
  tenantId: string,
  familiarId: string,
  artifact: { tenantId: string; familiarId: string },
  label: string,
): void {
  if (artifact.tenantId !== tenantId || artifact.familiarId !== familiarId) {
    throw new Error(`${label} scope does not match requested familiar`);
  }
}

export function buildFamiliarMemoryConsoleSnapshot(
  input: FamiliarMemoryConsoleBuildInput,
): FamiliarMemoryConsoleSnapshotV1 {
  if (!input.tenantId.trim() || !input.familiarId.trim()) {
    throw new Error("FMP console snapshot requires non-empty tenantId and familiarId");
  }

  let continuity: FamiliarContinuityAttestationV1 | undefined;
  if (input.continuity !== undefined) {
    assertFamiliarContinuityAttestationV1(input.continuity);
    ensureScope(input.tenantId, input.familiarId, input.continuity, "continuity attestation");
    continuity = input.continuity;
  }

  const memories: FamiliarMemoryArtifactV1[] = input.memories.map((value, index) => {
    assertFamiliarMemoryArtifactV1(value);
    ensureScope(input.tenantId, input.familiarId, value, `memory[${index}]`);
    return value;
  });

  let tombstone: MemoryTombstoneReceiptV1 | undefined;
  if (input.latestTombstone !== undefined) {
    assertMemoryTombstoneReceiptV1(input.latestTombstone);
    ensureScope(input.tenantId, input.familiarId, input.latestTombstone, "tombstone");
    tombstone = input.latestTombstone;
  }

  const snapshot: FamiliarMemoryConsoleSnapshotV1 = {
    kind: "arobi.familiar-memory-console",
    version: 1,
    tenantId: input.tenantId,
    familiarId: input.familiarId,
    ...(input.familiarLabel?.trim() ? { familiarLabel: input.familiarLabel.trim() } : {}),
    identityEpoch: continuity?.identityEpoch ?? Math.max(0, ...memories.map((m) => m.identityEpoch)),
    continuityState: input.continuityState,
    ...(continuity
      ? {
          continuityDigest: undefined,
          memoryRoot: continuity.memoryRoot,
          coreMemoryRoot: continuity.coreMemoryRoot,
          lastAttestedAt: continuity.createdAt,
        }
      : {}),
    ...(input.currentModel?.trim() ? { currentModel: input.currentModel.trim() } : {}),
    ...(input.currentRuntime?.trim() ? { currentRuntime: input.currentRuntime.trim() } : {}),
    memories: memories.map((memory) => ({
      memoryId: memory.memoryId,
      memoryClass: memory.memoryClass,
      supportState: memory.supportState,
      trustClass: memory.trustClass,
      ...(input.previewByMemoryId?.[memory.memoryId]
        ? { contentPreview: input.previewByMemoryId[memory.memoryId] }
        : {}),
      contentDigest: memory.contentDigest,
      originLabelDigest: memory.originLabelDigest,
      sourceDigests: [...memory.sourceArtifacts],
      mutationCount: input.mutationCountByMemoryId?.[memory.memoryId] ?? 0,
      influencedContextReceiptDigests: [
        ...(input.influenceReceiptsByMemoryId?.[memory.memoryId] ?? []),
      ],
      createdAt: memory.createdAt,
    })),
    ...(tombstone
      ? {
          forgetting: {
            lastTombstoneDigest: undefined,
            surfaces: tombstone.surfaces.map((surface) => ({
              surface: surface.surface,
              state: surface.state,
            })),
          },
        }
      : {}),
  };

  return snapshot;
}
