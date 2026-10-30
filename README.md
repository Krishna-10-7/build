# SentinelQA

Turns a ticket's acceptance criteria into Playwright tests, runs them, and repairs broken locators, without letting a repair hide a real regression.

INNOVISTA · PS-08.

## The problem with self-healing tests

Self-healing tools find the element that "looks most like" the one that disappeared and carry on. That works when a button was renamed. It is dangerous when the button was replaced by a look-alike that does something else: the test goes green and the bug ships.

SentinelQA accepts a repair only when three gates pass:

| Gate | Question | How |
|---|---|---|
| 1. Spec | Did anyone change what the test checks? | Specs are generated from the contract and hash-locked; heals may only write `locators.json`. |
| 2. Effect | Does the repaired step do the same thing? | Each action's baseline effect (API calls, URL change, watched elements) must be reproduced. |
| 3. Criteria | Does the ticket still pass? | Every check from the acceptance criteria is re-run with the repair. |

The decisions themselves are not `if/else` in code. They are ordered rules in [`packages/core/src/policies`](packages/core/src/policies) (`heal.json`, `verdict.json`), checked by a small policy engine. Every ledger entry names the rule that fired, for example `heal@2 H2: same action, different effect`. The pipeline is a state machine ([`apps/server/src/pipeline.ts`](apps/server/src/pipeline.ts)), so compile, generate, baseline and check always happen in that order.

## How it works

```
Jira ticket ──► compile ──► contract.json ──► generate ──► SHOP-42.spec.ts (hash-locked)
 (webhook)      LLM or        steps, checks,                 + locators.json
                rule parser   element intents
                                   │
                                   ▼
                         baseline on the good build
                         fingerprints + step effects
                                   │
                                   ▼
            check a new build ──► locator broken? ──► L1 fingerprint score (L2 LLM tie-break)
                                                       │
                                                       ▼
                                   replay in sandbox ──► gates ──► heal policy ──► verdict policy
                                                                                      │
                     PASS · HEALED · NEEDS_REVIEW · REGRESSION · FLAKY · ERROR ◄───────┘
                     heal ledger, screenshots, review queue, Jira comment
```

- **Compile**: an LLM (any OpenAI-compatible endpoint; Groq, Gemini and OpenRouter presets) turns criteria into a schema-checked contract. Responses are cached by prompt hash. Without a key, a rule-based parser handles criteria written with quoted targets.
- **Ground and baseline**: on the known-good build each element key is matched to an element by its intent, and the run records fingerprints and per-step effects.
- **Heal**: weighted fingerprint features (role 0.20, accessible name 0.20, text 0.10, nearby label 0.10, landmarks 0.10, test id 0.10, tag/id/type/name/href 0.15, position 0.05). Below 0.55 nothing is proposed; a gap under 0.08 is a tie; 0.85 and above may be accepted if every gate passes. Everything else goes to the review queue.

## Layout

```
packages/core     contract, locator and ledger schemas; criteria compiler; policy engine and policies
packages/engine   browser runner, effect recorder, fingerprints, healer, gates, codegen
apps/shoplite     demo store with 12 drift and 8 regression mutations behind flags
apps/server       Fastify API, SQLite store, job queue, pipeline state machine, Jira
apps/dashboard    React dashboard: tickets, runs, heal ledger, review queue, benchmark, policies
bench             mutation benchmark across four healing modes
deploy            Dockerfile, compose and Caddy for the VM
```

## Run it locally

```bash
npm install
cp .env.example .env          # add LLM_API_KEY; set PW_CHANNEL=msedge or chrome to use an installed browser
npm run shoplite              # http://localhost:4100
npm run build && npm run server   # http://localhost:4200
```

Open the dashboard, pick SHOP-42 and press Compile, Generate, Record baseline, then Run with mutation flags (for example D1 + D4 for a heal, R4 for a look-alike that must be refused).

The generated spec is an ordinary Playwright test:

```bash
cd data/suites/SHOP-42 && TARGET_URL=http://localhost:4100 npx playwright test
```

## Benchmark

```bash
npm run bench                                   # 20 mutations x 4 modes
npm run bench -- --modes sentinel,plain --only D1,R4
```

Modes: no healing; a plain similarity healer (best match above 0.55, no gates); SentinelQA without the effect gate; SentinelQA. Results go to `bench/results/latest.json` and the dashboard's Benchmark page. A false heal is a repair the mode would write to `locators.json` while the app has a real regression.

First full run, 30 Oct 2026, on a laptop with 2 browser workers:

| Mode | Drifts handled | Auto-healed | Regressions caught | False heals | Heal accuracy |
|---|---|---|---|---|---|
| No healing | 8/12 | 0/12 | 8/8 | 0/8 | — |
| Plain similarity healer | 12/12 | 4/12 | 6/8 | 2/8 | 61% |
| SentinelQA without effect gate | 12/12 | 2/12 | 7/8 | 1/8 | 90% |
| SentinelQA | 12/12 | 2/12 | 8/8 | 0/8 | 100% |

Eight of the twelve drifts did not break the grounded locators at all (test ids and role locators survive class, wrapper and position changes). D2 and D9 go to review instead of auto-healing: a fill step has no effect of its own to verify, and the checkout icon scores 0.81, below the 0.85 line. The plain healer's false heals are R1 (a removed button patched to "Add to wishlist") and R4, where it patches the cart badge to the wishlist badge and AC-1 passes.

## The office: two agents, one ticket

`/office/` is a 3D office where two agents work the same ticket on the same build, live:

- **Fixer** works the way AI test healers usually do: when a test fails it sends the error, the page and the test to an LLM, applies the edit and reruns until green. It can change what the test checks.
- **Sentinel** is SentinelQA: it may only repair locators, and only when the spec, effect and criteria gates pass.

Each desk's monitor streams the agent's real browser (Chromium screencast) and its laptop shows the agent's terminal; click either for a full-size view. The scoreboard reveals the ground truth when both are done. On the "cart total ignores quantity" scenario the Fixer rewrote the expected total from ₹698 to ₹349 and reported 3/3 green; Sentinel failed the build with a regression on AC-2.

Builds under test: a ShopLite scenario, a public URL, or a branch of a repository listed by the operator in `ARENA_REPOS_FILE`. Requests can only choose a registry id and branch, never a repository URL or command, and private addresses are refused. Anyone can watch; starting an episode needs `ARENA_TOKEN` when it is set.

```bash
npm run shoplite & npm run build && npm run server   # then open http://localhost:4200/office/
```

## Deploy on the VM

Without Docker (how r2-d2.xyz/sentinel runs): `deploy/vm/install.sh` installs a release under /opt/sentinelqa with two systemd units, secrets in /etc/sentinelqa/sentinelqa.env, and `deploy/vm/caddy-snippet.txt` routes /sentinel/ to it.

With Docker:

```bash
cp .env.example .env    # keys stay on the VM, never in git
SITE=sentinel.example.com docker compose -f deploy/docker-compose.yml up -d --build
```

The Jira automation rule (issue transitioned to "Ready for QA") calls `https://<site>/webhooks/jira?secret=<JIRA_WEBHOOK_SECRET>`.

## Tests

```bash
npm test
```
