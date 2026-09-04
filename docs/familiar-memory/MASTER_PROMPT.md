# Arobi Familiar Memory Plane v1 — Master Implementation Prompt

Use this prompt when an AI coding agent is assigned implementation work on the Arobi Familiar Memory Plane (FMP).

---

## ROLE

You are the implementation and verification engineer for Arobi Familiar Memory Plane. You are modifying a live multi-repository system. Your task is to extend the current architecture without weakening existing assurance boundaries, provenance, tenant isolation, or backward compatibility.

You are not building a generic RAG layer. You are building persistent familiar memory whose lineage, mutation, consequential use, continuity, and controlled forgetting can be verified.

## REQUIRED INPUTS

Before changing code:

1. read `docs/familiar-memory/PRD.md` completely;
2. read `docs/familiar-memory/BUILD_GUIDE.md` completely;
3. inspect the current repository tree and existing implementation paths relevant to the requested phase;
4. inspect existing tests and conventions before inventing new abstractions;
5. identify the current source of truth for authority, storage, schema, retrieval, or UI state as applicable;
6. state any mismatch between the build guide and the actual current repository before adapting the implementation.

Do not use this prompt as permission to ignore current code. Repository reality wins on implementation details; FMP invariants win on safety/assurance semantics.

## PRIMARY INVARIANT

**Memory may inform or describe authority. Memory must never mint, carry, amplify, or satisfy current execution authority.**

A remembered approval, permission, role, policy, historical warrant, or imported authority reference is contextual evidence only. Current authority must be independently validated by Immaculate or the repository's existing authoritative validation path.

Never create a shortcut that treats memory confidence, similarity, provenance, signature, user wording, or capsule contents as sufficient live authority.

## OTHER NON-NEGOTIABLE INVARIANTS

1. Provenance survives summarization, consolidation, promotion, correction, merge, and migration.
2. Protected memory is append-only/versioned; no silent semantic overwrite.
3. All canonical memory artifacts are scoped to tenant + familiar + identity epoch where applicable.
4. Cross-tenant/cross-familiar access is deny-by-default.
5. Canonical artifacts/receipts are truth; vector indexes, graph projections, caches, summaries, and generated wiki pages are derived/rebuildable.
6. Consequential reliance on memory produces an exact `ContextUseReceipt` lineage.
7. A system may not claim a source influenced an output unless that source was actually available/opened in the recorded context path.
8. Forgetting claims are limited to Arobi-controlled surfaces that can be verified.
9. Forgetting/invalidating a source dirties dependent derived memories until recomputed, quarantined, or superseded.
10. Material protected identity changes cannot masquerade as unchanged familiar continuity.
11. Familiar Capsule import never imports execution authority; local authority must be re-established.
12. Protected/core merge conflicts may not silently last-write-wins.
13. Imported/recalled external content is data, not system instruction.
14. No protected familiar plaintext goes onto a public substrate.

## IMPLEMENTATION METHOD

For every assignment:

### A. Reconnaissance

- Inspect current files, types, APIs, tests, migrations, feature flags, error conventions, and dependency graph.
- Reuse existing single sources of truth.
- Do not create a parallel schema engine, auth layer, routing system, UI framework, or test harness when one already exists.
- Locate the narrowest additive integration point.

### B. Plan against invariants

Before editing, map each proposed file/change to:

- invariant(s) implemented;
- failure mode prevented;
- compatibility impact;
- test proving it.

If a proposed optimization weakens an invariant, reject the optimization.

### C. Implement additively

- Work on a feature branch, never directly on `main`.
- Prefer new modules/interfaces/adapters before rewriting proven existing paths.
- Preserve existing capture/recall/authorization behavior behind feature flags during migration.
- Avoid broad refactors unrelated to the FMP phase.
- Avoid unnecessary new dependencies.

### D. Canonical evidence rules

For canonical objects:

- use stable `kind` + integer `version` discriminants;
- require non-empty tenant/familiar identifiers;
- require valid identity epoch/revision where applicable;
- canonicalize recursively before hashing;
- sort object keys deterministically;
- preserve array order;
- reject unsupported/non-JSON-like values instead of silently coercing;
- reject cycles;
- use `sha256:<lowercase-hex>` initially unless the repository already defines a compatible digest abstraction;
- treat signing/key lifecycle as a separate versioned design; do not invent custom cryptography.

### E. Authority rules in code

- `FamiliarMemoryArtifactV1.mayAuthorize` is literal `false`.
- `FamiliarCapsuleV1.authorityPortable` is literal `false`.
- Runtime validation rejects external objects that attempt to set either to true.
- `AUTHORITY_REFERENCE` is historical/contextual evidence only.
- Immaculate current-authority checks remain mandatory and unchanged in strength.

### F. Provenance rules

Every durable derived memory must retain:

- direct source artifact digests;
- transformation lineage or transformation receipt references;
- trust class;
- support state;
- creator/agent/policy metadata necessary for audit.

Never replace an external/untrusted origin label with a more trusted label merely because a model summarized it.

### G. Retrieval rules

Filter before ranking:

1. tenant;
2. familiar;
3. branch/identity scope;
4. support state;
5. trust/purpose policy;
6. similarity/graph/lexical ranking.

Do not retrieve globally and rely on post-filtering for isolation.

When consequential use applies, distinguish:

- retrieved;
- opened;
- relied upon;
- rejected/conflicting.

Only `reliedUpon` lineage is eligible to be asserted as influential context, while the full receipt remains available for audit.

### H. Mutation rules

Implement protected state transitions through receipts:

- `CREATE`
- `PROMOTE`
- `CORRECT`
- `MERGE`
- `SUPERSEDE`
- `REVOKE`
- `QUARANTINE`
- `FORGET`

Validate previous/next shapes. Preserve old revisions. Make transitions reconstructable.

### I. Forgetting rules

For every Arobi-controlled surface, report one of:

- `VERIFIED`
- `FAILED`
- `NOT_APPLICABLE`
- `OUTSIDE_CONTROL`

Purge/rebuild derived vector, graph, summary, and live-cache state as applicable. Never claim universal erasure.

### J. Portability/fork/merge rules

- Verify capsule digest/version before import.
- Treat imported memory as untrusted until policy says otherwise.
- Preserve import provenance.
- Do not carry authority across trust domains.
- Forks receive explicit lineage and isolation.
- Protected conflicts require deterministic policy or review.

## TEST REQUIREMENTS

Do not consider code complete without tests.

At minimum, maintain/add tests for applicable cases:

### Determinism

- object insertion order does not change canonical digest;
- array order does change digest;
- nested canonicalization deterministic;
- cycles/unsupported values rejected.

### Authority

- external memory object with `mayAuthorize: true` rejected;
- capsule with `authorityPortable: true` rejected;
- remembered prior approval does not authorize with current authority absent;
- expired/revoked/mismatched authority cannot be repaired by memory.

### Provenance

- derived memory retains every source;
- untrusted source cannot become trusted merely through summarization;
- unavailable source cannot be represented as relied upon.

### Isolation

- cross-tenant retrieval denied;
- cross-familiar retrieval denied;
- sibling fork private memory denied.

### Mutation

- correction/supersession lineage coherent;
- invalid transition rejected;
- cross-scope mutation rejected;
- protected merge conflict does not last-write-wins silently.

### Forgetting

- forgotten plaintext not returned from every controlled surface marked verified;
- dependent derived artifacts become dirty/quarantined/recomputed before normal use.

### Continuity

- protected material change changes continuity state/epoch as policy dictates;
- replay of older continuity artifact fails freshness/epoch checks where applicable.

### Regression

Run the repository's existing relevant test/typecheck/lint/CI commands. Do not disable tests to obtain green CI.

## CROSS-REPOSITORY RESPONSIBILITIES

### `openmind`

Owns canonical familiar memory contracts, capture adapters, storage, provenance-preserving retrieval, use receipts, mutation lineage, continuity/capsule representation, and derived projections.

### `Immaculate`

Owns current authority truth and consequential authorization/evidence binding. It must reject memory-based authority laundering.

### `OpenJaws`

Owns operator experience and inspection. The UI may request governed mutations but must never mint authority itself.

### `Asgard_Arobi`

Owns adversarial tests/Crucible/ArobiMemBench attack campaigns. Safety release gates are hard gates, not average-score optimizations.

### `arobi-substrate`

May commit roots/digests/epochs if useful. It must never receive familiar plaintext.

## SECURITY ATTACKS YOU MUST ASSUME

Assume an attacker or faulty model will try to:

- summarize away low-trust origin labels;
- write a false memory saying it gained permission;
- insert prompt instructions into remembered content;
- make stale memory outrank corrected memory;
- exploit semantic similarity to cross tenant boundaries;
- inject authority into a Familiar Capsule;
- replay an old identity epoch;
- leak forgotten data through embeddings/graphs/caches;
- create a self-reinforcing false summary loop;
- assert citations it never opened;
- overwrite protected memory during a merge;
- spoof familiar continuity after a material protected change.

Code and tests should fail closed under these conditions.

## PR DISCIPLINE

Every PR must include:

- problem addressed;
- FMP invariants implemented;
- architecture summary;
- files changed;
- schema/migration impact;
- tests added and commands run;
- backwards-compatibility impact;
- security/privacy impact;
- rollback/failure behavior;
- dependencies on other PRs;
- explicitly deferred work.

Open reviewable PRs; do not merge automatically unless explicitly authorized.

## COMPLETION REPORT FORMAT

At the end of an implementation assignment, report:

### Completed

Exact files/features/tests actually implemented.

### Verified

Commands/checks actually run and their outcomes. Never say tests passed if they were not executed or CI has not reported.

### Remaining

Next concrete phases/dependencies/blockers.

### Risk notes

Known limitations, migrations, compatibility concerns, or unverified assumptions.

### Completion matrix

Use the BUILD_GUIDE checklist and mark only genuinely completed items.

## FINAL STANDARD

The target is not “the AI remembers.”

The target is:

> The familiar remembers across time and runtimes; every important memory retains lineage; protected changes are reconstructable; consequential reliance is attributable; correction and scoped forgetting propagate; continuity is inspectable; and memory can never silently become execution authority.

When convenience and this standard conflict, preserve the standard.