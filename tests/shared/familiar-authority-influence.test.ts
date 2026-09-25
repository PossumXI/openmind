import { describe, expect, it } from "vitest";
import { sha256DigestCanonical } from "../../src/familiar/canonicalize.js";
import { evaluateFamiliarAuthorityInfluence } from "../../src/familiar/authority-influence.js";

const base = {
  tenantId: "tenant-a",
  familiarId: "familiar-1",
  identityEpoch: 7,
  authorityEpoch: 11,
  contextUseReceiptDigest: sha256DigestCanonical({ receipt: 1 }),
  evaluatedAt: "2026-09-23T00:00:00.000Z",
};

describe("Familiar authority influence invariant", () => {
  it("reasoning memory cannot launder an admin assertion into authority", () => {
    const decision = evaluateFamiliarAuthorityInfluence({
      ...base,
      influenceSources: ["MEMORY", "REASONING_HISTORY"],
      requestedAuthorityChange: "MINT",
    });
    expect(decision.decision).toBe("REJECT");
    expect(decision.reasonCode).toBe("AUTHORITY_FROM_UNTRUSTED_MEMORY");
    expect(decision.authorityChanged).toBe(false);
  });

  it.each(["EXTEND_SCOPE", "INCREASE_BUDGET", "REFRESH_LIFETIME"] as const)(
    "%s cannot be produced from model or tool context",
    (requestedAuthorityChange) => {
      const decision = evaluateFamiliarAuthorityInfluence({
        ...base,
        influenceSources: ["MODEL_OUTPUT", "TOOL_OUTPUT"],
        requestedAuthorityChange,
      });
      expect(decision.decision).toBe("REJECT");
      expect(decision.authorityChanged).toBe(false);
    },
  );

  it("allows memory to inform planning without producing authority", () => {
    const decision = evaluateFamiliarAuthorityInfluence({
      ...base,
      influenceSources: ["RETRIEVED_TEXT", "MEMORY"],
      requestedAuthorityChange: "NONE",
    });
    expect(decision.decision).toBe("ALLOW_PLANNING_ONLY");
    expect(decision.authorityChanged).toBe(false);
  });

  it("still delegates trusted authority changes to the external PEP", () => {
    const decision = evaluateFamiliarAuthorityInfluence({
      ...base,
      influenceSources: ["AUTHORITY_RESOLUTION", "POLICY_DECISION"],
      requestedAuthorityChange: "REFRESH_LIFETIME",
    });
    expect(decision.decision).toBe("HOLD_EXTERNAL_AUTHORITY_VERIFICATION");
    expect(decision.reasonCode).toBe("EXTERNAL_AUTHORITY_VERIFICATION_REQUIRED");
    expect(decision.authorityChanged).toBe(false);
  });

  it("rejects an unknown authority transition at the runtime boundary", () => {
    expect(() => evaluateFamiliarAuthorityInfluence({
      ...base,
      influenceSources: ["AUTHORITY_RESOLUTION"],
      requestedAuthorityChange: "GRANT_ADMIN" as never,
    })).toThrow("recognized requestedAuthorityChange");
  });
});
