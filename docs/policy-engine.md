# SentinelQA Policy Engine — Research Notes

**Why we moved every heal and verdict decision out of `if/else` and into versioned rulebooks, how the engine works, what we borrowed from prior art, and what the evidence says.**

Project: INNOVISTA 36-hour hackathon, PS-08 "SentinelQA"
Repository: <https://github.com/Krishna-10-7/build> — every code link below is a permalink to commit [`c5cf1e4`](https://github.com/Krishna-10-7/build/commit/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0), so line numbers stay correct even after new commits.

---

## Contents

1. [The question we had to answer](#1-the-question-we-had-to-answer)
2. [Why plain if/else was the wrong tool](#2-why-plain-ifelse-was-the-wrong-tool)
3. [Prior art we studied](#3-prior-art-we-studied)
4. [Design requirements we derived](#4-design-requirements-we-derived)
5. [How the engine works](#5-how-the-engine-works)
6. [Rulebook 1: `heal@2` — accept, review or refuse a repair](#6-rulebook-1-heal2--accept-review-or-refuse-a-repair)
7. [Rulebook 2: `verdict@1` — the verdict for one acceptance criterion](#7-rulebook-2-verdict1--the-verdict-for-one-acceptance-criterion)
8. [How the pipeline feeds the engine](#8-how-the-pipeline-feeds-the-engine)
9. [Where every decision is visible](#9-where-every-decision-is-visible)
10. [Verification: unit tests](#10-verification-unit-tests)
11. [Analysis: exhaustive enumeration of both rulebooks](#11-analysis-exhaustive-enumeration-of-both-rulebooks)
12. [Evidence: the mutation benchmark](#12-evidence-the-mutation-benchmark)
13. [Limitations we know about](#13-limitations-we-know-about)
14. [Future work](#14-future-work)
15. [File index (reference links)](#15-file-index-reference-links)
16. [External references](#16-external-references)
17. [Appendix: reproduce the enumeration](#appendix-reproduce-the-enumeration)

---

## 1. The question we had to answer

SentinelQA runs a ticket's acceptance criteria as Playwright tests. When a locator breaks, the healer finds a replacement candidate and replays the step. That leaves two decisions, made thousands of times:

1. **Heal decision:** should this proposed repair be **accepted** (written to `locators.json`), sent for human **review**, or **refused**?
2. **Verdict decision:** given everything that happened in a criterion's run, is the criterion **PASS**, **HEALED**, **NEEDS_REVIEW**, **REGRESSION**, **FLAKY** or **ERROR**?

These decisions are the product. A wrong "accept" turns a real bug into a green build. That is the failure mode SentinelQA exists to prevent. So the way they are made has to be:

- **correct**: the safe outcome wins whenever evidence conflicts;
- **explainable**: every outcome can say *which* rule produced it and *why*;
- **auditable later**: a verdict from last week can be explained against the rules that were in force last week;
- **changeable without a code change**: a QA lead can tighten a rule without touching TypeScript.

## 2. Why plain if/else was the wrong tool

The first version of the decision logic was nested conditionals inside the checking code. We moved away from it for five concrete reasons.

| Problem with `if/else` | What it means for a QA verdict |
|---|---|
| **Order is implicit.** Priority is buried in nesting depth and the order of `else if` branches. | The single most important property ("a refusal beats a retry", "an infrastructure crash says nothing about the feature") is invisible and easy to break in a refactor. |
| **No identity for a decision.** A branch has no name. | The ledger can say *what* was decided but not *why*. "REGRESSION" is less useful than "REGRESSION by `verdict@1 V3`: a repair was refused by a gate". |
| **Silent defaults.** A missing or mistyped field is `undefined`, and `undefined === false` is `false`. The code falls through to some branch. | A bug in fact-gathering quietly changes verdicts instead of failing loudly. |
| **No versioning.** The logic changes whenever the file changes. | You can't tell which logic produced an old result, or diff two versions of the logic as policy. |
| **Logic and evidence are tangled.** Gathering facts (did the effect match?) and judging them (is that a regression?) live in the same function. | Neither can be tested alone, and an ablation ("what if Gate 2 didn't exist?") means editing the judging code. |

There was also a hackathon-specific reason. The PS-08 guidelines ask teams to *show real behaviour, not hardcoded results* and to *log every repair*. A decision layer that is data, has named rules and is served by an API is the most direct way to show both.

## 3. Prior art we studied

We looked at the main families of rule and policy engines and borrowed specific ideas from each. We didn't adopt any of them wholesale.

| System | What it is | What we borrowed | Why we didn't adopt it directly |
|---|---|---|---|
| **Open Policy Agent (OPA) / Rego** | General-purpose policy engine; policies written in a Datalog-inspired language and evaluated against JSON input. | **Policy as data, decoupled from the application.** The app gathers *input facts*; the policy returns a *decision*. Also the idea of serving the active policy over an API. | A separate runtime or WASM build plus a new language, for about 17 rules. Rego's strength (querying large documents) isn't needed when inputs are about 8 scalar facts. |
| **AWS Cedar** | Authorization language with formally analysable semantics; `forbid` overrides `permit`. | **Deny overrides allow:** refusal rules are ordered before acceptance rules in both rulebooks. Also **validation against a schema** before evaluation, and the value of a language small enough to analyse (see [section 11](#11-analysis-exhaustive-enumeration-of-both-rulebooks)). | Cedar is shaped around principal, action and resource authorization with a binary allow/deny result. We need 3-way and 6-way decisions. |
| **XACML 3.0** | OASIS standard for attribute-based access control, with explicit *rule-combining algorithms*. | **The `first-applicable` combining algorithm:** rules are tried in order and the first that applies decides. That is exactly our evaluation semantics. | Heavyweight XML standard. We kept only the combining-algorithm idea. |
| **DMN decision tables** (OMG standard) | Business-readable decision tables with a declared *hit policy*. | **Hit policy `FIRST`** and **the table as the user interface**: the dashboard renders each policy as a When / Then / Why table. Also declaring the allowed outputs up front (our `decisions` list). | Needs a DMN modeler and runtime. Our tables are small enough to keep as JSON. |
| **json-rules-engine** (npm) | JSON-defined rules with `all` / `any` / `not` conditions and fact operators. | **The condition grammar:** `all`, `any`, `not`, and leaf `{ fact, operator, value }`. Our leaves use `eq`, `ne`, `in`, `gt`, `gte`, `lt`. | It evaluates every rule and fires an event for each match, with priorities for ordering, and is async. We wanted one synchronous, pure function returning exactly one named decision, with closed-world validation of facts and outcomes (below). |
| **Drools / Rete-style production systems** | Forward-chaining inference over working memory (Forgy's Rete algorithm). | Nothing directly. The comparison helped us see that we need classification, not inference: no rule produces facts for another rule. | JVM-based, stateful, and its conflict resolution is hard to reason about. Overkill and harder to audit. |
| **Fowler, "Rules Engine"** (bliki) | A practitioner's warning that rule engines become hard to follow when rules chain and interact. | **Keep it deliberately small:** no chaining, no rule-generated facts, no custom functions. Ordered first-match only. | — (a guideline, not a tool) |

**Outcome:** a roughly 140-line in-house engine in [`packages/core/src/policy.ts`](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/packages/core/src/policy.ts). It combines OPA's decoupling, Cedar's deny-first ordering and schema validation, XACML's first-applicable semantics, DMN's declared outputs and table form, and json-rules-engine's condition grammar.

## 4. Design requirements we derived

From sections 1–3, the engine must:

- **R1 — Ordered, first-match semantics.** Exactly one rule decides. Its position in the list is its priority, so reading the file top to bottom *is* reading the priority.
- **R2 — Named rules.** Every rule has an `id` and a human `description`. Every decision returns both, plus the policy label.
- **R3 — Explicit fallback.** A mandatory `otherwise` rule with its own id. The fallback must be the *safe* outcome (review), never "accept".
- **R4 — Closed world of facts.** A policy declares every fact it reads, with a type. At evaluation, a missing or wrongly typed fact is an **error**, never a silent `false`.
- **R5 — Closed world of decisions.** A policy declares its possible outcomes. A rule that returns anything else is rejected **when the policy loads**, not when it first fires.
- **R6 — Versioned and fingerprinted.** `name@version` appears in every ledger entry. A SHA-256 of the normalized policy is exposed, so you can tell when the content behind a label changed.
- **R7 — Pure and deterministic.** No I/O, no clock, no randomness, no LLM. The same facts always give the same decision.
- **R8 — Replaceable without a rebuild.** An operator can point the service at a different policy folder.
- **R9 — Small enough to analyse exhaustively.** Facts are booleans, small enums and counts, so the whole input space can be enumerated (see [section 11](#11-analysis-exhaustive-enumeration-of-both-rulebooks)).

## 5. How the engine works

Source: [`packages/core/src/policy.ts`](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/packages/core/src/policy.ts)

### 5.1 Policy document shape

Validated with Zod in [`PolicySchema`, policy.ts L40](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/packages/core/src/policy.ts#L40):

```jsonc
{
  "name": "heal",
  "version": 2,
  "description": "…",
  "facts":     { "specOk": "boolean", "tier": "string", … },   // R4: the closed set of inputs, typed
  "decisions": ["accepted", "review", "refused"],               // R5: the closed set of outputs
  "rules": [                                                    // R1: order = priority
    { "id": "H1", "description": "…", "when": { "fact": "specOk", "eq": false }, "then": "refused" }
  ],
  "otherwise": { "id": "H9", "description": "…", "then": "review" } // R3: safe fallback
}
```

### 5.2 Condition grammar

Defined in `ConditionSchema` (same file). It is recursive and deliberately tiny:

| Form | Meaning |
|---|---|
| `{ "all": [c1, c2, …] }` | every sub-condition holds |
| `{ "any": [c1, c2, …] }` | at least one holds |
| `{ "not": c }` | negation |
| `{ "fact": "x", "eq": v }` | `x === v` (also `ne`, `in: [...]`, `gt`, `gte`, `lt`) |

Every object is `.strict()`, so a typo such as `"eqq"` fails validation instead of being ignored.

### 5.3 Load-time checks

Implemented in the [`PolicyEngine` constructor, L91](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/packages/core/src/policy.ts#L91). When a policy is loaded, the engine:

1. parses it against `PolicySchema`;
2. checks that every rule's `then`, and `otherwise.then`, is one of the declared `decisions` (R5);
3. walks every condition tree with [`factsUsed`, L69](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/packages/core/src/policy.ts#L69) and rejects any fact that isn't declared (R4);
4. computes a SHA-256 of the parsed policy ([L106](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/packages/core/src/policy.ts#L106)) and the label `name@version` (R6).

A broken policy therefore stops the service at startup. It can't half-work in production.

### 5.4 Evaluation

Implemented in [`evaluate`, L114](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/packages/core/src/policy.ts#L114).

```ts
evaluate(facts) {
  for each declared fact: typeof facts[name] must equal its declared type, else throw   // R4
  hit = first rule whose `when` holds, else `otherwise`                                  // R1, R3
  return { decision: hit.then, rule: hit.id, description: hit.description, policy: "heal@2" } // R2
}
```

The condition evaluator, [`holds`, L77](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/packages/core/src/policy.ts#L77), is pure recursion over the tree, so evaluation is linear in the size of the policy. Both shipped policies together are 17 rules.

### 5.5 Loading and overriding

[`policies()`, L128](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/packages/core/src/policy.ts#L128) loads the two built-in rulebooks once and caches them. If `POLICY_DIR` is set, `heal.json` and `verdict.json` are read from that folder instead (R8). This lets an operator run a stricter or looser policy without rebuilding.

## 6. Rulebook 1: `heal@2` — accept, review or refuse a repair

File: [`packages/core/src/policies/heal.json`](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/packages/core/src/policies/heal.json)

### 6.1 Facts

| Fact | Type | Produced by |
|---|---|---|
| `mode` | string | Run configuration: `plain`, `no-effect` or `sentinel` (`none` never proposes repairs) |
| `tier` | string | Healer: `auto` if top score ≥ 0.85 and not a tie, else `review` ([heal.ts L77](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/packages/engine/src/heal.ts#L77); thresholds in [score.ts L18–22](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/packages/engine/src/score.ts#L18)) |
| `kind` | string | What the step does with the element: `click`, `fill` or `read` |
| `specOk` | boolean | **Gate 1:** the generated spec and contract hashes are unchanged |
| `effectOk` | boolean | **Gate 2:** the repaired action caused the same effect as on the baseline |
| `effectUnverifiable` | boolean | Gate 2 couldn't decide: the baseline recorded no observable effect for the step |
| `criteriaOk` | boolean | **Gate 3:** all of the criterion's checks pass with the repair in place |
| `siblingRefused` | boolean | Another repair in the same criterion run was refused (see 6.3) |

### 6.2 Rules, in priority order

| # | Rule | When | Then | Why it sits here |
|---|---|---|---|---|
| 1 | **H0** | `mode = plain` | accepted | Benchmark baseline: a typical similarity healer applies its best match with no gates. It has to come first so the comparison mode is unaffected by the gates. |
| 2 | **H1** | `specOk = false` | refused | **Tamper beats everything.** If the spec or contract changed, no other evidence from the run can be trusted. |
| 3 | **H2** | `mode = sentinel` ∧ `effectOk = false` ∧ `effectUnverifiable = false` | refused | **The core idea.** Same action, different effect means the candidate is a look-alike that does something else. It sits above H3 on purpose: a look-alike is refused *even if the checks pass* (asserted by a unit test). |
| 4 | **H3** | `criteriaOk = false` | refused | The ticket's checks fail with the repaired locator. |
| 5 | **H3b** | `siblingRefused = true` | refused | Added in **v2**. Another repair in the same run was refused, so this repair was judged on a run that had already gone wrong. Accepting it would be accepting evidence from a corrupted run. |
| 6 | **H4** | `mode = sentinel` ∧ `effectUnverifiable = true` | review | The step had no observable effect on the baseline, so Gate 2 can't vouch for the repair. **Placed before H6 so that even a 0.99-score match can't be auto-accepted when it's unverifiable.** |
| 7 | **H5** | `tier = review` | review | Score below 0.85, or within 0.08 of the runner-up. Similarity alone isn't confident enough. |
| 8 | **H6** | `tier = auto` | accepted | High-confidence match and every gate passed. This is the only route to "accepted" in Sentinel mode, and it is the last rule. |
| — | **H9** (otherwise) | nothing matched | review | **Fail safe:** when in doubt, a person decides. Never a default accept. |

**Design principle visible in the order:** *refuse → review → accept*, as in Cedar's "forbid overrides permit". Every refusal reason is tried before any acceptance reason, and acceptance is the narrowest region of the input space ([section 11](#11-analysis-exhaustive-enumeration-of-both-rulebooks) puts a number on it).

### 6.3 The two-pass "sibling taint" (why `heal@2` exists)

In [`check.ts`, L97–115](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/packages/engine/src/check.ts#L97) the heal policy runs **twice** per criterion:

1. **First pass:** every proposed repair is evaluated on its own ([L110](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/packages/engine/src/check.ts#L110)).
2. **Second pass:** for each repair, if *any other* repair in the same run was refused in pass one, the repair is re-evaluated with `siblingRefused = true`, which triggers H3b.

**Why:** when several locators break at once (e.g. benchmark mutation R4, where test ids are renamed *and* two button labels are swapped), one wrong repair can make the later steps "work" on the wrong page state. Without the taint, the other repairs could be accepted on the strength of a run we already know went wrong. We found this gap while building the mutation benchmark. Rule H3b and the version bump from `heal@1` to `heal@2` landed in the benchmark commit [`d518601`](https://github.com/Krishna-10-7/build/commit/d518601).

Keeping it as a fact plus a rule, rather than a special case in code, means the taint shows up in the ledger as `heal@2 H3b` with its own explanation.

## 7. Rulebook 2: `verdict@1` — the verdict for one acceptance criterion

File: [`packages/core/src/policies/verdict.json`](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/packages/core/src/policies/verdict.json)

### 7.1 Facts

| Fact | Type | Meaning |
|---|---|---|
| `mode` | string | Healing mode of the run |
| `runOk` | boolean | All checks passed (with any accepted repairs applied) |
| `failureKind` | string | `none`, `action`, `expect`, `navigation` or `crash` (from [runner.ts](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/packages/engine/src/runner.ts#L214)) |
| `heals` | number | Repairs proposed in this criterion |
| `refused` | number | Repairs the heal policy refused |
| `review` | number | Repairs the heal policy sent to review |
| `drift` | boolean | Checks pass, but a step that kept its own locator now causes a different effect than on the baseline ([`behaviourDrift`, check.ts L55](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/packages/engine/src/check.ts#L55)) |
| `retriedOk` | boolean | A failing criterion passed on one unchanged retry, with no healing ([check.ts L137–140](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/packages/engine/src/check.ts#L137)) |

### 7.2 Rules, in priority order

| # | Rule | When | Then | Why it sits here |
|---|---|---|---|---|
| 1 | **V1** | `failureKind ∈ {navigation, crash}` | ERROR | The app couldn't be opened or the browser died. That says **nothing about the feature**, so it must not be reported as a regression or a pass. It comes first because no other fact from a crashed run is meaningful. |
| 2 | **V2** | `mode = plain` ∧ `heals > 0` ∧ `runOk` | HEALED | Plain-mode baseline behaviour, for the benchmark only. |
| 3 | **V3** | `refused > 0` | REGRESSION | **A gate refused a repair**, so the app changed behaviour, not just markup. This sits *above* V4 on purpose: a refusal is positive evidence of a bug and **must never be excused as flakiness**. |
| 4 | **V4** | `runOk = false` ∧ `retriedOk = true` | FLAKY | Failed, then passed on an unchanged retry. Reported honestly as FLAKY, never as PASS. |
| 5 | **V5** | `runOk = false` | REGRESSION | A check failed, an action failed, or a target is gone with no credible replacement. |
| 6 | **V6** | `review > 0` | NEEDS_REVIEW | A repair is waiting for a person. The criterion isn't green until someone approves. |
| 7 | **V7** | `drift = true` | NEEDS_REVIEW | **Silent behaviour change.** The checks pass, but an *un-healed* step now makes different API calls or navigates differently. Plain tools would report PASS. |
| 8 | **V8** | `heals > 0` | HEALED | Every repair passed every gate and the checks pass. |
| — | **V0** (otherwise) | nothing matched | PASS | Checks pass with the existing locators. Reaching PASS means every negative rule above was considered and none applied. |

**Ordering principle:** *infrastructure → evidence of a bug → flakiness → plain failure → needs a human → green.* Each step down is a weaker claim. The engine only reaches a green verdict after every stronger claim has been ruled out.

## 8. How the pipeline feeds the engine

The engine only *judges*. Gathering evidence is a separate concern in [`packages/engine/src/check.ts`](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/packages/engine/src/check.ts):

```
run criterion in a real browser
  └─ locator breaks → healer scores candidates → proposal {tier, candidate}
gates (evidence):
  Gate 1  specGate          spec + contract hashes unchanged          → specOk
  Gate 2  effectGate (L44)  repaired action's effect == baseline's    → effectOk, effectUnverifiable
  Gate 3  criteriaGate      every check passes                        → criteriaOk
heal policy  (pass 1, then pass 2 with siblingRefused)  → accepted / review / refused   + rule id
verdict policy (L145)  counts + run outcome + drift + retry          → verdict           + rule id
```

Key separation: **gates produce facts; policies produce decisions.** This made the benchmark ablation trivial. `no-effect` mode doesn't edit any rule; it just doesn't compute Gate 2 ([L99](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/packages/engine/src/check.ts#L99)). Because H2 and H4 are conditioned on `mode = sentinel`, the same rulebook serves all four modes ([modes documented at check.ts L8–14](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/packages/engine/src/check.ts#L8)).

The pipeline that wraps all of this is itself declared as data: a state machine of stages and allowed transitions in [`apps/server/src/pipeline.ts`](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/apps/server/src/pipeline.ts#L6).

## 9. Where every decision is visible

A rule id is only useful if people can see it. Every decision carries `"<policy>@<version> <rule>"` (e.g. `heal@2 H2`, `verdict@1 V3`) to every surface:

| Surface | What it shows | Link |
|---|---|---|
| **Ledger (SQLite)** | `results.rule` and `heals.rule` columns are `NOT NULL`, so no decision is stored without its rule | [db.ts L34, L45](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/apps/server/src/db.ts#L34), insert at [L182–187](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/apps/server/src/db.ts#L182) |
| **Policies API** | `GET /api/policies` returns both rulebooks with their SHA-256, plus the pipeline stages and transitions | [main.ts L309](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/apps/server/src/main.ts#L309) |
| **Console "Policies" page** | Each policy rendered as a When / Then / Why table, with "first match decides" stated | [Insights.tsx L87](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/apps/dashboard/src/pages/Insights.tsx#L87) |
| **GitHub Check Run** | Per-criterion table row: `**REGRESSION** (verdict@1 V3)` | [github.ts L511](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/apps/server/src/github.ts#L511) |
| **MCP / CLI for agents** | Every criterion and heal returned with its rule; CLI prints `rule verdict@1 V5` | [agent.ts L163, L220](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/apps/server/src/agent.ts#L163) |
| **3D arena terminal** | Live per-repair log: three gate ticks, then `→ refused (heal@2 H2)` | [arena/sentinel.ts L25–34](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/apps/server/src/arena/sentinel.ts#L25) |
| **Benchmark report** | Every cell records the verdict rule per criterion | [bench/published.json](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/bench/published.json) |

## 10. Verification: unit tests

File: [`packages/core/test/core.test.ts`](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/packages/core/test/core.test.ts#L48). These run in `npm test`, which passes 37/37.

| Test | What it proves |
|---|---|
| [`policy engine: first matching rule wins and is named` (L61)](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/packages/core/test/core.test.ts#L61) | R1, R2, R3: ordering, the returned rule id and label, and the `otherwise` fallback |
| [`policy engine refuses missing facts and undeclared decisions` (L68)](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/packages/core/test/core.test.ts#L68) | R4, R5: a missing fact throws; an undeclared decision or undeclared fact is rejected at load time |
| [`shipped heal policy: a look-alike with a different effect is refused even when checks pass` (L77)](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/packages/core/test/core.test.ts#L77) | H2 beats passing checks; H3b sibling taint; H4 unverifiable → review; plain mode (H0) accepts the same look-alike |
| [`shipped verdict policy orders refusals before retries and reviews` (L88)](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/packages/core/test/core.test.ts#L88) | V0, V8, V3 over V6, V4, V1 and V7 behave in the documented order |

## 11. Analysis: exhaustive enumeration of both rulebooks

Because every fact is a boolean, a small enum or a small count (requirement R9), we can run **every combination** of inputs through the real shipped policies. This is the same idea that makes Cedar policies analysable. The script is in the [appendix](#appendix-reproduce-the-enumeration). Results on `heal@2` (sha256 `16d9b039d619…`) and `verdict@1` (sha256 `2be8a140e8fb…`):

**`heal@2`:** 576 combinations (mode × tier × kind × 5 booleans).

| Rule → decision | Combinations | Share |
|---|---|---|
| H0 → accepted (plain mode only) | 192 | 33.3% |
| H1 → refused | 192 | 33.3% |
| H3 → refused | 84 | 14.6% |
| H3b → refused | 42 | 7.3% |
| H2 → refused | 24 | 4.2% |
| H5 → review | 15 | 2.6% |
| H6 → accepted | 15 | 2.6% |
| H4 → review | 12 | 2.1% |
| H9 (otherwise) | 0 | — |

**`verdict@1`:** 1,920 combinations (4 modes × runOk × 5 failure kinds × heals 0–2 × refused 0–1 × review 0–1 × drift × retriedOk).

| Rule → decision | Combinations |
|---|---|
| V1 → ERROR | 768 |
| V3 → REGRESSION | 528 |
| V4 → FLAKY | 144 |
| V5 → REGRESSION | 144 |
| V6 → NEEDS_REVIEW | 120 |
| V2 → HEALED | 96 |
| V7 → NEEDS_REVIEW | 60 |
| V8 → HEALED | 36 |
| V0 → PASS | 24 |

**What this tells us:**

1. **Every named rule is reachable.** No rule is fully shadowed by the rules above it, so no dead rules shipped.
2. **Acceptance is the narrowest region.** Outside plain mode, only **15 of 384** heal-fact combinations (3.9%) end in "accepted". There is exactly one path in Sentinel mode: spec intact, effect verified and matching, checks pass, no sibling refused, high-confidence tier. In plain mode, every combination is accepted. That contrast is the whole thesis of SentinelQA, expressed as a property of the policy.
3. **Green is the narrowest verdict.** PASS is reachable from only 24 of 1,920 combinations, and HEALED by V8 from 36. Everything ambiguous falls towards REGRESSION, NEEDS_REVIEW, FLAKY or ERROR.
4. **The fallback H9 is unreachable for valid tiers**, because H5 and H6 cover both values of `tier`. It is a guard for a future tier value (e.g. a new `"llm"` tier), which would then go to review instead of being accepted by accident.
5. **Caveat:** enumeration covers the cartesian domain, including some states the runner never produces (e.g. `runOk = false` with `failureKind = none`). The figures describe the policy's shape, not real-world frequencies.

## 12. Evidence: the mutation benchmark

Runner: [`bench/run.ts`](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/bench/run.ts); published data: [`bench/published.json`](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/bench/published.json).

- **Setup:** 20 switchable mutations of the ShopLite store, run against ticket SHOP-42 in 4 modes using the same suite and baseline.
  - 12 are **drifts**: markup changes with the same behaviour.
  - 8 are **regressions**: real bugs.
- **Definition of a false heal** ([`classify`, run.ts L74](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/bench/run.ts#L74)): on a buggy build, the mode *accepts at least one repair*, meaning it would write a wrong locator to `locators.json`. This is stricter than looking at the verdict alone. A run can be red today while silently poisoning the locator map so that the *next* run goes green.

| Mode | Drifts handled | Bugs caught | False heals | Heal accuracy (accepted repairs that were on drifts) |
|---|---|---|---|---|
| `none`: no healing | 8 / 12 | 8 / 8 | 0 | — |
| `plain`: H0 / V2, similarity only | 12 / 12 | 6 / 8 | **2** (R1, R4) | 61% |
| `no-effect`: Sentinel without Gate 2 | 12 / 12 | 7 / 8 | **1** (R4) | 90% |
| `sentinel`: full policies | 12 / 12 | **8 / 8** | **0** | **100%** |

**The rules that made the difference, read from the ledger:**

- **R1, "Add to cart button removed":**
  - Plain mode accepted 3 repairs (H0) onto other buttons. The verdict was red (`verdict@1 V5`), but the locator map was poisoned.
  - Sentinel refused the repairs, and every criterion is `REGRESSION` by `verdict@1 V3`: a gate refused a repair.
- **R4, "test ids renamed and Add to cart / Add to wishlist labels swapped":**
  - Plain mode reported AC-1 as **HEALED** (`V2`).
  - `no-effect` accepted a repair and left AC-1 at `NEEDS_REVIEW` (`V6`).
  - Only full Sentinel turned all three criteria into `REGRESSION` by `V3` with zero accepted repairs. This is the case Gate 2 (rule H2) and the sibling taint (H3b) exist for.
- **R5, "cart total ignores quantity":** caught by `V5` in every mode, because the locators never broke. This is the bug an LLM test-fixer "fixes" by rewriting ₹698 to ₹349. The hash-locked spec (Gate 1, rule H1) is what makes that rewrite impossible here.
- **D12, "test id renamed and a similar decoy button added":** Sentinel healed all three criteria (`V8`, 3 accepted repairs) without being fooled by the decoy.

The difference between `no-effect` and `sentinel` is a **single fact** reaching the policy. That is direct evidence that the behavioural gate, judged by a named rule, is what removes the last false heal.

## 13. Limitations we know about

Stated plainly, so nobody discovers them in Q&A first:

1. **Thresholds live in code, not in the policy.** The 0.55 / 0.08 / 0.85 scores ([score.ts L18–22](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/packages/engine/src/score.ts#L18)) are turned into the `tier` fact before the policy sees it. A QA lead can't tune them in JSON yet.
2. **The ledger stores the label, not the hash.** Entries say `heal@2 H2`. If someone edits a policy without bumping `version`, the label stays the same while the content changes. The SHA-256 is exposed by `/api/policies` but not yet written per run.
3. **Declared but unused facts aren't flagged.** `kind` is declared in `heal@2` but no rule reads it yet; it is reserved for stricter rules on `click` steps. The loader checks *undeclared* facts but not *unused* ones.
4. **A leaf condition with no operator holds vacuously.** `{ "fact": "x" }` passes schema validation and always matches. Harmless today, since no shipped rule does this, but the loader should reject it.
5. **No conflict or overlap report.** First-match makes overlaps legal and well-defined. Still, a reviewer would benefit from seeing "rule X is partially shadowed by rule Y". Today that comes only from the enumeration in [section 11](#11-analysis-exhaustive-enumeration-of-both-rulebooks), which is not built into the tool.
6. **Policies are global.** One rulebook per deployment (or per `POLICY_DIR`), not per tenant or per repository.
7. **The benchmark is our own app.** 20 mutations of ShopLite, not historical bugs from open-source projects.

## 14. Future work

Ordered by value:

1. **Policy lockfile.** Write the policy SHA-256 into every run row. Refuse to start if a policy's content changed but its `version` did not.
2. **Policy diff by enumeration.** Since the input space is small, show *exactly which fact combinations change outcome* between two versions. Example: "heal@2 → heal@3: 42 combinations move from accepted to refused." That turns a policy change into a reviewable pull request with a precise blast radius.
3. **Shadow evaluation.** Run a candidate policy alongside the live one on real runs and report disagreements before switching.
4. **Move thresholds into the policy.** Pass `score` and `gap` as numeric facts so rules like `{ "fact": "score", "gte": 0.85 }` live in JSON. Then *learn* those thresholds from human review decisions (approve/reject in the review queue).
5. **Per-tenant and per-repo policies**, e.g. a payments repo can demand review for every repair (`H6 → review`).
6. **Static checks in the loader:** reject operator-less leaves, warn on unused facts, report shadowed rules.
7. **Benchmark on real bug history** from open-source web apps, to measure the rules beyond our own store.

## 15. File index (reference links)

All links are pinned to commit `c5cf1e4`.

| Purpose | File |
|---|---|
| Policy engine (schema, load-time checks, evaluation, loader) | [packages/core/src/policy.ts](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/packages/core/src/policy.ts) |
| Heal rulebook `heal@2` | [packages/core/src/policies/heal.json](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/packages/core/src/policies/heal.json) |
| Verdict rulebook `verdict@1` | [packages/core/src/policies/verdict.json](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/packages/core/src/policies/verdict.json) |
| Gates → facts → policies (two-pass heal, verdict) | [packages/engine/src/check.ts](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/packages/engine/src/check.ts) |
| Heal proposal and `tier` | [packages/engine/src/heal.ts](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/packages/engine/src/heal.ts) |
| Score thresholds | [packages/engine/src/score.ts](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/packages/engine/src/score.ts) |
| Effect comparison (Gate 2) | [packages/engine/src/effects.ts](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/packages/engine/src/effects.ts) |
| Failure kinds | [packages/engine/src/runner.ts](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/packages/engine/src/runner.ts) |
| Pipeline state machine | [apps/server/src/pipeline.ts](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/apps/server/src/pipeline.ts) |
| Ledger schema (rule columns) | [apps/server/src/db.ts](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/apps/server/src/db.ts) |
| `GET /api/policies` | [apps/server/src/main.ts#L309](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/apps/server/src/main.ts#L309) |
| Console Policies page | [apps/dashboard/src/pages/Insights.tsx](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/apps/dashboard/src/pages/Insights.tsx) |
| GitHub check table with rule ids | [apps/server/src/github.ts#L511](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/apps/server/src/github.ts#L511) |
| Agent API / MCP output with rule ids | [apps/server/src/agent.ts](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/apps/server/src/agent.ts) |
| Arena live gate log | [apps/server/src/arena/sentinel.ts](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/apps/server/src/arena/sentinel.ts) |
| Unit tests | [packages/core/test/core.test.ts](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/packages/core/test/core.test.ts) |
| Benchmark runner and data | [bench/run.ts](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/bench/run.ts), [bench/published.json](https://github.com/Krishna-10-7/build/blob/c5cf1e4aca524e12e5cb0d70e65c5c78cfccaaa0/bench/published.json) |
| Commit that introduced the policy engine | [`442a519` — sentinel gates, verdicts and flaky retry driven by a rule-based policy engine](https://github.com/Krishna-10-7/build/commit/442a519) |
| Live policies on the deployed site | <https://r2-d2.xyz/sentinel/api/policies> |

## 16. External references

**Policy and rule engines**

- Open Policy Agent, *Policy Language (Rego)*: <https://www.openpolicyagent.org/docs/latest/policy-language/>
- Cedar policy language: <https://www.cedarpolicy.com/>
  - Cutler et al., *Cedar: A New Language for Expressive, Fast, Safe, and Analyzable Authorization*, OOPSLA 2024: <https://dl.acm.org/doi/10.1145/3649835>
- OASIS, *eXtensible Access Control Markup Language (XACML) Version 3.0* (rule-combining algorithms, `first-applicable`): <https://docs.oasis-open.org/xacml/3.0/xacml-3.0-core-spec-os-en.html>
- OMG, *Decision Model and Notation (DMN)*: <https://www.omg.org/dmn/>
  - Hit policies explained (Camunda docs): <https://docs.camunda.io/docs/components/modeler/dmn/decision-table-hit-policy/>
- json-rules-engine: <https://github.com/CacheControl/json-rules-engine>
- Drools rule engine: <https://www.drools.org/>
- C. L. Forgy, *Rete: A fast algorithm for the many pattern/many object pattern match problem*, Artificial Intelligence 19(1), 1982: <https://doi.org/10.1016/0004-3702(82)90020-0>
- Martin Fowler, *Rules Engine*: <https://martinfowler.com/bliki/RulesEngine.html>

**Testing context**

- Google Testing Blog, *Flaky Tests at Google and How We Mitigate Them*: <https://testing.googleblog.com/2016/05/flaky-tests-at-google-and-how-we.html>
- Healenium, an open-source self-healing library for Selenium (the similarity-healer approach our `plain` mode stands in for): <https://github.com/healenium/healenium-web>
- Playwright locators: <https://playwright.dev/docs/locators>

**Validation**

- Zod (schema validation used for policies): <https://zod.dev>

---

## Appendix: reproduce the enumeration

Save as `scripts/enum-policies.ts` in the repository root and run `npx tsx scripts/enum-policies.ts`:

```ts
import { policies } from '../packages/core/src/index.ts';

const { heal, verdict } = policies();
const B = [false, true];
const tally = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

const h = new Map<string, number>();
for (const mode of ['plain', 'no-effect', 'sentinel']) for (const tier of ['auto', 'review']) for (const kind of ['click', 'fill', 'read'])
  for (const specOk of B) for (const effectOk of B) for (const effectUnverifiable of B) for (const criteriaOk of B) for (const siblingRefused of B) {
    const d = heal.evaluate({ mode, tier, kind, specOk, effectOk, effectUnverifiable, criteriaOk, siblingRefused });
    tally(h, `${d.rule} -> ${d.decision}`);
  }
console.log('heal', heal.label, heal.sha256.slice(0, 12), Object.fromEntries(h));

const v = new Map<string, number>();
for (const mode of ['none', 'plain', 'no-effect', 'sentinel']) for (const runOk of B) for (const failureKind of ['none', 'action', 'expect', 'navigation', 'crash'])
  for (const heals of [0, 1, 2]) for (const refused of [0, 1]) for (const review of [0, 1]) for (const drift of B) for (const retriedOk of B) {
    const d = verdict.evaluate({ mode, runOk, failureKind, heals, refused, review, drift, retriedOk });
    tally(v, `${d.rule} -> ${d.decision}`);
  }
console.log('verdict', verdict.label, verdict.sha256.slice(0, 12), Object.fromEntries(v));
```
