import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalizeFamiliarValue, sha256DigestCanonical } from "../../src/familiar/canonicalize.js";
import {
  AUTHORITY_INFLUENCE_DIGEST_DOMAIN,
  assertFamiliarAuthorityInfluenceV1,
  evaluateFamiliarAuthorityInfluence,
  familiarAuthorityInfluenceV1Digest,
} from "../../src/familiar/authority-influence.js";
import * as familiar from "../../src/familiar/index.js";
import { FamiliarValidationError } from "../../src/familiar/validate.js";

/*
 * recordDigest of the `reject` record below, computed with Immaculate
 * evidence-lineage canonicalEffectDigest("arobi/familiar-authority-influence/v1", body)
 * (apps/harness/src/evidence-lineage.ts, unchanged at Immaculate main 85d3d33).
 */
const GOLDEN_REJECT_RECORD_DIGEST = "sha256:ac829a598b082729a2f865fdd7d6e9f1fcfb9b12be173e0e95db7da70116f139";

function expectFamiliarError(run: () => unknown, code: string, message?: string): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(FamiliarValidationError);
  expect((thrown as FamiliarValidationError).code).toBe(code);
  if (message !== undefined) expect((thrown as Error).message).toContain(message);
}

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

  it("is exported from the Familiar package entry point", () => {
    expect(familiar.evaluateFamiliarAuthorityInfluence).toBe(evaluateFamiliarAuthorityInfluence);
    expect(familiar.assertFamiliarAuthorityInfluenceV1).toBe(assertFamiliarAuthorityInfluenceV1);
    expect(familiar.familiarAuthorityInfluenceV1Digest).toBe(familiarAuthorityInfluenceV1Digest);
  });

  it("mixed trusted and context-only sources behind an authority change fail closed", () => {
    const decision = evaluateFamiliarAuthorityInfluence({
      ...base,
      influenceSources: ["POLICY_DECISION", "MEMORY", "AUTHORITY_RESOLUTION"],
      requestedAuthorityChange: "EXTEND_SCOPE",
    });
    expect(decision.decision).toBe("REJECT");
    expect(decision.reasonCode).toBe("AUTHORITY_FROM_UNTRUSTED_MEMORY");
    expect(decision.authorityChanged).toBe(false);
  });

  it("de-duplicates and sorts sources, and freezes the record and its source list", () => {
    const decision = evaluateFamiliarAuthorityInfluence({
      ...base,
      influenceSources: ["TOOL_OUTPUT", "MEMORY", "TOOL_OUTPUT"],
      requestedAuthorityChange: "NONE",
    });
    expect(decision.influenceSources).toEqual(["MEMORY", "TOOL_OUTPUT"]);
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.influenceSources)).toBe(true);
    expect(() => decision.influenceSources.push("AUTHORITY_RESOLUTION")).toThrow(TypeError);
  });

  it("defaults evaluatedAt to a canonical current timestamp", () => {
    const { evaluatedAt: _omitted, ...withoutTime } = base;
    const decision = evaluateFamiliarAuthorityInfluence({
      ...withoutTime,
      influenceSources: ["MEMORY"],
      requestedAuthorityChange: "NONE",
    });
    expect(new Date(decision.evaluatedAt).toISOString()).toBe(decision.evaluatedAt);
    expect(() => assertFamiliarAuthorityInfluenceV1(decision)).not.toThrow();
  });

  it.each([
    [{ contextUseReceiptDigest: "sha256:not-hex" }, "requires contextUseReceiptDigest"],
    [{ influenceSources: [] }, "recognized influenceSources"],
    [{ influenceSources: ["MEMORY", "ADMIN_ASSERTION"] }, "recognized influenceSources"],
    [{ evaluatedAt: "2026-09-23T00:00:00Z" }, "canonical evaluatedAt"],
    [{ identityEpoch: -1 }, "non-negative identityEpoch"],
    [{ authorityEpoch: 1.5 }, "non-negative authorityEpoch"],
    [{ tenantId: "   " }, "requires tenantId"],
    [{ familiarId: "" }, "requires familiarId"],
    // Before these were TypeErrors from .trim() / new Set(); now the same typed error as every other path.
    [{ tenantId: 7 }, "requires tenantId"],
    [{ influenceSources: 5 }, "recognized influenceSources"],
    [{ evaluatedAt: 0 }, "canonical evaluatedAt"],
  ])("evaluator refuses malformed input %j with FamiliarValidationError", (override, message) => {
    expectFamiliarError(() => evaluateFamiliarAuthorityInfluence({
      ...base,
      influenceSources: ["MEMORY"],
      requestedAuthorityChange: "MINT",
      ...(override as object),
    }), "FMP_INVALID_AUTHORITY_INFLUENCE", message as string);
  });

  it("refuses an unknown authority transition with FamiliarValidationError", () => {
    expectFamiliarError(() => evaluateFamiliarAuthorityInfluence({
      ...base,
      influenceSources: ["AUTHORITY_RESOLUTION"],
      requestedAuthorityChange: "GRANT_ADMIN" as never,
    }), "FMP_INVALID_AUTHORITY_INFLUENCE", "recognized requestedAuthorityChange");
  });
});

describe("assertFamiliarAuthorityInfluenceV1", () => {
  const records = {
    reject: evaluateFamiliarAuthorityInfluence({
      ...base,
      influenceSources: ["MEMORY", "REASONING_HISTORY"],
      requestedAuthorityChange: "MINT",
    }),
    hold: evaluateFamiliarAuthorityInfluence({
      ...base,
      influenceSources: ["AUTHORITY_RESOLUTION"],
      requestedAuthorityChange: "REFRESH_LIFETIME",
    }),
    planning: evaluateFamiliarAuthorityInfluence({
      ...base,
      influenceSources: ["RETRIEVED_TEXT"],
      requestedAuthorityChange: "NONE",
    }),
  };

  /** Rebuilds a record with a correctly recomputed digest, as anyone with the public digest scheme could. */
  function reseal(record: Record<string, unknown>): Record<string, unknown> {
    const { recordDigest: _old, ...body } = record;
    return { ...body, recordDigest: familiarAuthorityInfluenceV1Digest(body as never) };
  }

  /** The reviewer's probe: memory-sourced MINT REJECT rewritten as a trusted-reference HOLD, consistently. */
  function consistentForgery(): Record<string, unknown> {
    return reseal({
      ...records.reject,
      influenceSources: ["AUTHORITY_RESOLUTION"],
      decision: "HOLD_EXTERNAL_AUTHORITY_VERIFICATION",
      reasonCode: "EXTERNAL_AUTHORITY_VERIFICATION_REQUIRED",
    });
  }

  it("recordDigest is the domain-separated digest Immaculate canonicalEffectDigest computes", () => {
    const { recordDigest, ...body } = records.reject;
    expect(recordDigest).toBe(GOLDEN_REJECT_RECORD_DIGEST);
    const independent = `sha256:${createHash("sha256")
      .update(`${AUTHORITY_INFLUENCE_DIGEST_DOMAIN}\n${canonicalizeFamiliarValue(body)}`, "utf8")
      .digest("hex")}`;
    expect(recordDigest).toBe(independent);
    // Not the undomained digest used before, so a record resealed with that is refused.
    expect(recordDigest).not.toBe(sha256DigestCanonical(body));
    expect(() => assertFamiliarAuthorityInfluenceV1({ ...body, recordDigest: sha256DigestCanonical(body) }))
      .toThrow(/FMP_AUTHORITY_INFLUENCE_DIGEST_MISMATCH/);
  });

  it.each(Object.entries(records))("accepts the evaluator's %s record", (_name, record) => {
    expect(() => assertFamiliarAuthorityInfluenceV1(record)).not.toThrow();
    expect(() => assertFamiliarAuthorityInfluenceV1(JSON.parse(JSON.stringify(record)))).not.toThrow();
  });

  it("rejects an edit that was not resealed (a memory source dropped)", () => {
    const tampered = { ...records.reject, influenceSources: ["REASONING_HISTORY"] };
    expect(() => assertFamiliarAuthorityInfluenceV1(tampered)).toThrow(/FMP_AUTHORITY_INFLUENCE_DIGEST_MISMATCH/);
  });

  it("rejects a resealed record that rewrites REJECT into an external-verification HOLD", () => {
    const forged = reseal({
      ...records.reject,
      decision: "HOLD_EXTERNAL_AUTHORITY_VERIFICATION",
      reasonCode: "EXTERNAL_AUTHORITY_VERIFICATION_REQUIRED",
    });
    expect(() => assertFamiliarAuthorityInfluenceV1(forged)).toThrow(/FMP_AUTHORITY_INFLUENCE_DECISION_MISMATCH/);
  });

  it("rejects a resealed record that relabels memory as an authority resolution but keeps REJECT", () => {
    const forged = reseal({ ...records.reject, influenceSources: ["AUTHORITY_RESOLUTION"] });
    expect(() => assertFamiliarAuthorityInfluenceV1(forged)).toThrow(/FMP_AUTHORITY_INFLUENCE_DECISION_MISMATCH/);
  });

  it("is not tamper evidence on its own: a fully consistent reseal passes the structural check", () => {
    const forged = consistentForgery();
    expect(forged.recordDigest).not.toBe(records.reject.recordDigest);
    expect(() => assertFamiliarAuthorityInfluenceV1(forged)).not.toThrow();
  });

  it("detects the consistent reseal against an externally committed recordDigest", () => {
    const committed = records.reject.recordDigest;
    expectFamiliarError(
      () => assertFamiliarAuthorityInfluenceV1(consistentForgery(), { expectedRecordDigest: committed }),
      "FMP_AUTHORITY_INFLUENCE_COMMITMENT_MISMATCH",
    );
    expect(() => assertFamiliarAuthorityInfluenceV1(records.reject, { expectedRecordDigest: committed })).not.toThrow();
    // An un-resealed edit still reports the body mismatch first.
    expectFamiliarError(
      () => assertFamiliarAuthorityInfluenceV1(
        { ...records.reject, influenceSources: ["REASONING_HISTORY"] },
        { expectedRecordDigest: committed },
      ),
      "FMP_AUTHORITY_INFLUENCE_DIGEST_MISMATCH",
    );
  });

  it("refuses a malformed expectedRecordDigest", () => {
    expectFamiliarError(
      () => assertFamiliarAuthorityInfluenceV1(records.reject, { expectedRecordDigest: "sha256:short" as never }),
      "FMP_INVALID_AUTHORITY_INFLUENCE",
      "expectedRecordDigest must be",
    );
  });

  it("rejects a tampered recordDigest", () => {
    expect(() => assertFamiliarAuthorityInfluenceV1({
      ...records.hold,
      recordDigest: sha256DigestCanonical({ forged: true }),
    })).toThrow(/FMP_AUTHORITY_INFLUENCE_DIGEST_MISMATCH/);
    expect(() => assertFamiliarAuthorityInfluenceV1({ ...records.hold, recordDigest: "sha256:short" }))
      .toThrow(/FMP_AUTHORITY_INFLUENCE_DIGEST_MISMATCH/);
  });

  it.each([
    ["null", null, "record must be an object"],
    ["array", [], "record must be an object"],
    ["extra field", reseal({ ...records.hold, authorityGranted: true }), "missing or unexpected fields"],
    ["missing field", (() => {
      const { reasonCode: _drop, ...rest } = records.hold;
      return rest;
    })(), "missing or unexpected fields"],
    ["schema", reseal({ ...records.hold, schemaVersion: "arobi.familiar-authority-influence.v2" }), "schemaVersion must equal"],
    ["tenantId", reseal({ ...records.hold, tenantId: " tenant-a" }), "tenantId must be a non-empty trimmed string"],
    ["familiarId", reseal({ ...records.hold, familiarId: 7 }), "familiarId must be a non-empty trimmed string"],
    ["identityEpoch", reseal({ ...records.hold, identityEpoch: -1 }), "identityEpoch must be a non-negative safe integer"],
    ["authorityEpoch", reseal({ ...records.hold, authorityEpoch: "11" }), "authorityEpoch must be a non-negative safe integer"],
    ["receipt digest", reseal({ ...records.hold, contextUseReceiptDigest: "sha256:XYZ" }), "contextUseReceiptDigest must be"],
    ["empty sources", reseal({ ...records.hold, influenceSources: [] }), "influenceSources must be recognized"],
    ["unknown source", reseal({ ...records.hold, influenceSources: ["ADMIN_ASSERTION"] }), "influenceSources must be recognized"],
    ["unsorted sources", reseal({ ...records.hold, influenceSources: ["POLICY_DECISION", "AUTHORITY_RESOLUTION"] }), "unique and sorted"],
    ["duplicate sources", reseal({ ...records.hold, influenceSources: ["AUTHORITY_RESOLUTION", "AUTHORITY_RESOLUTION"] }), "unique and sorted"],
    ["non-array sources", reseal({ ...records.hold, influenceSources: "AUTHORITY_RESOLUTION" }), "influenceSources must be recognized"],
    ["change", reseal({ ...records.hold, requestedAuthorityChange: "GRANT_ADMIN" }), "requestedAuthorityChange must be recognized"],
    ["authorityChanged", reseal({ ...records.hold, authorityChanged: true }), "authorityChanged must be false"],
    ["evaluatedAt", reseal({ ...records.hold, evaluatedAt: "2026-09-23" }), "evaluatedAt must be a canonical"],
    ["evaluatedAt type", reseal({ ...records.hold, evaluatedAt: 0 }), "evaluatedAt must be a canonical"],
  ])("rejects a malformed record (%s)", (_name, value, message) => {
    expect(() => assertFamiliarAuthorityInfluenceV1(value)).toThrow(message as string);
  });
});
