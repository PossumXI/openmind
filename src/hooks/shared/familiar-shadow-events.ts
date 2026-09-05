/**
 * Always-on local telemetry for the opt-in Familiar Memory recall shadow path.
 *
 * The sink is intentionally separate from legacy proactive-recall telemetry so
 * shadow observations cannot change legacy funnel semantics. The event contains
 * only state/reason/counts/evidence digests; decrypted familiar payload text,
 * prompts, tenant ids, familiar ids and keys are never written here.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { FamiliarRecallShadowResult } from "../../familiar/shadow-recall.js";

export interface FamiliarShadowRecallEvent {
  state: Exclude<FamiliarRecallShadowResult["state"], "DISABLED"> | "TIMEOUT";
  reasonCode?: string;
  retrievedCount?: number;
  openedCount?: number;
  unavailableCount?: number;
  inconclusiveCount?: number;
  retrievedDigests?: string[];
  openedDigests?: string[];
  observationDigest?: string;
  session?: string;
  gate?: string;
}

function eventsPath(): string {
  return join(homedir(), ".deeplake", "fmp-shadow-recall-events.jsonl");
}

export function recordFamiliarShadowRecallEvent(
  event: FamiliarShadowRecallEvent,
  nowIso: string = new Date().toISOString(),
): void {
  try {
    const path = eventsPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify({ ts: nowIso, ...event }) + "\n");
  } catch {
    // Shadow telemetry must never break or delay legacy recall behavior.
  }
}

export function shadowResultEvent(
  result: Exclude<FamiliarRecallShadowResult, { state: "DISABLED" }>,
  context: { session?: string; gate?: string } = {},
): FamiliarShadowRecallEvent {
  if (result.state === "UNAVAILABLE") {
    return {
      state: result.state,
      reasonCode: result.reasonCode,
      observationDigest: result.observationDigest,
      ...context,
    };
  }
  return {
    state: result.state,
    ...(result.state === "INCONCLUSIVE" ? { reasonCode: result.reasonCode } : {}),
    retrievedCount: result.retrievedCount,
    openedCount: result.openedCount,
    ...(result.state === "INCONCLUSIVE"
      ? {
          unavailableCount: result.unavailableCount,
          inconclusiveCount: result.inconclusiveCount,
        }
      : {}),
    retrievedDigests: [...result.retrievedDigests],
    openedDigests: [...result.openedDigests],
    observationDigest: result.observationDigest,
    ...context,
  };
}
