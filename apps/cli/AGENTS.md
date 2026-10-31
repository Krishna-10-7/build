# SentinelQA for coding agents

SentinelQA checks a build of an app against the acceptance criteria of its tickets, in a real browser. When the UI changes it repairs broken locators on its own, but it never changes what a test checks. That makes it a check an agent cannot talk its way past: a green result means the app still does what the ticket asks.

Server: __SENTINELQA_URL__

## Get a token

Ask the person you are working for to make an API token (`sqa_...`): they sign in with GitHub at __SENTINELQA_URL__ and open Agent access. The token acts as them: you see and run only their floors. A `run` token can start checks; a `read` token can only read results.

## Connect over MCP

Claude Code:

```bash
claude mcp add --transport http sentinelqa __SENTINELQA_URL__mcp --header "Authorization: Bearer $SENTINELQA_TOKEN"
```

Any client that speaks Streamable HTTP can use `__SENTINELQA_URL__mcp` with that header. For clients that only run stdio servers, use the CLI as a bridge: command `node sentinelqa.mjs mcp`, with `SENTINELQA_TOKEN` set.

Tools:

| Tool | What it does |
|---|---|
| `list_projects` | The demo and every connected GitHub repository, with the latest verdict |
| `run_check` | Check the latest commit of a branch (or a demo scenario) and wait for the verdicts |
| `commit_status` | The result of the check your `git push` started, by repository and SHA |
| `get_result` | Verdicts of a run by id |
| `get_acceptance_criteria` | What is being checked, before you change it |
| `list_runs` | Recent runs |

## Or use the CLI

```bash
curl -fsSL __SENTINELQA_URL__cli/sentinelqa.mjs -o sentinelqa.mjs
node sentinelqa.mjs login --token sqa_...
git push && node sentinelqa.mjs commit owner/repo "$(git rev-parse HEAD)"
```

Exit codes: `0` pass, `1` regression, `2` needs review, `3` inconclusive or still running, `4` usage or auth error. `--json` prints everything.

## Reading verdicts

| Verdict | Meaning | What to do |
|---|---|---|
| `PASS` | The criterion holds | Nothing |
| `HEALED` | A locator broke after a UI change; SentinelQA repaired it and every gate passed | Nothing |
| `REGRESSION` | The app no longer does what the ticket asks | Fix the application code |
| `NEEDS_REVIEW` | A repair was not certain enough to accept alone | Ask a person |
| `ERROR`, `FLAKY` | Inconclusive | Run again |

Do not try to turn a `REGRESSION` green by changing tests or expected values. The checks are compiled from the ticket and kept on the SentinelQA server, locked by hash; nothing in your repository changes them.

Every run can be watched live, or replayed, in the office: the link is in each result.
