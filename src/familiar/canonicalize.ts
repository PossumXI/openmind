import { createHash } from "node:crypto";
import type { Digest } from "./types.js";

export class FamiliarCanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FamiliarCanonicalizationError";
  }
}

function canonicalizeValue(value: unknown, seen: Set<object>, path: string): string {
  if (value === null) return "null";

  const valueType = typeof value;
  if (valueType === "string") return JSON.stringify(value);
  if (valueType === "boolean") return value ? "true" : "false";
  if (valueType === "number") {
    if (!Number.isFinite(value)) {
      throw new FamiliarCanonicalizationError(`${path}: non-finite numbers are not canonicalizable`);
    }
    // JSON uses 0 for -0; make that behavior explicit and deterministic.
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (valueType !== "object") {
    throw new FamiliarCanonicalizationError(`${path}: unsupported value type ${valueType}`);
  }

  const objectValue = value as object;
  if (seen.has(objectValue)) {
    throw new FamiliarCanonicalizationError(`${path}: cyclic value is not canonicalizable`);
  }
  seen.add(objectValue);

  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry, index) => canonicalizeValue(entry, seen, `${path}[${index}]`)).join(",")}]`;
    }

    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new FamiliarCanonicalizationError(`${path}: only plain objects are canonicalizable`);
    }

    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const pairs = keys.map((key) => {
      const canonicalKey = JSON.stringify(key);
      const canonicalValue = canonicalizeValue(record[key], seen, `${path}.${key}`);
      return `${canonicalKey}:${canonicalValue}`;
    });
    return `{${pairs.join(",")}}`;
  } finally {
    seen.delete(objectValue);
  }
}

/**
 * Deterministic JSON-compatible representation used before FMP hashing.
 * Object keys are sorted recursively; array order is significant.
 */
export function canonicalizeFamiliarValue(value: unknown): string {
  return canonicalizeValue(value, new Set<object>(), "$");
}

export function sha256DigestCanonical(value: unknown): Digest {
  const canonical = canonicalizeFamiliarValue(value);
  const hex = createHash("sha256").update(canonical, "utf8").digest("hex");
  return `sha256:${hex}`;
}

/**
 * Domain-separated digest: sha256 over `${domain}\n${canonical JSON}` of the
 * JSON round-tripped value. For JSON-safe values this is byte-identical to
 * Immaculate evidence-lineage `canonicalEffectDigest(domain, value)`, so
 * Immaculate can recompute a Familiar digest with its own code. The domain
 * keeps a digest of one record type from being accepted as another's.
 */
export function sha256DomainDigestCanonical(domain: string, value: unknown): Digest {
  if (typeof domain !== "string" || domain === "" || domain.includes("\n")) {
    throw new FamiliarCanonicalizationError("digest domain must be a non-empty single-line string");
  }
  const normalized: unknown = JSON.parse(JSON.stringify(value));
  const canonical = canonicalizeFamiliarValue(normalized);
  const hex = createHash("sha256").update(`${domain}\n${canonical}`, "utf8").digest("hex");
  return `sha256:${hex}`;
}
