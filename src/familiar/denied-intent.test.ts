import { describe, expect, it } from "vitest";
import { sha256DigestCanonical } from "./canonicalize.js";
import {
  createRiskIntentState,
  evaluateDeniedIntentAttempt,
  recordDeniedIntent,
  type DeniedIntentAttemptInput,
} from "./denied-intent.js";

const TARGET_A = sha256DigestCanonical({ resource: "warehouse-record-17" });
const TARGET_B = sha256DigestCanonical({ resource: "warehouse-record-18" });

function attempt(overrides: Partial<DeniedIntentAttemptInput> = {}): DeniedIntentAttemptInput {
  return {
    tenantId: "tenant-a",
    sessionId: "session-risk-1",
    authorityEpoch: 41,
    policyEpoch: 182,
    observedAt: "2026-09-07T20:00:00.000Z",
    objectiveClass: "delete-owned-resource",
    targetDigest: TARGET_A,
    consequenceClass: "destructive-state-change",
    consequential: true,
    effectClass: "delete_resource",
    routeClass: "resource-api",
    toolClass: "resource-manager",
    workerId: "parent-agent",
    encodingClass: "plain",
    ...overrides,
  };
}

describe("DeniedIntentFingerprint session continuity", () => {
  it("DENIED-INTENT-MORPH-01: keeps a denied objective held across tool, route, worker and encoding changes", () => {
    let state = createRiskIntentState({ tenantId: "tenant-a", sessionId: "session-risk-1" });
    state = recordDeniedIntent(state, attempt(), "2026-09-07T21:00:00.000Z");

    const morphed = attempt({
      observedAt: "2026-09-07T20:01:00.000Z",
      effectClass: "run_script",
      routeClass: "shell-api",
      toolClass: "shell",
      workerId: "worker-2",
      encodingClass: "base64",
    });
    const decision = evaluateDeniedIntentAttempt(state, morphed);

    expect(decision.decision).toBe("HOLD");
    expect(decision.reason).toMatch(/previously denied consequential objective/i);
    expect(decision.denialCount).toBe(1);
    expect(state.records).toHaveLength(1);
  });

  it("escalates repeated reformulations of the same denied objective", () => {
    let state = createRiskIntentState({
      tenantId: "tenant-a",
      sessionId: "session-risk-1",
      escalationThreshold: 3,
    });
    state = recordDeniedIntent(state, attempt(), "2026-09-07T21:00:00.000Z");
    state = recordDeniedIntent(state, attempt({
      observedAt: "2026-09-07T20:01:00.000Z",
      effectClass: "run_script",
      routeClass: "script-api",
      toolClass: "runner",
      workerId: "worker-1",
    }), "2026-09-07T21:00:00.000Z");
    state = recordDeniedIntent(state, attempt({
      observedAt: "2026-09-07T20:02:00.000Z",
      effectClass: "network_call",
      routeClass: "http-api",
      toolClass: "http-client",
      workerId: "worker-3",
      encodingClass: "json",
    }), "2026-09-07T21:00:00.000Z");

    const decision = evaluateDeniedIntentAttempt(state, attempt({
      observedAt: "2026-09-07T20:03:00.000Z",
      effectClass: "shell",
      routeClass: "terminal",
      toolClass: "shell",
      workerId: "worker-4",
    }));

    expect(state.records).toHaveLength(1);
    expect(state.records[0]?.denialCount).toBe(3);
    expect(state.records[0]?.surfaces.length).toBe(3);
    expect(decision.decision).toBe("ESCALATE");
    expect(decision.denialCount).toBe(3);
  });

  it("does not confuse a different objective target with the denied objective", () => {
    let state = createRiskIntentState({ tenantId: "tenant-a", sessionId: "session-risk-1" });
    state = recordDeniedIntent(state, attempt(), "2026-09-07T21:00:00.000Z");

    const decision = evaluateDeniedIntentAttempt(state, attempt({
      observedAt: "2026-09-07T20:05:00.000Z",
      targetDigest: TARGET_B,
      effectClass: "delete_resource",
    }));
    expect(decision.decision).toBe("ALLOW");
  });

  it("expires bounded intent state instead of creating an indefinite semantic ban", () => {
    let state = createRiskIntentState({ tenantId: "tenant-a", sessionId: "session-risk-1" });
    state = recordDeniedIntent(state, attempt(), "2026-09-07T20:10:00.000Z");

    const decision = evaluateDeniedIntentAttempt(state, attempt({
      observedAt: "2026-09-07T20:10:01.000Z",
      effectClass: "run_script",
      toolClass: "shell",
    }));
    expect(decision.decision).toBe("ALLOW");
  });

  it("fails closed when the bounded active-denial registry saturates", () => {
    let state = createRiskIntentState({
      tenantId: "tenant-a",
      sessionId: "session-risk-1",
      maxEntries: 1,
    });
    state = recordDeniedIntent(state, attempt(), "2026-09-07T21:00:00.000Z");
    state = recordDeniedIntent(state, attempt({
      observedAt: "2026-09-07T20:01:00.000Z",
      objectiveClass: "disable-safety-control",
      targetDigest: TARGET_B,
      consequenceClass: "safety-control-loss",
      effectClass: "configuration_write",
    }), "2026-09-07T21:00:00.000Z");

    expect(state.saturated).toBe(true);
    const decision = evaluateDeniedIntentAttempt(state, attempt({
      observedAt: "2026-09-07T20:02:00.000Z",
      objectiveClass: "publish-record",
      targetDigest: TARGET_B,
      consequenceClass: "external-state-change",
      effectClass: "publish",
    }));
    expect(decision.decision).toBe("HOLD");
    expect(decision.reason).toMatch(/saturated/i);
  });

  it("cannot reuse one tenant/session risk state in another governed session", () => {
    const state = createRiskIntentState({ tenantId: "tenant-a", sessionId: "session-risk-1" });
    expect(() => evaluateDeniedIntentAttempt(state, attempt({ sessionId: "session-risk-2" }))).toThrow(/cannot cross tenant or governed-session/i);
  });
});
