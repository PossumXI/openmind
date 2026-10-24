# Familiar adapters (FMP v1.2)

Familiar adapters organize memory the way a brain organizes it, without a second memory system. Code: `src/familiar/adapters.ts`. Tests: `tests/shared/familiar-adapters.test.ts`.

The language model is not the brain. The brain decides what matters, where it belongs, how it changes and when it should inform reasoning; models are capabilities it calls. Adapters are the brain's organization of memory, and they stay the same whichever model is in use.

## What an adapter is

An adapter is a logical family of memory declared in a versioned registry. Every memory stays one canonical `FamiliarMemoryArtifactV1`. Which adapters it belongs to is computed by `assignFamiliarAdapters(memory, registry, { lineage, reliedUpon })` from:

- the artifact's class, trust, support state and scope;
- its lineage (the classes of its source artifacts);
- how often context-use receipts relied on it.

The highest-priority matching PRIMARY rule places the primary adapter. Every other adapter with a matching rule holds one association: an ASSOCIATION rule, or a PRIMARY rule that was outranked. Every membership names its rule. The same history always gives the same assignment.

| Family | Tier | Holds | Home of |
| --- | --- | --- | --- |
| Environmental | association | observations about the application, tool, runtime or situation | `EXTERNAL_OBSERVATION`; memory bound to an application or runtime |
| Project | association | a project's, repository's or brand's history, decisions and state | memory bound to a project, repository or brand |
| Episodic | association | what happened and the evidence it left | `EPISODIC`, `EVIDENCE`, `AUTHORITY_REFERENCE`; derived memory keeps a path to its episodes |
| Semantic | association | what is known | `RELATIONSHIP`; a corroborated `HYPOTHESIS` |
| Creative | association | ideas, designs, alternatives, kept however old | `HYPOTHESIS` |
| Autobiographical | limbic | approved identity and enduring preferences | `CORE`, `PREFERENCE` |
| Reflective | limbic | evaluations of earlier reasoning and outcomes; open conflicts | a `HYPOTHESIS` grounded in `EVIDENCE`; anything `CONTESTED` |
| Active Thought | executive | the live task's working state | memory bound to the task the turn runs in |
| Procedural | motor | methods, workflows and skills | `PROCEDURAL`, `SKILL` |

Lineage moves memory without the model choosing. An interpretation grounded in outcome evidence starts in Reflective, with associations to Episodic and Creative. Once corroborated, a PROMOTE revision with support `CORROBORATED`, it is routed through Semantic and keeps all three associations.

## The column

Every adapter has the same ports, after the six-layer cortical column:

| Layer | Port | Registry field |
| --- | --- | --- |
| IV | receptors: how strongly the turn's features excite it | `receptors.intents`, `receptors.channels` (`TOOLS`, `ENVIRONMENT`, `TASK`, `CONTENT`) |
| II/III | lateral links to peers in its tier | `pathways` of kind `LATERAL` |
| V | how many notes it contributes | `budget.maxNotes` |
| VI | feedback from outcomes | recorded against a route; changes weights only in a reviewed registry revision |
| I | modulation by novelty, reward, risk, urgency and salience | `modulation` |

## The settle

The turn (`FamiliarTurnV1`) carries:
- `intents`, the caller's deterministic classification of the turn;
- `tools` in play;
- the `environment` it runs in (scope bindings and observed facts);
- layer I `modulators` from 0 to 1;
- `now`.

Routing never reads a clock.

Receptors combine their channels as independent causes:

    r_i = 1 - prod_c (1 - w_ic * x_c)

Then a fixed number of synchronous passes (`settle.passes`, 1 to 4) runs, each reading the previous pass:

    a_i <- clamp( g_i * ( r_i + sum_j W_ff[j->i] a_j + sum_k W_lat[k<->i] a_k + sum_h W_fb[h->i] a_h ), 0, 1 )

- Feedforward pathways rise a tier, from association through limbic and executive to motor. Feedback pathways descend. Both are asymmetric.
- Lateral pathways join peers in one tier, with one weight both ways.
- The gain `g_i = clamp(1 + sum_m gamma_im * mod_m, 0, 2)` multiplies what the adapter receives. A modulator therefore cannot excite an adapter that nothing else excites, and it never touches trust.

The order adapters are listed in never changes the result.

## Routing: relevance, then admission

`routeFamiliarMemories` weighs each candidate within the adapters it belongs to:

    S(m|q) = w_s*semantic + w_g*graph + w_t*temporal + w_e*environment + w_p*provenance + w_u*utility
    score  = S(m|q) * (best pathway's activation) * (historicalFactor, for history on a forward-looking turn)

- `semantic` and `graph` come from the caller's own indexes, lexical or vector.
- `temporal` is the primary adapter's half-life decay. A family without one never decays, so age changes rank, never truth.
- `environment` comes from applicability.
- `provenance` is trust times support.
- `utility` saturates with reliance.

An association carries `associationFactor` of its adapter's activation. Active Thought carries a memory only while the turn runs in that memory's task.

A memory that is not current or does not apply here is a historical reference. On forward-looking turns it is down-weighted. On turns that look back (`RECALL`, `REVIEW`) it is weighed in full.

Each adapter contributes at most its budget, and the working set holds at most `maxNotes`.

The route is candidates. It has `admission: "NOT_EVALUATED"` and `mayAuthorize: false`, plus a digest (`familiarRouteDigest`) to record beside the context-use receipt of what it led to. `familiarAdapterRanker` plugs the route into `retrieveFamiliarMemories`, which runs every tenant, familiar, identity-epoch, support, trust and expiry filter first and refuses any result from outside that set. Admission stays with the context boundary and Immaculate (INV-FMP-011).

## Applicability and validity

A memory's optional `scope` (FMP v1.2) holds:
- environment bindings, at most one per kind: `PROJECT`, `REPOSITORY`, `APPLICATION`, `RUNTIME`, `BRAND`, `TASK`;
- digest-pinned dependencies observed with it;
- `observedAt`.

Against the turn's environment, the memory's applicability is:

| Applicability | When |
| --- | --- |
| `MATCH` | every binding and dependency is observed and equal |
| `PARTIAL` | nothing conflicts, but something cannot be observed now |
| `CONFLICT` | a dependency's value changed since (validity `NEEDS_REVALIDATION`) |
| `OUT_OF_SCOPE` | bound to a different project, repository, application, runtime or brand |
| `UNSCOPED` | no scope; applies wherever its tenant and familiar do |

A task binding never excludes a memory. It only decides membership of the live working set.

## Revising the registry

`assertFamiliarAdapterRegistryV1` refuses a revision that:
- leaves a memory class without an unconditional PRIMARY rule (assignment must be total);
- breaks a pathway direction;
- repeats a pathway;
- has weights that do not sum to one;
- has anything else malformed.

`FAMILIAR_ADAPTER_REGISTRY_V1_DIGEST` pins the default registry. A revision changes it, and the change is reviewed with the code that uses it. The starting weights are uncalibrated defaults. Calibration is by evaluation (retrieval precision and recall, adapter selection, stale and out-of-scope resistance, conflict detection, policy compliance) across more than one underlying model, in reviewed revisions. Nothing here learns silently.

These adapters organize explicit memory. Trainable adapters that change model weights are a separate, later mechanism, and they never silently absorb memories: a fact held in weights cannot be forgotten on request or traced to its source.
