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
apps/server       Fastify API, SQLite store, job queue, pipeline state machine, Jira, GitHub App, MCP
apps/dashboard    the control room (/console/): tickets, runs, heal ledger, review queue, benchmark, policies
apps/office       the 3D tower: lobby (/) and one office floor per project (/office/)
apps/cli          one-file CLI and stdio MCP bridge, and the guide for coding agents
bench             mutation benchmark across four healing modes
deploy            Dockerfile, compose and Caddy for the VM
```

## Run it locally

```bash
npm install
cp .env.example .env          # add LLM_API_KEY; set PW_CHANNEL=msedge or chrome to use an installed browser
npm run shoplite              # http://localhost:4100
npm run build && npm run server   # http://localhost:4200 (lobby), /console/ (control room)
```

Open the control room, pick SHOP-42 and press Compile, Generate, Record baseline, then Run with mutation flags (for example D1 + D4 for a heal, R4 for a look-alike that must be refused).

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

## The tower: a lobby and a floor per project

`/` is the ground floor of a small 3D tower: the reception (the ticket desk), a building directory, GitHub, Jira and agent access kiosks, the control room door (the dashboard at `/console/`) and a lift. Floor 1 is the shared ShopLite demo; every repository a person connects becomes one of their floors above it. Pick a floor in the lift and the doors close, count the floors and open on that project's office, `/office/?floor=<owner/repo>`. Each floor follows its own project: a push to that repository takes over its screens, runs on other floors do not. A quiet floor shows its last run. All floors share one queue, since every run drives real browsers.

## The office: two agents, one ticket

Each floor is a 3D office where two agents work the same ticket on the same build, live:

- **Fixer** works the way AI test healers usually do: when a test fails it sends the error, the page and the test to an LLM, applies the edit and reruns until green. It can change what the test checks.
- **Sentinel** is SentinelQA: it may only repair locators, and only when the spec, effect and criteria gates pass.

Each desk's monitor streams the agent's real browser (Chromium screencast) and its laptop shows the agent's terminal; click either for a full-size view. The scoreboard reveals the ground truth when both are done. On the "cart total ignores quantity" scenario the Fixer rewrote the expected total from ₹698 to ₹349 and reported 3/3 green; Sentinel failed the build with a regression on AC-2.

Builds under test: a ShopLite scenario, a public URL, a branch of a repository listed by the operator in `ARENA_REPOS_FILE`, or a commit of a repository someone connected. Anyone can watch the demo floor; starting a run needs a signed-in person, an API token or the presenter token.

```bash
npm run shoplite & npm run build && npm run server   # then open http://localhost:4200/office/
```

## Everyone gets their own floors

The tower is multi-user. Anyone signs in with GitHub; what they connect is theirs and only they see it.

- **One-time setup by the operator.** At the GitHub kiosk, *Create the GitHub App* (presenter token, or an operator listed in `OPERATOR_GITHUB_LOGINS`) sends GitHub a manifest for a **public** app: read code, write checks, receive pushes, sign people in. The app's key and OAuth secret come back to the server and are kept in `GITHUB_APP_FILE` (mode 600).
- **Sign in and install.** People sign in with GitHub and install the app on the repositories they choose. Each repository belongs to whoever connected it first and becomes one of their floors.
- **Every push gets a check.** A push is verified (`X-Hub-Signature-256`), queued, checked out at that commit, built and run inside the sandbox by both agents. It checks the ticket named in the branch (`SHOP-42-fix`) or commit message, else the floor's default ticket; with none it posts a neutral "No ticket" check. The commit gets a **SentinelQA** check: `failure` on a regression, `action_required` when a repair needs review, `success` when every criterion passes, `neutral` when it could not run. It links to the replay at `/office/?episode=<id>`.
- **Tickets.** At the reception desk people write tickets (title and `AC-1: Given … when … then …` lines) or import them from their own Jira; the demo tickets are samples anyone can use. The criteria live in the tower, not in the repository, so nothing pushed can change what is checked.
- **What each person sees.** Their floors, runs, replays, live screens, tickets, Jira connection and tokens; nobody else's. The live stream is filtered per viewer, and someone else's floor shows as private. The operator sees everyone and can block an account (People, in the lobby).
- **Fair use.** One run at a time (the VM has 2 CPUs), with turns going to whoever waited longest since their last one. Per person per day: `QUOTA_RUNS_PER_DAY` runs (25), `QUOTA_LLM_RUNS_PER_DAY` Fixer runs on the shared LLM key (15; none with their own key, saved encrypted), and `QUOTA_QUEUED` waiting (3).

An optional `sentinelqa.json` at the repository root sets how it is built and checked:

```json
{ "ticket": "SHOP-42", "install": "npm ci", "start": "npm start", "branches": ["main", "release"] }
```

Without it the server uses `npm install` and `npm start` and runs every branch. The app listens on `PORT`.

### The sandbox

Repositories are other people's code, so their install and start commands run in a **rootless Podman** container (`SANDBOX=podman`): only the checkout is mounted, the root filesystem is read-only, all capabilities are dropped, memory, CPU and process counts are limited (`SANDBOX_MEMORY`, `SANDBOX_CPUS`), the host's loopback is unreachable, and none of the server's environment goes in. Only the app's port is published, on loopback. Builds time out after `SANDBOX_INSTALL_SECONDS`, and checkouts are pruned to `ARENA_WORK_MAX_MB`.

Outside the container, an nftables table (`deploy/vm/egress.nft`) stops the `sentinelqa` user from reaching cloud metadata (DNS excepted), private networks and the local database and mail ports, and the agents' browsers are fenced to the app under test and the public web, for both HTTP and WebSockets. Jira tokens and LLM keys are sealed with AES-256-GCM (`SECRET_KEY`); API tokens and sessions are stored as hashes.

## Connect Jira: tickets run on their floor

Each person connects their own Jira Cloud site at the **Jira** kiosk with their Atlassian email and API token. The server checks them against Jira and keeps the token encrypted. They link their Jira projects to their floors, for example `SHOP → acme/shop`. Then:

1. **A ticket reaches "Ready for QA".** Their Jira automation rule (trigger *Issue transitioned* to Ready for QA, action *Send web request*, POST, body *Issue data (Jira format)*) calls their own address from the kiosk, which carries their secret. SentinelQA imports the ticket into their desk, compiles it and runs it on the latest commit of the repository's default branch. A ticket checked for the first time records its baseline on that build; if its criteria fail there, the run is red rather than baselined.
2. **A push names the ticket.** A push whose branch (`SHOP-42-cart-total`) or commit message (`SHOP-42: ...`) contains a key of a linked project checks that ticket, with its latest criteria from Jira.
3. **Results go back to Jira.** Every such run is posted on the ticket as a comment: the verdict, each criterion, where it ran, what an LLM test-fixer would have rewritten, and a link to the replay.

## Agent access: MCP, CLI and API tokens

Most code is now pushed by coding agents, so SentinelQA is a tool they can call. At the **Agent access** kiosk, signed-in people make API tokens (`sqa_...`) for their agents: `run` may start checks, `read` may only read results. A token acts as its owner, so an agent sees and runs only that person's floors. Only a SHA-256 of each token is stored, and tokens can be revoked there.

**MCP** (Streamable HTTP, stateless) at `/mcp`:

```bash
claude mcp add --transport http sentinelqa https://<host>/sentinel/mcp --header "Authorization: Bearer sqa_..."
```

Tools: `list_projects`, `run_check`, `commit_status` (the result of the check a push started), `get_result`, `get_acceptance_criteria`, `list_runs`. The server's instructions tell the agent what each verdict means, and that a regression is fixed in the application code, not in the test.

**CLI**: one file with no dependencies, served pointed at the server:

```bash
curl -fsSL https://<host>/sentinel/cli/sentinelqa.mjs -o sentinelqa.mjs
node sentinelqa.mjs login --token sqa_...          # saved to ~/.sentinelqa/config.json, mode 600
git push && node sentinelqa.mjs commit owner/repo "$(git rev-parse HEAD)"
node sentinelqa.mjs check demo --scenario qty-bug  # exit 1: regression caught
node sentinelqa.mjs mcp                            # stdio MCP for clients that only run local servers
```

Exit codes: 0 pass, 1 regression, 2 needs review, 3 inconclusive or still running, 4 usage or auth error. `/agents.md` is the same guide written for agents. The REST routes behind the CLI are under `/api/agent/`.

## Deploy on the VM

Without Docker (how r2-d2.xyz/sentinel runs): `deploy/vm/install.sh` installs a release under /opt/sentinelqa with two systemd units, secrets in /etc/sentinelqa/sentinelqa.env, and `deploy/vm/caddy-snippet.txt` routes /sentinel/ to it. `deploy/vm/sandbox-setup.sh` installs rootless Podman for the `sentinelqa` user (with its own systemd manager, so containers get their own cgroups), pulls the build image and loads the egress fence.

With Docker:

```bash
cp .env.example .env    # keys stay on the VM, never in git
SITE=sentinel.example.com docker compose -f deploy/docker-compose.yml up -d --build
```

Each person's Jira automation rule calls the address shown at their Jira kiosk.

## Tests

```bash
npm test
```
