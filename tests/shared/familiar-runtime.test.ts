import { describe, expect, it } from "vitest";
import { resolveFamiliarCaptureRuntime } from "../../src/familiar/index.js";

const config = {
  orgId: "tenant-a",
  tableName: "memory",
};

describe("FMP capture runtime scope", () => {
  it("is disabled by default without requiring familiar identity configuration", () => {
    expect(resolveFamiliarCaptureRuntime(config, {})).toEqual({ enabled: false });
  });

  it("derives tenant from trusted OpenMind config and requires explicit familiar identity/epoch", () => {
    expect(
      resolveFamiliarCaptureRuntime(config, {
        AROBI_FMP_CAPTURE: "true",
        AROBI_FMP_FAMILIAR_ID: "familiar-xena",
        AROBI_FMP_IDENTITY_EPOCH: "7",
      }),
    ).toEqual({
      enabled: true,
      tenantId: "tenant-a",
      familiarId: "familiar-xena",
      identityEpoch: 7,
      tablePrefix: "memory",
    });
  });

  it("does not accept a caller/event supplied tenant override because no such input exists", () => {
    const runtime = resolveFamiliarCaptureRuntime(
      { orgId: "tenant-authoritative", tableName: "memory" },
      {
        AROBI_FMP_CAPTURE: "1",
        AROBI_FMP_FAMILIAR_ID: "familiar-1",
        AROBI_FMP_IDENTITY_EPOCH: "0",
        // Deliberately irrelevant. The resolver has no tenant env override.
        AROBI_FMP_TENANT_ID: "tenant-attacker",
      },
    );

    expect(runtime.enabled).toBe(true);
    if (!runtime.enabled) throw new Error("expected enabled runtime");
    expect(runtime.tenantId).toBe("tenant-authoritative");
  });

  it("fails closed when enabled without a familiar id", () => {
    expect(() =>
      resolveFamiliarCaptureRuntime(config, {
        AROBI_FMP_CAPTURE: "true",
        AROBI_FMP_IDENTITY_EPOCH: "1",
      }),
    ).toThrow(/AROBI_FMP_FAMILIAR_ID/);
  });

  it("fails closed when enabled without or with malformed identity epoch", () => {
    expect(() =>
      resolveFamiliarCaptureRuntime(config, {
        AROBI_FMP_CAPTURE: "true",
        AROBI_FMP_FAMILIAR_ID: "familiar-1",
      }),
    ).toThrow(/AROBI_FMP_IDENTITY_EPOCH/);

    expect(() =>
      resolveFamiliarCaptureRuntime(config, {
        AROBI_FMP_CAPTURE: "true",
        AROBI_FMP_FAMILIAR_ID: "familiar-1",
        AROBI_FMP_IDENTITY_EPOCH: "1.5",
      }),
    ).toThrow(/non-negative integer/);
  });

  it("supports an explicit canonical table prefix without changing tenant identity", () => {
    const runtime = resolveFamiliarCaptureRuntime(config, {
      AROBI_FMP_CAPTURE: "on",
      AROBI_FMP_FAMILIAR_ID: "familiar-1",
      AROBI_FMP_IDENTITY_EPOCH: "2",
      AROBI_FMP_TABLE_PREFIX: "arobi_memory",
    });

    expect(runtime.enabled).toBe(true);
    if (!runtime.enabled) throw new Error("expected enabled runtime");
    expect(runtime.tablePrefix).toBe("arobi_memory");
    expect(runtime.tenantId).toBe("tenant-a");
  });
});
