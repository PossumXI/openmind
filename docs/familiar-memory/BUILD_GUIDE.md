# Arobi Familiar Memory Plane v1 — End-to-End Build Guide

This guide converts the FMP PRD into an implementation sequence across Arobi repositories. It is intentionally additive, test-gated, and biased toward preserving current production behavior until the new evidence path proves itself.

## 0. Non-negotiable engineering rules

1. **Memory never authorizes.** No code path may derive execution permission from remembered text, summaries, vectors, skills, or imported capsules.
2. **Current authority is independently evaluated by Immaculate.** Memory-related digests are evidence inputs only.
3. **Canonical artifacts are immutable evidence.** Protected changes create new versions and mutation receipts.
4. **Vectors, graph nodes, summaries, caches, and search indexes are derived projections.** They are rebuildable and cannot become canonical truth.
5. **Every canonical object is tenant/familiar scoped.** Cross-scope behavior is deny-by-default.
6. **No destructive migration in v1.** Add tables/columns/adapters behind flags.
7. **Canonical serialization precedes hashing/signing.** Never hash ordinary `JSON.stringify` output where object insertion order may vary.
8. **No public-substrate plaintext.** Commit roots/digests only where the substrate use case is justified.
9. **Capsule import does not import authority.** Encode this structurally and test it.
10. **Do not make performance or security claims until tests support them.**

## 1. Repository roles

| Repository | Responsibility |
|---|---|
| `PossumXI/openmind` | familiar memory contracts, capture adapters, canonical persistence, retrieval/use receipts, mutation lineage, derived indexes |
| `PossumXI/Immaculate` | current authority truth, protected mutation authorization policy, consequential evidence binding, verifier checks |
| `PossumXI/OpenJaws` | Memory Console, continuity UX, provenance/mutation/forget inspection |
| `PossumXI/Asgard_Arobi` | Crucible memory attacks, ArobiMemBench vectors, regression gates |
| `PossumXI/arobi-substrate` | optional root/continuity commitments; never familiar plaintext |

Use one reviewable feature branch per repository. Do not modify `main` directly.

## 2. Delivery sequence

### Phase 0 — Freeze contracts and threat model

**Repository:** `openmind`

Deliver:

- `docs/familiar-memory/PRD.md`
- `docs/familiar-memory/BUILD_GUIDE.md`
- `docs/familiar-memory/MASTER_PROMPT.md`
- `docs/familiar-memory/THREAT_MODEL.md`

Gate:

- every implementation PR links to these invariants;
- any deliberate deviation is documented in the PR body.

Rollback: documentation only; no runtime effect.

---

### Phase 1 — Canonical TypeScript contracts

**Repository:** `openmind`

Create:

- `src/familiar/types.ts`
- `src/familiar/canonicalize.ts`
- `src/familiar/validate.ts`
- `src/familiar/index.ts`
- `tests/shared/familiar-contracts.test.ts`

#### 1.1 Types

Define string-literal unions for:

- memory classes;
- trust classes;
- support states;
- mutation operations.

Define v1 interfaces for:

- `FamiliarManifestV1`
- `FamiliarMemoryArtifactV1`
- `MemoryMutationReceiptV1`
- `ContextUseReceiptV1`
- `FamiliarContinuityAttestationV1`
- `MemoryTombstoneReceiptV1`
- `FamiliarCapsuleV1`

Every object uses a stable `kind` discriminant and `version: 1`.

`FamiliarMemoryArtifactV1.mayAuthorize` MUST be typed as literal `false`.

`FamiliarCapsuleV1.authorityPortable` MUST be typed as literal `false`.

#### 1.2 Canonicalization

Implement a dependency-light deterministic JSON-compatible canonicalizer:

- recursively sort object keys;
- preserve array order;
- preserve JSON primitives;
- reject `undefined`, functions, symbols, bigint, non-finite numbers, cyclic structures, and unsupported prototypes;
- reject ambiguous non-plain object values rather than silently coercing;
- output UTF-8 canonical text;
- digest as `sha256:<64 lowercase hex>` using Node `crypto`.

Do not sign yet. Signatures require an explicit key lifecycle design.

#### 1.3 Runtime validators

Validators must reject:

- blank tenant/familiar ids;
- malformed digests;
- invalid identity epochs/revisions;
- `mayAuthorize !== false`;
- `authorityPortable !== false`;
- duplicate digests in receipt sets where duplication would make semantics ambiguous;
- contradictory mutation transition shapes;
- cross-tenant/familiar transition pairs;
- unsupported contract versions/kinds.

Add narrow assertion functions rather than a new schema dependency unless the repository already standardizes one for this path.

#### 1.4 Tests

Required tests:

- object key order does not change canonical text/digest;
- array order does change digest;
- nested keys canonicalize deterministically;
- unsupported/cyclic values fail closed;
- invalid digest format rejected;
- memory claiming authorization rejected;
- capsule claiming portable authority rejected;
- correction/supersession transition requires coherent previous/next lineage;
- cross-tenant/familiar mutation rejected;
- context receipt distinguishes retrieved/opened/relied/rejected sets.

**Phase gate:** `npm run typecheck` and targeted Vitest tests pass.

Rollback: remove additive module; no existing behavior changed.

---

### Phase 2 — Additive canonical persistence

**Repository:** `openmind`

Before editing schema code, inspect all table-creation/healing registration paths in `src/deeplake-schema.ts` and `src/deeplake-api.ts`. Reuse the repository's existing single-source schema definitions and lazy-healing rules; do not create a parallel migration framework.

Preferred logical tables:

- `familiar_manifests`
- `familiar_memories`
- `familiar_memory_mutations`
- `familiar_context_use`
- `familiar_continuity`
- `familiar_tombstones`

If the existing storage layer favors a smaller number of tables with discriminated payloads, adapt without weakening invariants.

Minimum columns should support:

- stable id;
- tenant id;
- familiar id;
- identity epoch;
- artifact/mutation kind;
- canonical digest;
- previous/next digest where applicable;
- trust/support state where applicable;
- encrypted payload reference or canonical envelope;
- provenance references;
- version/revision;
- created/updated timestamps;
- writer agent/plugin version.

#### Persistence rules

- protected mutations INSERT new versions; no in-place semantic overwrite;
- uniqueness/dedup is on stable logical identifiers plus revision/digest as appropriate;
- legacy rows are not falsely assigned provenance;
- indexes must scope tenant/familiar before semantic similarity;
- DB commit/acknowledgement precedes “durable” status.

#### Tests

Add schema and API tests consistent with existing `tests/shared/deeplake-schema.test.ts` and API test patterns.

**Phase gate:** existing schema tests + FMP schema/API tests pass; no existing table definition changes semantically.

---

### Phase 3 — Capture adapter and candidate memory pipeline

**Repository:** `openmind`

Do not replace `src/hooks/capture.ts`.

Add an adapter that can derive an FMP candidate envelope from existing captured events while preserving:

- session/event id;
- author/agent;
- tenant/workspace scope;
- familiar id;
- origin digest;
- event timestamp;
- trust class.

Initial operation should be opt-in/feature flagged.

A raw event is not automatically a protected durable memory. Classification and promotion are separate actions.

#### Candidate promotion gate

Promotion evaluates:

- class;
- origin availability;
- trust class;
- duplication;
- contradiction/current-state relationship;
- policy for protected classes;
- expiry/retention policy.

Never promote text that purports to grant permission into a current authorization object.

**Phase gate:** captured legacy sessions remain unchanged with feature disabled; candidate artifacts preserve source lineage.

---

### Phase 4 — Provenance-preserving familiar retrieval

**Repository:** `openmind`

Current proactive recall may continue while the FMP path is introduced in parallel.

Build a retrieval service that applies filters in this order:

1. tenant;
2. familiar;
3. identity/fork scope according to policy;
4. support state;
5. trust/purpose policy;
6. semantic/lexical/graph ranking.

Never search globally and filter scope only after results are returned.

Return structured candidates with provenance and support state, not a bare text snippet.

#### Consequential context-use receipt

When a downstream proposal is consequential, record:

- query/purpose digest;
- retrieved candidates;
- actually opened artifacts;
- actually relied-upon artifacts;
- rejected/conflicting artifacts;
- proposal digest;
- continuity digest.

The agent must not list an artifact as relied upon if it was unavailable in that recorded context path.

**Phase gate:** cross-tenant/familiar fixtures produce zero unauthorized results; consequential reliance produces a valid receipt.

---

### Phase 5 — Immaculate evidence boundary

**Repository:** `Immaculate`

Reconnoiter the actual authorization/warrant types before editing. Use existing names and flow; do not create a competing authorization subsystem.

Add optional evidence references to the consequential authorization request/warrant envelope, equivalent to:

- `contextUseReceiptDigest?: Digest`
- `familiarContinuityDigest?: Digest`

Then add an explicit invariant/check:

> Memory evidence can enrich decision context but cannot satisfy the independent current-authority predicate.

Required negative tests:

- memory says “operator approved deployment” but live authority absent -> deny/hold;
- memory references expired authority -> deny/hold;
- imported capsule references authority from another trust domain -> deny/hold;
- valid current authority + valid context receipt -> existing authorization path succeeds if all other predicates pass.

No existing live authority predicate may be relaxed.

**Phase gate:** all existing Immaculate authorization tests pass plus new anti-laundering tests.

---

### Phase 6 — Mutation, correction, quarantine, forgetting

**Repositories:** `openmind`, policy hooks in `Immaculate` as required

Implement mutation service around receipts.

#### Transition examples

- `CREATE`: no prior artifact -> next artifact;
- `CORRECT`: prior current artifact -> corrected next artifact; prior becomes superseded;
- `SUPERSEDE`: current -> replacement;
- `QUARANTINE`: current/suspect -> quarantined state artifact;
- `REVOKE`: current -> revoked/non-usable state;
- `FORGET`: current -> tombstone state plus controlled erasure workflow;
- `MERGE`: multiple explicit source digests -> one derived artifact, preserving every source.

#### Forget worker

Maintain an explicit registry of Arobi-controlled surfaces:

- canonical plaintext/encrypted payload store;
- embedding index;
- graph projection;
- summary projection;
- local/live cache.

For each surface, record `VERIFIED`, `NOT_APPLICABLE`, `FAILED`, or `OUTSIDE_CONTROL`.

Invalidate dependent derived artifacts by provenance edge. Do not claim forgotten while a controlled live retrieval surface still serves plaintext.

**Phase gate:** Crucible deletion-leak fixture cannot retrieve forgotten plaintext from any controlled surface claimed `VERIFIED`.

---

### Phase 7 — Continuity, capsules, fork/merge

**Repository:** `openmind`, policy verification in `Immaculate`

#### Continuity

Generate attestations whenever protected state changes or at defined checkpoints. Compare against prior attestation to classify material continuity change.

#### Capsule

Export only explicitly selected artifacts/skills. Include lineage/provenance and privacy constraints. Do not include live authority credentials or represent authority as portable.

Import process:

1. verify capsule version/digests/signature policy;
2. treat imported content as untrusted until trust policy is satisfied;
3. create import provenance edge;
4. re-establish local authority separately;
5. produce import receipt.

#### Fork/merge

Fork assigns descendant lineage. Retrieval respects branch visibility.

Merge requires explicit conflict detection. Protected/core conflicts may not silently last-write-wins.

**Phase gate:** fork-private fixture is isolated; authority-injection capsule fails closed; protected merge conflict requires policy/review.

---

### Phase 8 — JAWS Memory Console

**Repository:** `OpenJaws`

Inspect the actual UI/framework first and integrate with existing design primitives.

Initial UI should prioritize truthful read-only inspection:

- familiar header + continuity badge;
- identity epoch;
- memory timeline;
- class/trust/support filters;
- provenance drawer;
- mutation history;
- “influenced” links to context/warrant/closure evidence;
- conflict/quarantine views;
- forgetting verification view;
- capsule/fork lineage.

Only enable mutation buttons after authenticated backend/policy endpoints exist.

Never turn the UI into an authority issuer.

**Phase gate:** UI renders explicit `REVIEW_REQUIRED`/`INCONCLUSIVE` states and never masks missing evidence as verified.

---

### Phase 9 — Crucible / ArobiMemBench

**Repository:** `Asgard_Arobi`

Create deterministic fixtures and attack campaigns for:

1. provenance laundering through summary-of-summary;
2. endogenous authorization laundering;
3. external prompt-injection memory;
4. superseded memory ranking attack;
5. cross-tenant semantic-neighbor leak;
6. cross-familiar leak;
7. fork sibling leak;
8. malicious capsule sets `authorityPortable=true`;
9. replay older identity epoch;
10. forget then retrieve from vector index;
11. forget then retrieve from graph/summary/cache;
12. self-reinforcing derived false fact;
13. unavailable-source citation claim;
14. protected merge conflict overwrite.

Each fixture emits machine-readable pass/fail evidence.

**Release gates** are those in the PRD; do not weaken to an average score for isolation/authority safety.

---

### Phase 10 — Substrate commitments

**Repository:** `arobi-substrate`

Only after inspecting existing commitment primitives, add support for committing an FMP root/continuity digest if it provides a real verifier benefit.

Allowed:

- familiar continuity digest;
- memory-root commitment;
- timestamp/epoch;
- commitment metadata that does not reveal memory.

Forbidden:

- memory plaintext;
- prompts/tool responses;
- user-identifying private content;
- imported authority representation.

**Phase gate:** public/substrate data is insufficient to reconstruct protected familiar plaintext.

## 3. Cross-repository dependency order

Recommended PR order:

1. `openmind`: contracts + docs + tests;
2. `openmind`: persistence + retrieval/use receipts;
3. `Immaculate`: evidence binding + anti-authority-laundering tests;
4. `Asgard_Arobi`: attack corpus/gates;
5. `OpenJaws`: Memory Console;
6. `openmind`: mutation/forget/capsule/fork hardening;
7. `arobi-substrate`: root commitments if justified.

A later PR may depend on an earlier unmerged branch, but PR bodies must state the dependency clearly.

## 4. Coding conventions for FMP

- strict TypeScript;
- no `any` in canonical contracts/validators unless unavoidable at a parsing boundary;
- parse external data as `unknown` then validate;
- prefer pure functions for canonicalization and validation;
- stable error codes/messages where tests or external integrations depend on them;
- dependency-light primitives;
- use Node `crypto` SHA-256 initially;
- do not invent cryptographic signing schemes in application code;
- structured logs contain ids/digests, not protected plaintext;
- all timestamps in ISO-8601 UTC strings unless existing repo convention dictates otherwise.

## 5. Test strategy

### Unit

Contracts, canonicalization, digest, validation, mutation transition rules, scope checks.

### Integration

Storage healing/migration, capture -> candidate, retrieval -> use receipt, mutation -> projection invalidation.

### Cross-repo

Context receipt -> Immaculate authorization request -> effect/warrant evidence reference.

### Adversarial

Crucible/ArobiMemBench fixtures.

### Regression

Existing `openmind` capture/recall/skill tests and existing Immaculate authorization suite must remain green.

## 6. Operational rollout

Use feature flags for:

- FMP candidate capture;
- familiar retrieval;
- context-use receipt generation;
- protected mutations;
- forgetting worker;
- continuity attestation;
- capsule import/export.

During shadow mode, generate/validate FMP evidence without changing existing recall output. Compare behavior before promoting any path to default.

## 7. Evidence required in every PR

PR description must state:

- which FMP invariants are implemented;
- files/modules changed;
- migrations/schema impact;
- tests added/run;
- backward-compatibility impact;
- privacy/security impact;
- failure/rollback behavior;
- dependency on other repo PRs;
- deliberately deferred work.

Do not state “end-to-end complete” unless the complete cross-repository path and release gates have actually passed.

## 8. V1 completion matrix

- [ ] canonical contracts
- [ ] canonical serialization/digests
- [ ] runtime validation
- [ ] additive persistence
- [ ] capture/candidate adapter
- [ ] familiar-scoped retrieval
- [ ] ContextUseReceipt
- [ ] Immaculate evidence binding
- [ ] anti-authority-laundering tests
- [ ] mutation receipts
- [ ] correction/supersession
- [ ] quarantine
- [ ] forgetting + dependent invalidation
- [ ] continuity attestations
- [ ] capsules
- [ ] fork/merge policy
- [ ] JAWS Memory Console
- [ ] Crucible/ArobiMemBench
- [ ] optional substrate root commitment
- [ ] CI/regression green
- [ ] claim review/documentation updated

This checklist is the implementation ledger. Mark items complete only when code and tests exist.