import {
  FAMILIAR_MEMORY_CLASSES,
  FAMILIAR_SCOPE_BINDING_KINDS,
  MEMORY_MUTATION_OPERATIONS,
  MEMORY_SUPPORT_STATES,
  MEMORY_TRUST_CLASSES,
  type ContextUseReceiptV1,
  type Digest,
  type FamiliarCapsuleV1,
  type FamiliarContinuityAttestationV1,
  type FamiliarManifestV1,
  type FamiliarMemoryArtifactV1,
  type MemoryMutationReceiptV1,
  type MemoryTombstoneReceiptV1,
} from "./types.js";

export class FamiliarValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "FamiliarValidationError";
    this.code = code;
  }
}

type RecordValue = Record<string, unknown>;

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function fail(code: string, message: string): never {
  throw new FamiliarValidationError(code, message);
}

function asRecord(value: unknown, label: string): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("FMP_INVALID_OBJECT", `${label} must be an object`);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    fail("FMP_INVALID_OBJECT", `${label} must be a plain object`);
  }
  return value as RecordValue;
}

function assertLiteral(record: RecordValue, key: string, expected: unknown): void {
  if (record[key] !== expected) {
    fail("FMP_INVALID_LITERAL", `${key} must equal ${JSON.stringify(expected)}`);
  }
}

function nonEmptyString(record: RecordValue, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") {
    fail("FMP_INVALID_STRING", `${key} must be a non-empty string`);
  }
  return value;
}

function nonNegativeInteger(record: RecordValue, key: string): number {
  const value = record[key];
  if (!Number.isInteger(value) || (value as number) < 0) {
    fail("FMP_INVALID_INTEGER", `${key} must be a non-negative integer`);
  }
  return value as number;
}

function positiveInteger(record: RecordValue, key: string): number {
  const value = record[key];
  if (!Number.isInteger(value) || (value as number) < 1) {
    fail("FMP_INVALID_INTEGER", `${key} must be a positive integer`);
  }
  return value as number;
}

export function isDigest(value: unknown): value is Digest {
  return typeof value === "string" && DIGEST_RE.test(value);
}

function digest(record: RecordValue, key: string): Digest {
  const value = record[key];
  if (!isDigest(value)) fail("FMP_INVALID_DIGEST", `${key} must be sha256:<64 lowercase hex>`);
  return value;
}

function optionalDigest(record: RecordValue, key: string): Digest | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!isDigest(value)) fail("FMP_INVALID_DIGEST", `${key} must be sha256:<64 lowercase hex>`);
  return value;
}

function digestArray(record: RecordValue, key: string): Digest[] {
  const value = record[key];
  if (!Array.isArray(value)) fail("FMP_INVALID_ARRAY", `${key} must be an array`);
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (!isDigest(entry)) fail("FMP_INVALID_DIGEST", `${key}[${index}] must be sha256:<64 lowercase hex>`);
    if (seen.has(entry)) fail("FMP_DUPLICATE_DIGEST", `${key} must not contain duplicate digests`);
    seen.add(entry);
    return entry;
  });
}

function isoUtc(record: RecordValue, key: string): string {
  const value = nonEmptyString(record, key);
  if (!ISO_UTC_RE.test(value) || Number.isNaN(Date.parse(value))) {
    fail("FMP_INVALID_TIMESTAMP", `${key} must be an ISO-8601 UTC timestamp`);
  }
  return value;
}

function optionalIsoUtc(record: RecordValue, key: string): string | undefined {
  if (record[key] === undefined) return undefined;
  return isoUtc(record, key);
}

function enumValue<T extends readonly string[]>(record: RecordValue, key: string, values: T): T[number] {
  const value = record[key];
  if (typeof value !== "string" || !values.includes(value)) {
    fail("FMP_INVALID_ENUM", `${key} has unsupported value ${String(value)}`);
  }
  return value as T[number];
}

function booleanValue(record: RecordValue, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") fail("FMP_INVALID_BOOLEAN", `${key} must be boolean`);
  return value;
}

function validateScope(record: RecordValue): void {
  nonEmptyString(record, "tenantId");
  nonEmptyString(record, "familiarId");
  nonNegativeInteger(record, "identityEpoch");
}

const MAX_SCOPE_BINDINGS = FAMILIAR_SCOPE_BINDING_KINDS.length;
const MAX_SCOPE_DEPENDENCIES = 64;
const MAX_SCOPE_TEXT = 256;

function boundedText(record: RecordValue, key: string, label: string): string {
  const value = nonEmptyString(record, key);
  if (value.length > MAX_SCOPE_TEXT) fail("FMP_INVALID_SCOPE", `${label} must be at most ${MAX_SCOPE_TEXT} characters`);
  return value;
}

const MAX_LINKED_MEMORIES = 32;
const EPISODE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** FMP v1.3: the links a memory recorded. Related digests are unique and bounded; an episode is an id, not text. */
export function assertFamiliarMemoryLinksV1(value: unknown): void {
  const links = asRecord(value, "links");
  for (const key of Object.keys(links)) {
    if (key !== "related" && key !== "episode") fail("FMP_INVALID_LINKS", `links.${key} is not a link this version records`);
  }
  if (links.related === undefined && links.episode === undefined) {
    fail("FMP_INVALID_LINKS", "links must relate a memory or name an episode; omit it for an unlinked memory");
  }
  if (links.related !== undefined) {
    if (!Array.isArray(links.related) || links.related.length === 0 || links.related.length > MAX_LINKED_MEMORIES) {
      fail("FMP_INVALID_LINKS", `links.related must be a non-empty array of at most ${MAX_LINKED_MEMORIES} digests`);
    }
    if (links.related.some((entry) => !isDigest(entry))) fail("FMP_INVALID_LINKS", "links.related must hold artifact digests");
    if (new Set(links.related).size !== links.related.length) fail("FMP_INVALID_LINKS", "links.related names a memory more than once");
  }
  if (links.episode !== undefined && (typeof links.episode !== "string" || !EPISODE_ID.test(links.episode))) {
    fail("FMP_INVALID_LINKS", "links.episode must be an id of 1 to 128 letters, digits, dots, underscores, colons or hyphens");
  }
}

/** FMP v1.2: a memory's environmental scope, when it has one. One binding per kind; dependency names unique. */
export function assertFamiliarMemoryScopeV1(value: unknown): void {
  const scope = asRecord(value, "scope");
  const bindings = scope.bindings;
  if (!Array.isArray(bindings) || bindings.length > MAX_SCOPE_BINDINGS) {
    fail("FMP_INVALID_SCOPE", `scope.bindings must be an array of at most ${MAX_SCOPE_BINDINGS}`);
  }
  const kinds = new Set<string>();
  bindings.forEach((entry, index) => {
    const binding = asRecord(entry, `scope.bindings[${index}]`);
    const kind = enumValue(binding, "kind", FAMILIAR_SCOPE_BINDING_KINDS);
    if (kinds.has(kind)) fail("FMP_INVALID_SCOPE", `scope.bindings has more than one ${kind} binding`);
    kinds.add(kind);
    boundedText(binding, "id", `scope.bindings[${index}].id`);
  });
  const dependencies = scope.dependencies;
  if (!Array.isArray(dependencies) || dependencies.length > MAX_SCOPE_DEPENDENCIES) {
    fail("FMP_INVALID_SCOPE", `scope.dependencies must be an array of at most ${MAX_SCOPE_DEPENDENCIES}`);
  }
  const names = new Set<string>();
  dependencies.forEach((entry, index) => {
    const dependency = asRecord(entry, `scope.dependencies[${index}]`);
    const name = boundedText(dependency, "name", `scope.dependencies[${index}].name`);
    if (names.has(name)) fail("FMP_INVALID_SCOPE", `scope.dependencies names ${name} more than once`);
    names.add(name);
    digest(dependency, "digest");
  });
  if (bindings.length === 0 && dependencies.length === 0) {
    fail("FMP_INVALID_SCOPE", "a scope must bind an environment or name a dependency; omit it for unscoped memory");
  }
  isoUtc(scope, "observedAt");
}

function validateReceiptSubset(receipt: ContextUseReceiptV1): void {
  const retrieved = new Set(receipt.retrieved);
  const opened = new Set(receipt.opened);

  for (const value of receipt.opened) {
    if (!retrieved.has(value)) {
      fail("FMP_CONTEXT_LINEAGE", "opened memories must be a subset of retrieved memories");
    }
  }
  for (const value of receipt.reliedUpon) {
    if (!opened.has(value)) {
      fail("FMP_CONTEXT_LINEAGE", "reliedUpon memories must be a subset of opened memories");
    }
  }
  for (const value of receipt.rejectedOrConflicting) {
    if (!opened.has(value)) {
      fail("FMP_CONTEXT_LINEAGE", "rejectedOrConflicting memories must be a subset of opened memories");
    }
  }
}

export function assertFamiliarManifestV1(value: unknown): asserts value is FamiliarManifestV1 {
  const record = asRecord(value, "FamiliarManifestV1");
  assertLiteral(record, "kind", "arobi.familiar-manifest");
  assertLiteral(record, "version", 1);
  nonEmptyString(record, "manifestId");
  validateScope(record);
  nonEmptyString(record, "principalBinding");
  digest(record, "genesisDigest");
  digest(record, "constitutionDigest");
  digest(record, "personalityDigest");
  digest(record, "memoryRoot");
  digest(record, "coreMemoryRoot");
  digest(record, "skillRoot");
  nonNegativeInteger(record, "policyEpoch");
  nonNegativeInteger(record, "authorityEpoch");
  optionalDigest(record, "previousContinuityDigest");
  isoUtc(record, "createdAt");
  if (record.signatureRef !== undefined) nonEmptyString(record, "signatureRef");
}

export function assertFamiliarMemoryArtifactV1(value: unknown): asserts value is FamiliarMemoryArtifactV1 {
  const record = asRecord(value, "FamiliarMemoryArtifactV1");
  assertLiteral(record, "kind", "arobi.familiar-memory");
  assertLiteral(record, "version", 1);
  nonEmptyString(record, "memoryId");
  validateScope(record);
  enumValue(record, "memoryClass", FAMILIAR_MEMORY_CLASSES);
  digest(record, "contentDigest");
  if (record.encryptedPayloadRef !== undefined) nonEmptyString(record, "encryptedPayloadRef");
  digest(record, "originLabelDigest");
  digestArray(record, "sourceArtifacts");
  digestArray(record, "transformationChain");
  enumValue(record, "trustClass", MEMORY_TRUST_CLASSES);
  enumValue(record, "supportState", MEMORY_SUPPORT_STATES);
  booleanValue(record, "mayInform");
  // Runtime enforcement complements the literal false TypeScript contract.
  if (record.mayAuthorize !== false) {
    fail("FMP_MEMORY_CANNOT_AUTHORIZE", "mayAuthorize must be false; memory is contextual evidence, never live authority");
  }
  positiveInteger(record, "revision");
  optionalDigest(record, "previousDigest");
  optionalDigest(record, "supersededBy");
  isoUtc(record, "createdAt");
  optionalIsoUtc(record, "expiresAt");
  if (record.scope !== undefined) assertFamiliarMemoryScopeV1(record.scope);
  if (record.links !== undefined) assertFamiliarMemoryLinksV1(record.links);
}

function validateMutationShape(receipt: MemoryMutationReceiptV1): void {
  const previousCount = receipt.previousDigests.length;
  const hasNext = receipt.nextDigest !== undefined;

  switch (receipt.operation) {
    case "CREATE":
      if (previousCount !== 0 || !hasNext) fail("FMP_INVALID_MUTATION", "CREATE requires zero previous digests and one next digest");
      break;
    case "MERGE":
      if (previousCount < 2 || !hasNext) fail("FMP_INVALID_MUTATION", "MERGE requires at least two previous digests and one next digest");
      break;
    case "PROMOTE":
    case "CORRECT":
    case "SUPERSEDE":
    case "QUARANTINE":
      if (previousCount < 1 || !hasNext) fail("FMP_INVALID_MUTATION", `${receipt.operation} requires previous lineage and one next digest`);
      break;
    case "REVOKE":
    case "FORGET":
      if (previousCount < 1) fail("FMP_INVALID_MUTATION", `${receipt.operation} requires previous lineage`);
      break;
  }
}

export function assertMemoryMutationReceiptV1(value: unknown): asserts value is MemoryMutationReceiptV1 {
  const record = asRecord(value, "MemoryMutationReceiptV1");
  assertLiteral(record, "kind", "arobi.familiar-memory-mutation");
  assertLiteral(record, "version", 1);
  nonEmptyString(record, "mutationId");
  validateScope(record);
  enumValue(record, "operation", MEMORY_MUTATION_OPERATIONS);
  nonEmptyString(record, "actorRef");
  digest(record, "reasonDigest");
  nonNegativeInteger(record, "policyEpoch");
  digestArray(record, "previousDigests");
  optionalDigest(record, "nextDigest");
  digestArray(record, "evidenceDigests");
  isoUtc(record, "createdAt");
  validateMutationShape(record as unknown as MemoryMutationReceiptV1);
}

export function assertSameFamiliarScope(
  before: Pick<FamiliarMemoryArtifactV1, "tenantId" | "familiarId" | "identityEpoch">,
  after: Pick<FamiliarMemoryArtifactV1, "tenantId" | "familiarId" | "identityEpoch">,
): void {
  if (before.tenantId !== after.tenantId) fail("FMP_SCOPE_MISMATCH", "mutation cannot cross tenantId");
  if (before.familiarId !== after.familiarId) fail("FMP_SCOPE_MISMATCH", "mutation cannot cross familiarId");
  if (before.identityEpoch !== after.identityEpoch) fail("FMP_SCOPE_MISMATCH", "mutation cannot silently cross identityEpoch");
}

export function assertContextUseReceiptV1(value: unknown): asserts value is ContextUseReceiptV1 {
  const record = asRecord(value, "ContextUseReceiptV1");
  assertLiteral(record, "kind", "arobi.familiar-context-use");
  assertLiteral(record, "version", 1);
  nonEmptyString(record, "receiptId");
  validateScope(record);
  digest(record, "purposeDigest");
  digestArray(record, "retrieved");
  digestArray(record, "opened");
  digestArray(record, "reliedUpon");
  digestArray(record, "rejectedOrConflicting");
  digest(record, "proposalDigest");
  digest(record, "familiarContinuityDigest");
  isoUtc(record, "createdAt");
  validateReceiptSubset(record as unknown as ContextUseReceiptV1);
}

export function assertFamiliarContinuityAttestationV1(value: unknown): asserts value is FamiliarContinuityAttestationV1 {
  const record = asRecord(value, "FamiliarContinuityAttestationV1");
  assertLiteral(record, "kind", "arobi.familiar-continuity");
  assertLiteral(record, "version", 1);
  nonEmptyString(record, "attestationId");
  validateScope(record);
  digest(record, "memoryRoot");
  digest(record, "coreMemoryRoot");
  digest(record, "modelDigest");
  digest(record, "runtimeDigest");
  nonNegativeInteger(record, "policyEpoch");
  nonNegativeInteger(record, "authorityEpoch");
  digest(record, "toolCapabilityDigest");
  optionalDigest(record, "previousContinuityDigest");
  isoUtc(record, "createdAt");
  if (record.signatureRef !== undefined) nonEmptyString(record, "signatureRef");
}

export function assertMemoryTombstoneReceiptV1(value: unknown): asserts value is MemoryTombstoneReceiptV1 {
  const record = asRecord(value, "MemoryTombstoneReceiptV1");
  assertLiteral(record, "kind", "arobi.familiar-memory-tombstone");
  assertLiteral(record, "version", 1);
  nonEmptyString(record, "tombstoneId");
  nonEmptyString(record, "memoryId");
  validateScope(record);
  digest(record, "forgottenDigest");
  digest(record, "mutationReceiptDigest");
  digestArray(record, "invalidatedDerivedDigests");
  isoUtc(record, "createdAt");

  if (!Array.isArray(record.surfaces) || record.surfaces.length === 0) {
    fail("FMP_INVALID_ARRAY", "surfaces must contain at least one controlled-erasure result");
  }
  const allowedStates = new Set(["VERIFIED", "FAILED", "NOT_APPLICABLE", "OUTSIDE_CONTROL"]);
  for (const [index, entry] of record.surfaces.entries()) {
    const surface = asRecord(entry, `surfaces[${index}]`);
    nonEmptyString(surface, "surface");
    const state = nonEmptyString(surface, "state");
    if (!allowedStates.has(state)) fail("FMP_INVALID_ENUM", `surfaces[${index}].state is unsupported`);
    optionalDigest(surface, "verificationDigest");
    if (surface.detail !== undefined && typeof surface.detail !== "string") {
      fail("FMP_INVALID_STRING", `surfaces[${index}].detail must be a string`);
    }
  }
}

export function assertFamiliarCapsuleV1(value: unknown): asserts value is FamiliarCapsuleV1 {
  const record = asRecord(value, "FamiliarCapsuleV1");
  assertLiteral(record, "kind", "arobi.familiar-capsule");
  assertLiteral(record, "version", 1);
  nonEmptyString(record, "capsuleId");
  validateScope(record);
  digest(record, "manifestDigest");
  digest(record, "continuityDigest");
  digestArray(record, "selectedMemoryDigests");
  digestArray(record, "selectedSkillDigests");
  digestArray(record, "privacyConstraintDigests");
  digestArray(record, "provenanceDigests");
  if (record.authorityPortable !== false) {
    fail("FMP_AUTHORITY_NOT_PORTABLE", "authorityPortable must be false; importing familiar memory never imports execution authority");
  }
  isoUtc(record, "createdAt");
}
