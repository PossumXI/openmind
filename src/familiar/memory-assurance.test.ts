import { describe, expect, it } from "vitest";
import {
  buildMemoryInfluenceReceipt,
  buildMemoryWriteAttestation,
  computeMemoryContextRoot,
  verifyMemoryInfluenceReceipt,
  verifyMemoryWriteAttestation,
} from "./memory-assurance.js";
import type { Digest } from "./types.js";

const digest = (ch: string): Digest => `sha256:${ch.repeat(64).slice(0, 64)}` as Digest;

const BASE_INFLUENCE = {
  retrievalId: "retrieval-1",
  retrievedMemoryRoot: digest("a"),
  acceptedMemoryRoot: digest("b"),
  rejectedMemoryRoot: digest("c"),
  authorityEpoch: 7,
  retrievalPolicyDigest: digest("d"),
  contextUseReceiptDigest: digest("e"),
  perturbationChallengeDigest: digest("f"),
  deniedIntentFingerprintDigest: digest("1"),
  influenceVerdict: "BOUNDED" as const,
  verifierDigest: digest("2"),
  createdAt: "2026-09-09T20:00:00.000Z",
};

describe("FMP VEP 1.2 memory assurance", () => {
  it("builds a signed digest-only MemoryWriteAttestation and verifies the signer independently", async () => {
    const attestation = await buildMemoryWriteAttestation({
      memoryId: "memory-1",
      memoryDigest: digest("3"),
      sourceOriginDigest: digest("4"),
      authorPrincipal: "principal:operator",
      authorityEpoch: 7,
      contextBoundaryReceiptDigest: digest("5"),
      sanitizerReceiptDigest: digest("6"),
      createdAt: "2026-09-09T20:00:00.000Z",
      validUntil: "2026-09-10T20:00:00.000Z",
      signer: "key:fmp-write-1",
    }, ({ digest: signedDigest, signer }) => `sig:${signer}:${signedDigest}`);

    const verified = await verifyMemoryWriteAttestation(attestation, {
      expectedAuthorityEpoch: 7,
      now: new Date("2026-09-09T21:00:00.000Z"),
      verifySignature: ({ digest: signedDigest, signer, signature }) => signature === `sig:${signer}:${signedDigest}`,
    });
    expect(verified.valid).toBe(true);
    expect(JSON.stringify(attestation)).not.toContain("prompt");
    expect(JSON.stringify(attestation)).not.toContain("content");
  });

  it("MEMORY-CROSS-EPOCH-01: prior authority epoch cannot influence consequential execution", () => {
    const receipt = buildMemoryInfluenceReceipt(BASE_INFLUENCE);
    const verification = verifyMemoryInfluenceReceipt(receipt, {
      currentAuthorityEpoch: 8,
      requireBounded: true,
      expectedRetrievalPolicyDigest: BASE_INFLUENCE.retrievalPolicyDigest,
    });
    expect(verification.valid).toBe(false);
    expect(verification.reasons.join(" ")).toMatch(/different authority epoch/i);
  });

  it("MEMORY-SLEEPER-01: unbounded delayed influence fails the consequential gate", () => {
    const receipt = buildMemoryInfluenceReceipt({
      ...BASE_INFLUENCE,
      influenceVerdict: "UNBOUNDED",
    });
    const verification = verifyMemoryInfluenceReceipt(receipt, {
      currentAuthorityEpoch: 7,
      requireBounded: true,
    });
    expect(verification.valid).toBe(false);
    expect(verification.reasons.join(" ")).toMatch(/must be BOUNDED/i);
  });

  it("MEMORY-MORPH-02: denied-intent correlation digest survives retrieval reformulation", () => {
    const first = buildMemoryInfluenceReceipt(BASE_INFLUENCE);
    const rephrased = buildMemoryInfluenceReceipt({
      ...BASE_INFLUENCE,
      retrievalId: "retrieval-rephrased-across-tool-boundary",
      retrievedMemoryRoot: digest("7"),
      acceptedMemoryRoot: digest("8"),
    });
    expect(rephrased.deniedIntentFingerprintDigest).toBe(first.deniedIntentFingerprintDigest);
    expect(rephrased.receiptDigest).not.toBe(first.receiptDigest);
  });

  it("memory context root is policy/epoch/context-bound and carries no authority bit", () => {
    const receipt = buildMemoryInfluenceReceipt(BASE_INFLUENCE);
    const root = computeMemoryContextRoot({
      contextUseReceiptDigest: receipt.contextUseReceiptDigest,
      memoryInfluenceReceiptDigest: receipt.receiptDigest,
      acceptedMemoryRoot: receipt.acceptedMemoryRoot,
      authorityEpoch: receipt.authorityEpoch,
      retrievalPolicyDigest: receipt.retrievalPolicyDigest,
    });
    const differentEpoch = computeMemoryContextRoot({
      contextUseReceiptDigest: receipt.contextUseReceiptDigest,
      memoryInfluenceReceiptDigest: receipt.receiptDigest,
      acceptedMemoryRoot: receipt.acceptedMemoryRoot,
      authorityEpoch: receipt.authorityEpoch + 1,
      retrievalPolicyDigest: receipt.retrievalPolicyDigest,
    });
    expect(root).not.toBe(differentEpoch);
  });

  it("tampered memory-write provenance cannot retain a valid signature", async () => {
    const attestation = await buildMemoryWriteAttestation({
      memoryId: "memory-2",
      memoryDigest: digest("9"),
      sourceOriginDigest: digest("a"),
      authorPrincipal: "principal:writer",
      authorityEpoch: 7,
      contextBoundaryReceiptDigest: digest("b"),
      sanitizerReceiptDigest: digest("c"),
      createdAt: "2026-09-09T20:00:00.000Z",
      signer: "key:fmp-write-2",
    }, ({ digest: signedDigest }) => `signature:${signedDigest}`);
    const tampered = { ...attestation, memoryDigest: digest("d") };
    const verification = await verifyMemoryWriteAttestation(tampered, {
      expectedAuthorityEpoch: 7,
      verifySignature: ({ digest: signedDigest, signature }) => signature === `signature:${signedDigest}`,
    });
    expect(verification.valid).toBe(false);
    expect(verification.reasons.join(" ")).toMatch(/attestationDigest|signature/i);
  });
});
