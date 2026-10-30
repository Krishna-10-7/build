# SentinelQA

Turns a ticket's acceptance criteria into Playwright tests, runs them, and repairs broken locators, without letting a repair hide a real regression.

Work in progress for INNOVISTA (PS-08).

## Layout

```
packages/core     contract, locator map and ledger schemas; criteria compiler
packages/engine   browser runner, fingerprints, healer, gates, codegen
apps/shoplite     demo store with switchable drift and regression mutations
apps/server       orchestrator API, run queue, SQLite store, Jira integration
apps/dashboard    React dashboard
bench             mutation benchmark
```

## Setup

```bash
npm install
cp .env.example .env
```
