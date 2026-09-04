# Arobi Familiar Memory Plane v1 — Product Requirements Document

**Status:** Implementation baseline  
**Owner:** Arobi Technology Alliance  
**Primary substrate:** `openmind`  
**Assurance boundary:** Immaculate  
**Operator UX:** OpenJaws / JAWS Flight Deck  
**Adversarial validation:** Asgard_Arobi / Crucible

## 1. Executive summary

Arobi Familiar Memory Plane (FMP) provides persistent, familiar, identity-bound memory for AI agents across sessions, models, devices, teammates, and supported runtimes while preserving Arobi's core assurance separation between context and authority.

The category objective is not merely long-term recall. FMP must make continuity, provenance, mutation, correction, forgetting, portability, and consequential use independently inspectable and verifiable.

A familiar may remember that an operator previously approved an action. That memory is contextual evidence only. It must never become a live credential or satisfy an authorization requirement. Immaculate remains the source of current execution authority.

> **Hard invariant:** Memory may inform or describe authority. Memory must never mint, carry, amplify, or satisfy current execution authority.

## 2. Problem

Persistent-agent memory creates several new failure classes:

1. provenance can be lost during summarization or consolidation;
2. stale observations can be promoted into durable false beliefs;
3. remembered permissions can be mistaken for current permissions;
4. memories can leak across tenants, familiars, forks, or trust domains;
5. correction can silently overwrite history, destroying auditability;
6. deletion can leave live derived copies in embeddings, graphs, caches, or summaries;
7. imported memory can smuggle authority or malicious instructions;
8. model/runtime changes can make a familiar appear continuous when protected identity state materially changed;
9. a model can claim that an unavailable source informed a decision;
10. downstream physical or digital effects can become detached from the memories that influenced them.

Conventional retrieval quality alone does not address these risks.

## 3. Product thesis

FMP should make the following statement true:

> A familiar remains recognizably continuous across time and runtimes, and Arobi can prove what it remembers, where each memory came from, how it changed, what it influenced, what was corrected or forgotten, and whether the familiar itself materially changed.

The defensible value is the assurance protocol and evidence lineage surrounding memory, not ownership claims over commodity embeddings, vector search, or upstream open-source memory substrates.

## 4. Goals

### 4.1 V1 goals

- Persistent familiar identity keyed by `tenantId` + `familiarId` + `identityEpoch`.
- Typed memory artifacts with immutable provenance.
- Stable canonical serialization and content digests.
- Append-only protected memory mutation receipts.
- Runtime validation that memory cannot authorize execution.
- Consequential recall/use receipts that distinguish retrieved, opened, relied-upon, and rejected memories.
- Familiar continuity attestations.
- Selective correction, quarantine, supersession, revocation, and forgetting semantics.
- Portable Familiar Capsules that explicitly do not port authority.
- Backward-compatible integration with existing `openmind` capture/recall behavior.
- Immaculate binding for consequential use.
- Crucible attack corpus and acceptance gates.
- JAWS operator visibility into memory and continuity.

### 4.2 Non-goals for the first vertical slice

- Replacing existing `openmind` session capture, embeddings, graph, or skill mining.
- Claiming universal erasure outside Arobi-controlled systems.
- Letting FMP become an authorization service.
- Automatically merging protected/core-memory conflicts.
- Storing familiar plaintext or private memory payloads on a public substrate.
- Treating benchmark scores from different configurations as directly comparable.

## 5. Product principles and invariants

### INV-FMP-001 — Authority non-amplification

A memory artifact MUST encode `mayAuthorize: false`. No memory type may satisfy missing, stale, revoked, expired, out-of-scope, or otherwise invalid current authority.

### INV-FMP-002 — Provenance survival

Every durable memory must retain origin and transformation lineage. Summarization, consolidation, promotion, merge, or migration may not erase the trust class or source chain.

### INV-FMP-003 — No silent protected overwrite

Protected memory changes are append-only mutations. Prior revisions remain reconstructable even when superseded, revoked, quarantined, or forgotten.

### INV-FMP-004 — Tenant/familiar isolation

Every canonical artifact is bound to a tenant and familiar. Cross-tenant or cross-familiar references require an explicit import/share operation and must never occur implicitly during retrieval.

### INV-FMP-005 — Canonical truth vs projections

Canonical artifacts and receipts are truth. Embeddings, graph projections, summaries, caches, and search indexes are derived and rebuildable. Derived state cannot outrank canonical state.

### INV-FMP-006 — Consequential recall accountability

When memory materially informs a consequential proposal, the exact relied-upon lineage must be represented in a `ContextUseReceipt.v1` and bound into the downstream assurance path.

### INV-FMP-007 — Forgetting honesty

Arobi may only claim deletion for stores/projections it can verify. A forgotten source invalidates or dirties dependent derived memories until recomputed, quarantined, or superseded.

### INV-FMP-008 — Continuity honesty

Material protected identity changes cannot masquerade as unchanged familiar continuity. Identity epochs and continuity attestations must make discontinuity inspectable.

### INV-FMP-009 — Portability without authority portability

A Familiar Capsule may port identity lineage, selected memories, skills, and privacy constraints. It MUST NOT import execution authority into the receiving trust domain.

### INV-FMP-010 — Evidence availability honesty

The system must not cite or claim reliance on a memory that was not available through the recorded retrieval/context path.

## 6. Memory model

### 6.1 Memory classes

V1 defines:

- `EPISODIC`
- `CORE`
- `PREFERENCE`
- `RELATIONSHIP`
- `PROCEDURAL`
- `SKILL`
- `EVIDENCE`
- `HYPOTHESIS`
- `EXTERNAL_OBSERVATION`
- `AUTHORITY_REFERENCE`

There is intentionally **no `PERMISSION` memory class**.

`AUTHORITY_REFERENCE` means “a historical/contextual pointer exists.” It cannot prove that authority remains current.

### 6.2 Trust classes

- `OPERATOR_AUTHORED`
- `VERIFIED_SYSTEM`
- `OBSERVED`
- `DERIVED`
- `EXTERNAL_UNTRUSTED`

Trust labels survive consolidation and appear in provenance.

### 6.3 Support states

- `ASSERTED`
- `OBSERVED`
- `CORROBORATED`
- `CONTESTED`
- `SUPERSEDED`
- `QUARANTINED`
- `FORGOTTEN`

Retrieval policy must filter or down-rank non-current states according to purpose; it may not silently promote them.

## 7. Canonical contracts

### 7.1 `FamiliarManifest.v1`

Binds:

- tenant and familiar identity;
- genesis digest;
- identity epoch;
- constitution/personality digests;
- memory/core-memory/skill roots;
- policy and authority epochs;
- previous continuity digest;
- creation time and signature metadata.

The display name is not continuity proof. Lineage is.

### 7.2 `FamiliarMemoryArtifact.v1`

Required properties include:

- stable memory id;
- tenant/familiar binding;
- identity epoch;
- memory class;
- digest of content or encrypted payload reference;
- origin label digest;
- source artifact digests;
- transformation chain;
- trust class;
- support state;
- `mayInform`;
- literal `mayAuthorize: false`;
- revision and previous/superseding digest relationships;
- creation/expiry metadata.

### 7.3 `MemoryMutationReceipt.v1`

Operations:

- `CREATE`
- `PROMOTE`
- `CORRECT`
- `MERGE`
- `SUPERSEDE`
- `REVOKE`
- `QUARANTINE`
- `FORGET`

A receipt records the actor/principal reference, reason, previous and next artifact digests where applicable, policy epoch, timestamp, and evidence references.

### 7.4 `ContextUseReceipt.v1`

Records:

- purpose/query digest;
- tenant/familiar/identity epoch;
- retrieved memory digests;
- actually opened memory digests;
- actually relied-upon memory digests;
- rejected/conflicting memory digests;
- proposal/output digest;
- continuity digest in force;
- creation metadata.

The contract is evidence about context use, not authority.

### 7.5 `FamiliarContinuityAttestation.v1`

Records:

- familiar identity and identity epoch;
- memory and protected/core roots;
- model/runtime digests;
- policy and authority epochs;
- tool capability digest;
- previous continuity digest;
- time/signature metadata.

The verifier can return states such as `VERIFIED`, `REVIEW_REQUIRED`, `HELD`, or `INCONCLUSIVE` based on the surrounding assurance policy.

### 7.6 `MemoryTombstoneReceipt.v1`

Represents scoped forgetting without retaining plaintext. It records the deleted memory identifier/digest, scope of Arobi-controlled erasure, derived projections scheduled/rebuilt, and the verification status of each controlled store.

### 7.7 `FamiliarCapsule.v1`

Portable envelope containing selected identity lineage, memory/skill references, continuity state, provenance, and privacy constraints.

It must encode a literal non-portability invariant such as `authorityPortable: false`.

## 8. Lifecycle

```text
capture -> classify -> preserve origin -> candidate memory
       -> validate -> promote/mutate -> canonical artifact
       -> derive embeddings/graph/search projection
       -> retrieve -> open -> rely/reject -> ContextUseReceipt
       -> proposal -> Immaculate authorization evaluation
       -> EffectWarrant / governed execution
       -> EffectClosure / outcome evidence
       -> future correction/promotion/quarantine evidence
```

At no point does recall itself grant permission.

## 9. Integration with current `openmind`

### Capture

Existing raw per-turn capture remains the event substrate. FMP adds familiar identity/provenance/digest metadata without changing existing event semantics in the first migration.

### Retrieval

Existing proactive recall remains available during transition. FMP introduces familiar-scoped, trust-aware retrieval and use receipts behind additive interfaces before replacing any default behavior.

### Storage

New tables/collections are additive. Existing session, memory, skills, rules, goals, KPI, docs, graph, and embedding paths must remain backward compatible.

### Graph and embeddings

Graph/vector layers are projections. A projection can be deleted and rebuilt without losing canonical FMP evidence.

### Skills

Skill mining may create a candidate `PROCEDURAL`/`SKILL` memory, but promotion into protected durable memory requires provenance and policy gates.

## 10. Immaculate boundary

For consequential effects, the downstream authorization/evidence request should accept optional:

- `contextUseReceiptDigest`
- `familiarContinuityDigest`

These fields provide evidence and traceability only.

A valid memory of a prior approval cannot substitute for a current authority check. If current authority is absent, invalid, expired, revoked, mismatched, or out of scope, authorization must fail regardless of memory contents.

## 11. Correction, quarantine, and forgetting

### Correction

Corrections produce a new artifact plus mutation receipt; the old artifact becomes superseded rather than overwritten.

### Quarantine

Suspect memories are excluded from normal consequential recall while remaining available to audit/review workflows.

### Forget

A forget operation must:

1. mark canonical state according to policy;
2. remove plaintext from Arobi-controlled stores when permitted;
3. remove/rebuild vector entries;
4. remove/rebuild graph projections;
5. clear local/live caches;
6. propagate `SOURCE_CHANGED` to dependent derived memories;
7. create a tombstone/verification receipt containing no forgotten plaintext.

Claims must explicitly distinguish verified controlled-store deletion from systems outside Arobi's control.

## 12. Continuity, fork, merge, and portability

A familiar can change model or runtime without automatically becoming a new familiar, but protected changes are captured in continuity state.

A fork creates a descendant lineage with a shared ancestor. Branch-private memory must remain isolated.

Merges may automate low-risk episodic reconciliation. `CORE`, protected preferences, assurance evidence, and authority-adjacent conflicts require deterministic policy or explicit review; silent last-write-wins is forbidden.

Capsule import re-establishes authority in the receiving domain rather than copying it.

## 13. JAWS Memory Console requirements

The operator should be able to inspect:

- familiar identity and continuity state;
- timeline and memory classes;
- core memories;
- procedural memories/skills;
- provenance/source chain;
- mutation history;
- conflicts and quarantined memories;
- memories that influenced a consequential proposal/effect;
- forgetting verification state;
- fork/merge lineage;
- capsule export/import verification.

Primary actions:

- Why do you remember this?
- What established it?
- What did it influence?
- Correct.
- Quarantine.
- Forget where Arobi controls the data.
- Pin/promote according to policy.
- Fork familiar.
- Merge branch.
- Export/import capsule.
- Verify continuity.

Initial UI may be read-only until backend mutation controls are wired through Immaculate/policy.

## 14. Threat model

V1 must explicitly test:

- provenance laundering during summarization;
- endogenous authorization laundering;
- malicious external/imported memory;
- prompt injection carried by recalled content;
- stale/superseded memory winning retrieval;
- cross-tenant and cross-familiar leakage;
- fork leakage;
- unsafe merge conflict resolution;
- replay/downgrade of older identity epochs;
- continuity spoofing;
- deletion leakage via embeddings/graphs/caches/summaries;
- self-reinforcing false derived summaries;
- unavailable-source citation claims;
- signature/key epoch misuse.

## 15. Observability

Minimum telemetry:

- capture counts by memory class/trust class;
- promotion/mutation counts and failure reasons;
- retrieval and reliance counts;
- below-threshold/abstention rates;
- stale/superseded/quarantined retrieval attempts;
- cross-scope access denials;
- continuity state transitions;
- forget verification results;
- dependent-memory invalidations;
- consequential `ContextUseReceipt` -> warrant -> closure linkage completeness.

Telemetry must not expose protected plaintext unnecessarily.

## 16. Performance targets

Targets, to be measured before enforcement:

- familiar validation and digesting should be deterministic and local;
- added FMP bookkeeping should not make the normal recall path unbounded;
- consequential use-receipt creation should be cheap relative to model/tool latency;
- derived indexes may degrade to abstention/failure-isolated behavior rather than blocking all operation;
- canonical write acknowledgement must precede claims that a protected mutation is durable.

Exact latency SLOs are set after baseline measurements on current deployments.

## 17. Security and privacy requirements

- No cross-tenant default queries.
- No plaintext memory commitment to public ledgers/substrates.
- Secret redaction remains before memory egress where applicable.
- Encrypted payload references are preferred for sensitive canonical memory.
- Digests use stable canonical representation.
- Signing/key-management design must be crypto-agile and versioned.
- Imported capsules are untrusted until verified.
- Recalled external content is data, not system instruction.
- Least disclosure applies to UI, logs, verifier bundles, and portability.

## 18. Migration and backward compatibility

- V1 changes are additive.
- Existing session and summary rows remain readable.
- No destructive schema migration in the first release.
- Existing capture/recall can operate while FMP is disabled or partially rolled out.
- Backfill must label provenance confidence honestly; missing provenance cannot be invented.
- Old untyped memory may remain `LEGACY/UNVERIFIED` at the adapter boundary rather than being falsely promoted.

## 19. Rollout

1. contracts, canonicalization, validators, unit tests;
2. additive persistence;
3. candidate-memory adapters from existing capture;
4. familiar-scoped retrieval and context-use receipts;
5. Immaculate evidence binding;
6. correction/quarantine/forgetting;
7. continuity/capsules/forks/merges;
8. JAWS Memory Console;
9. Crucible/ArobiMemBench attack campaign;
10. substrate commitments for roots only where justified;
11. benchmark and production hardening.

Feature flags must permit rollback to existing memory behavior without deleting canonical evidence.

## 20. Acceptance gates / ArobiMemBench

A release is not “verifiable familiar memory” until all applicable gates pass:

| Gate | Required outcome |
|---|---|
| Cross-tenant isolation | 0 unauthorized cross-tenant recalls in the campaign |
| Provenance | 100% of consequential relied-upon memories trace to recorded origin |
| Authority non-amplification | 0 memory-derived unauthorized consequential effects |
| Correction | superseded memory never silently outranks current canonical memory |
| Forgetting | forgotten plaintext absent from every Arobi-controlled live retrieval/index/cache surface claimed by the receipt |
| Mutation integrity | every protected mutation reconstructable from receipts |
| Continuity | protected changes cannot present as unchanged continuity |
| Fork isolation | branch-private memory never leaks to sibling branch |
| Merge safety | protected/core conflict never silently last-write-wins |
| Recall honesty | unavailable/unsupported evidence produces abstention rather than invented provenance |
| Effect linkage | consequential memory-dependent warrants reference the exact recorded context-use lineage |

## 21. Definition of Done for V1

- Contracts compile under strict TypeScript.
- Stable canonicalization/digest tests pass.
- Runtime validators enforce the authority boundary and identity/scope invariants.
- Persistence is additive and migration-safe.
- Consequential recall generates use receipts.
- Immaculate independently validates current authority.
- Forget/correction/quarantine have evidence receipts.
- JAWS exposes inspectable continuity/memory provenance.
- Crucible threat corpus passes its release gates.
- CI passes in each modified repository.
- Public/product claims accurately distinguish implemented behavior, tested behavior, and future design.

## 22. Research-informed design notes

The threat model is informed by current work on long-term agent memory, provenance-preserving/citation-locked retrieval, cryptographically authorized memory mutation, provenance laundering through memory consolidation, and authorization laundering through persistent memory. External designs are treated as benchmarks and threat evidence, not copied implementations.

Arobi's differentiating architecture remains its own combination of persistent familiar continuity, provenance-preserving mutation, independent authority evaluation, governed effects, closure evidence, and Crucible validation.