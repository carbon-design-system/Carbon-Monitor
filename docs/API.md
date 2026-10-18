# API

The REST API and operator console share one Node process and one port.

## API server and console

```bash
npm run build:client   # build the console once
npm run api            # http://localhost:3000
```

Serves the operator console and the REST API on one port (`PORT`, then
`API_PORT`, default `3000`). Code Engine injects `PORT`, and exposes a single
port per app, which is why both share one.

| Method | Path                         | Description                                                                                                                    |
| ------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `GET`  | `/api/health`                | Liveness check — always open                                                                                                   |
| `GET`  | `/api/ready`                 | Readiness check — always open; see [Readiness](#readiness)                                                                     |
| `GET`  | `/api/auth/status`           | Whether sign-in is required and satisfied — always open                                                                        |
| `POST` | `/api/auth/login` / `logout` | Session sign-in — always open                                                                                                  |
| `GET`  | `/api/mcp/callback`          | OAuth redirect target — guarded by one-shot `state` + PKCE                                                                     |
| `GET`  | `/api/status`                | All dependency checks (the agent CLI, its cost tile, Carbon MCP, GitHub, Elasticsearch); see [Agent and cost](#agent-and-cost) |
| `GET`  | `/api/config`                | Current configuration (sanitised — never returns credentials), including the agent's name                                      |
| `GET`  | `/api/mcp/status`            | Carbon MCP connection detail                                                                                                   |
| `POST` | `/api/mcp/connect`           | Begin the IBMid OAuth bootstrap                                                                                                |
| `POST` | `/api/mcp/refresh`           | Force a refresh, or store a pasted token / session id                                                                          |
| `POST` | `/api/mcp/test`              | Live probe — also repairs a session-backed connection                                                                          |
| `POST` | `/api/mcp/disconnect`        | Forget the stored OAuth state and strip Bob's MCP headers                                                                      |
| `GET`  | `/api/credits`               | The agent's balance or budget and its spend summary, in Bobcoins or USD                                                        |
| `GET`  | `/api/credits/history`       | Per-review spend in the agent's unit, plus a cumulative series                                                                 |
| `POST` | `/api/review/trigger`        | Trigger a review (202, runs in the background) — see [Triggering a review over HTTP](#triggering-a-review-over-http)           |
| `GET`  | `/api/review/status`         | Current or most recent run: mode, PR numbers, reviews in flight and queued                                                     |
| `GET`  | `/api/review/logs`           | Incremental log tail (`?since=` cursor, `?limit=` up to 1000, default 500, `?pr=` / `?worker=` filters); returns `nextSince`   |
| `POST` | `/api/review/logs/clear`     | Empty the log buffer; allowed mid-run, returns the number of lines `cleared`                                                   |
| `GET`  | `/api/schedule`              | Scheduled-run config (`enabled`, `timeLocal`, `paused`) with the computed `nextRunAt`                                          |
| `POST` | `/api/schedule`              | Save a partial schedule update; `400` with a message on invalid input                                                          |

`POST /api/mcp/disconnect` is the inverse of **Sign in with IBMid**: it deletes
the stored refresh token and removes the `Authorization` / `X-MCP-Session`
headers from `~/.bob/settings/mcp.json`, so the next review genuinely runs with
no Carbon MCP credential. It is idempotent — disconnecting an already
disconnected server still returns `{ "success": true, "disconnected": true }`.
Reconnecting costs a browser round trip through IBMid, which is why the console
asks for confirmation first.

**Authentication follows `AUTH_REQUIRED`.** `deploy_ce.sh` defaults it to
`true`, so a deployed console is protected. A local run without the variable set
is open: every route above answers without a credential. When it is on,
everything except the always-open routes needs either a session cookie or
`Authorization: Bearer <API_SECRET>`. See
[Console sign-in](ARCHITECTURE.md#5-authentication-model).

```bash
API_PORT=3000
API_SECRET=your_secure_api_secret_here   # bearer token for CI / curl
API_ENABLE_AUTH=true                     # only has effect when AUTH_REQUIRED=true
```

`GET /api/credits` and `GET /api/credits/history` read different stores: the
history comes from the ledger file, the balance from a per-process cache. Reviews
write the ledger from their own process, so the server re-reads the balance
whenever a ledger entry is newer than the balance it holds. That keeps the
headline and the table from contradicting each other while the 30-second poll
from open tabs stays cheap. (That re-read applies to Bob's gateway balance. A
Claude budget status is cached for 60 seconds.)

### Agent and cost

The agent is `GITHUB_AI_AGENT_CLI`, `bob` or `claude`. Four endpoints show it.

**`GET /api/config`** returns `agent` (the configured id, `bob` when unset),
`agentName` (`IBM Bob` or `Claude`, the name used in PR comments and in the
console's "Reviewing pull requests in … with …" sentence) and `agentCli`
(`Bob Shell CLI` or `Claude Code CLI`), with the owner, repository and limits.

**`GET /api/status`** returns `{ success, checks, overall, timestamp }`. Each
check is `{ id, label, status, detail, hint }`, where `status` is `succeeded`,
`caution-major`, `failed` or `unknown`. The tiles:

| `id`                                    | `label`                                            | Shown when                          | What it says                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------- | -------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agent`                                 | The CLI's name: `Bob Shell CLI`, `Claude Code CLI` | always                              | `v<version> — API key configured` when the binary runs and the key is set. `failed` with `Not found on PATH`, or with `v<version> — not authenticated` and a hint naming the missing key (`BOB_API_KEY`, `ANTHROPIC_API_KEY`). `caution-major` when `--version` is slow (`BOB_CHECK_TIMEOUT_MS`)                                                                   |
| `bobcoins`                              | `Bobcoins`                                         | the agent is `bob`                  | The gateway balance: `<remaining> of <limit> remaining`, a warning below `BOB_CREDITS_LOW_PCT`                                                                                                                                                                                                                                                                     |
| `spend`                                 | `Spend`                                            | the agent is not Bob (Claude today) | `$<n> spent this month`, or `$<n> spent this month of $<budget>` with `CLAUDE_MONTHLY_BUDGET_USD` set. The hint reads `No monthly budget set (CLAUDE_MONTHLY_BUDGET_USD).` without a budget, and `<n>% remaining.` with one, as a warning below `CLAUDE_BUDGET_LOW_PCT` and `failed` at zero. It starts `From the local ledger.` when Elasticsearch gave no figure |
| `carbon-mcp`, `github`, `elasticsearch` |                                                    | always                              | Unchanged                                                                                                                                                                                                                                                                                                                                                          |

The agent tile's `id` was `bob` before agents became pluggable; it is `agent` for
both.

**`GET /api/credits`** returns `{ success, balance, summary, timestamp }`.
`summary.costUnit` is `bobcoins` or `usd`, and every total in `summary`
(`totalSpent`, `averagePerReview`, `last24hSpent`, `last7dSpent`) is in that
unit and counts only the configured agent's reviews. For Bob, `balance` is the
gateway balance. For Claude, `balance` is:

- `{ "available": false, "low": false, "reason": "not-metered" }` without
  `CLAUDE_MONTHLY_BUDGET_USD`;
- `{ available: true, low, threshold, remaining, percentRemaining, reason: null,
summary, spent, budget }` with it, where `spent` is the month so far in USD and
  `low` is `percentRemaining` under `CLAUDE_BUDGET_LOW_PCT`;
- `{ "available": false, "low": false, "reason": "<message>" }` if the figure
  could not be computed.

**`GET /api/credits/history`** returns only entries in the agent's unit, so a
deployment that switched agents does not mix dollars into Bobcoins. An entry
carries `costUnit` when it has one (rows written before units existed have none
and read as Bobcoins), and `cumulative` is a running total in the same unit.
From Elasticsearch the entries come from `pr_review_completed` events of the
last 90 days, filtered on the root `agent` field.

**Telemetry.** `pr_review_completed` carries `cost_unit` (`bobcoins` or `usd`).
`coinsSpent` keeps its name and is in that unit. `bob_task_id` holds the agent's
session or task id, which for Claude is its session id. `token_source` is the
agent id when the counts are exact and `estimate` otherwise.

### Reviews in flight

`REVIEW_CONCURRENCY` (default `2`, see
[CONFIGURATION.md](CONFIGURATION.md#1-environment-variables)) sets how many
reviews of one batch run at once. Batches stay single-flight: a second trigger
still gets `409`.

- `GET /api/review/status` adds `inFlight` (`[{ worker, pr, startedAt }]`, one per
  running review), `queued` (`[pr]`, PRs not yet started, in list order) and
  `concurrency`. Both lists are empty when no batch runs. The `202` from
  `POST /api/review/trigger` also reports `concurrency`.
- `GET /api/review/logs` returns each line as `{ seq, at, stream, text }`, plus
  `worker` and `pr` when a review wrote it. `text` starts with `[agent 1 #1234] ` for
  such a line and `[batch] ` for a line outside any review. `?pr=<n>` and
  `?worker=<n>` return only that review's lines (unfiltered by default); the
  `nextSince` cursor works the same either way.

### Readiness

`GET /api/ready` is what Code Engine's readiness probe calls (`deploy_ce.sh`
sets it). It answers `200 {"ready": true}` when the process can run reviews at
all: `GITHUB_AI_AGENT_CLI` names a supported agent and that agent's binary runs
(the answer is cached and refreshed in the background, so a probe never waits on the agent after the first check). Otherwise it answers
`503 {"ready": false, "reasons": [...]}`. The reasons name the agent id:
`Invalid GITHUB_AI_AGENT_CLI: codex. Must be one of: bob, claude` for an unknown
agent, and `Agent CLI 'claude' is not available on PATH` for a missing binary.

A missing credential, Elasticsearch or Carbon MCP never fails readiness, so a
half-configured instance stays reachable and the console can show what to fix.
They come back as `warnings` on the `200`, for example
`{"ready": true, "warnings": ["GITHUB_AI_AGENT_TOKEN is not set: ..."]}`. The
agent's own key is one of them, named for the agent selected:
`ANTHROPIC_API_KEY is not set: the claude CLI cannot authenticate in a container`.
`/api/health` stays the cheap liveness check and is used for the liveness probe.

### Sign-in throttle

After five failed `POST /api/auth/login` attempts from one address within 15
minutes, that address gets `429` with a `Retry-After` header (60 seconds at
most; `retryAfter` is also in the body) instead of a credential check. Attempts
during a lockout do not extend it. A successful sign-in resets the count. The
throttle is in memory, per instance, and bounded.

The address is the `X-Forwarded-For` entry `TRUSTED_PROXY_HOPS` from the end
(default `1`, the last entry); the first entry when the header is shorter than
the hop count; the socket address only when the header is absent. Earlier
entries are client-supplied and ignored. If the last entry is
a proxy shared by every user, raise `TRUSTED_PROXY_HOPS`; see
[CONFIGURATION.md](CONFIGURATION.md#5-sign-in-throttle-and-proxies).

### Triggering a review over HTTP

Examples use `$BASE`. Set it once to whichever instance you are driving:

```bash
# Local
BASE=http://localhost:3000

# Deployed (IBM Cloud Code Engine)
BASE=https://<app>.<project-id>.<region>.codeengine.appdomain.cloud   # printed at the end of ./deploy_ce.sh
```

**Review one specific PR** — copy, paste, change the number:

```bash
curl -X POST "$BASE/api/review/trigger" -H "Content-Type: application/json" -d '{"prNumbers":[22971]}'
```

**Check on it** — the trigger returns `202` immediately and runs in the
background, so the outcome is polled, not awaited:

```bash
curl "$BASE/api/review/status"
```

**Review the most recent PRs instead** — no body at all:

```bash
curl -X POST "$BASE/api/review/trigger"
```

> Each of these posts **real** inline comments, a summary comment and the
> `AIReviewed` label to the pull requests, publicly. The last one does it to
> every PR that passes the auto-select filter — up to `GITHUB_AI_AGENT_MAX_PRS`
> of them.

The rest of this section covers the full contract: every accepted body shape,
the validation rules, and the error responses.

`POST /api/review/trigger` starts a **real** review. It reads live open PRs from
the configured repository, runs the selected agent against them, and posts public inline and
summary comments on each one, then labels them. There is no dry-run mode — every
command below writes to GitHub.

Two things follow from that, and both are deliberate:

- **The call is asynchronous.** It returns `202` the moment the run is accepted
  and does the work in the background. A review takes minutes, far longer than
  Code Engine's 300-second request ceiling, so there is nothing useful to wait
  on — the HTTP request would time out long before the review finished. Poll
  `GET /api/review/status` for the outcome.
- **Auth is off for a local run with `AUTH_REQUIRED` unset**, so the commands
  below work as written there. A deployed instance defaults it to `true`
  (`deploy_ce.sh`), so against the deployment URL add
  `-H "Authorization: Bearer $API_SECRET"` to every call — see **With
  authentication on** at the end of this section.

**1. Auto mode — no body**

```bash
curl -X POST "$BASE/api/review/trigger"
```

An empty body, or no body at all, means auto mode: exactly what `npm start`
does. Carbon Monitor selects up to `GITHUB_AI_AGENT_MAX_PRS` (default `10`) of
the most recent open PRs created within `GITHUB_AI_AGENT_DAYS_BACK` days
(default `21`), excluding drafts, bot authors, and PRs already carrying the
`GITHUB_AI_AGENT_REVIEW_LABEL` label. Every PR that survives that filter gets
real comments posted on it. On the deployed URL with sign-in off, this is an
unauthenticated public write to the repo — the command is one keystroke, the
consequences are not.

```json
{
  "success": true,
  "message": "Review triggered, running in background",
  "startedAt": "2026-08-08T14:22:03.118Z",
  "mode": "auto",
  "prNumbers": null,
  "maxPRs": 5,
  "daysBack": 21
}
```

**2. Explicit list — JSON array**

```bash
curl -X POST "$BASE/api/review/trigger" \
  -H 'Content-Type: application/json' \
  -d '{"prNumbers": [22971, 22972]}'
```

Explicit PRs bypass every filter, the same way `--pr` does on the CLI (see
[Quick start](../README.md#quick-start)). A draft, a six-month-old PR, or
one already labelled `AIReviewed` is reviewed anyway — and a PR that was already
reviewed receives a second set of comments.

```json
{
  "success": true,
  "message": "Review triggered for 2 PRs, running in background",
  "startedAt": "2026-08-08T14:22:03.118Z",
  "mode": "explicit",
  "prNumbers": [22971, 22972],
  "maxPRs": 5
}
```

`daysBack` is absent in explicit mode because no age filter was applied.
`maxPRs` is still reported — it is the ceiling the list was validated against.

**3. Explicit list — comma-separated string**

```bash
curl -X POST "$BASE/api/review/trigger" \
  -H 'Content-Type: application/json' \
  -d '{"prNumbers": "22971, 22972"}'
```

Identical semantics to the array form, for callers that would rather not build
JSON arrays — a shell variable, a form field, a scheduler's text box.
Surrounding whitespace is ignored.

**4. A single PR**

```bash
curl -X POST "$BASE/api/review/trigger" \
  -H 'Content-Type: application/json' \
  -d '{"prNumbers": "22971"}'
```

The HTTP equivalent of `node src/index.js --pr 22971`. `{"prNumbers": [22971]}`
does the same thing.

> **Precedence.** An explicit `prNumbers` in the request body wins over
> `GITHUB_AI_AGENT_PR_NUMBER` / `--pr`, which in turn wins over auto-selection.
> So on a container started with `GITHUB_AI_AGENT_PR_NUMBER=12345`, a body-less
> trigger reviews PR 12345, and a trigger carrying `prNumbers` reviews the PRs
> you named instead.

**5. Polling for the outcome**

```bash
curl "$BASE/api/review/status"
```

While the run is in flight:

```json
{
  "success": true,
  "running": true,
  "startedAt": "2026-08-08T14:22:03.118Z",
  "finishedAt": null,
  "error": null,
  "mode": "explicit",
  "prNumbers": [22971, 22972, 22980],
  "inFlight": [
    { "worker": 1, "pr": 22971, "startedAt": "2026-08-08T14:22:04.020Z" },
    { "worker": 2, "pr": 22972, "startedAt": "2026-08-08T14:22:04.021Z" }
  ],
  "queued": [22980],
  "concurrency": 2,
  "timestamp": "2026-08-08T14:24:41.902Z"
}
```

After it finishes:

```json
{
  "success": true,
  "running": false,
  "startedAt": "2026-08-08T14:22:03.118Z",
  "finishedAt": "2026-08-08T14:31:57.640Z",
  "error": null,
  "mode": "auto",
  "prNumbers": null,
  "inFlight": [],
  "queued": [],
  "concurrency": 2,
  "timestamp": "2026-08-08T14:32:10.005Z"
}
```

`mode` and `prNumbers` describe the current run, or the most recent one once
`running` is `false` — which is how the console can say _what_ is being
reviewed, not merely that something is. `error` carries the message from a run
that threw, and is `null` on success.

A single PR that 404s does not abort the run: the failure is recorded and the
remaining PRs are still reviewed, so a typo in one number does not cost you the
others. Check the app log for which ones failed.

Status reports the run, not per-PR verdicts. The findings themselves land on the
PRs. To block a script on completion:

```bash
until curl -s "$BASE/api/review/status" | grep -q '"running": *false'; do sleep 30; done
```

(Responses are pretty-printed, so match `"running": false` with the space — or
pipe through `jq -e '.running == false'` and skip the guesswork.)

The console polls the same endpoint every 30 seconds.

**6. Validation errors (400)**

Explicit mode is validated before anything is fetched, and the message names the
value that caused the rejection:

| Body                                 | Rejected because                                               |
| ------------------------------------ | -------------------------------------------------------------- |
| `{"prNumbers": "abc"}`               | `abc` is not a number                                          |
| `{"prNumbers": [22971, 0]}`          | `0` is not a positive integer                                  |
| `{"prNumbers": [-5]}`                | negative                                                       |
| `{"prNumbers": [22971.5]}`           | not an integer                                                 |
| `{"prNumbers": [22971, null]}`       | `null` entry                                                   |
| `{"prNumbers": ", ,"}`               | a stray comma leaves an empty value                            |
| `{"prNumbers": 22971}`               | a bare number is neither an array nor a comma-separated string |
| `{"prNumbers": {"pr": 22971}}`       | an object is neither an array nor a string                     |
| more distinct numbers than the limit | more than `GITHUB_AI_AGENT_MAX_PRS` after de-duplication       |

`{"prNumbers": []}` and `{"prNumbers": ""}` are **not** errors — an absent list
means auto mode, and an empty one says the same thing. They return `202` with
`"mode": "auto"`.

Nothing is fetched and no comment is posted when validation fails.

A `400` uses the API's standard error envelope — note that this is **`error`**,
not the `success`/`message` pair the `202` and `409` responses use, so parse
accordingly:

```json
{
  "error": "Invalid PR number \"abc\" — must be a positive integer.",
  "timestamp": "2026-08-08T23:24:33.491Z"
}
```

```json
{
  "error": "Too many PRs: 11 requested, but at most 10 may be reviewed in one run (GITHUB_AI_AGENT_MAX_PRS).",
  "timestamp": "2026-08-08T23:24:33.491Z"
}
```

Duplicates are not an error. `[22971, 22971, 22972]` is de-duplicated to
`[22971, 22972]` with the original order preserved, and the limit is checked
_after_ de-duplication — so listing the same PR six times is fine, while six
distinct PRs is a `400` on the default configuration. Raise
`GITHUB_AI_AGENT_MAX_PRS` if you genuinely need a longer list; it governs both
modes. Malformed JSON, or a body over 256 KB, is also a `400`.

**7. Already running (409)**

```json
{
  "success": false,
  "message": "A review is already running",
  "startedAt": "2026-08-08T23:24:33.525Z",
  "mode": "auto",
  "prNumbers": null
}
```

Only one review session runs at a time. This is not a resource limit — it is there
because two agents reviewing the same PR would post the same findings twice:
duplicate inline comments on the same diff lines, and two summary comments. The
`409` carries the in-flight run's `startedAt`, `mode` and `prNumbers`, so a
caller can tell what is already running without a second request.

The guard is in-process, and the Code Engine app is pinned to a single instance
(`--max-scale 1`, for Carbon MCP's rotating refresh tokens), so one lock covers
the whole deployment.

**With authentication on**

When `AUTH_REQUIRED=true`, these routes answer `401` without a credential.
Browsers use the session cookie from the sign-in page; scripts and CI use the
bearer token:

```bash
curl -X POST "$BASE/api/review/trigger" \
  -H "Authorization: Bearer $API_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"prNumbers": "22971, 22972"}'

curl "$BASE/api/review/status" -H "Authorization: Bearer $API_SECRET"
```

`API_SECRET` is the value in the deployment secret — see
[Console sign-in](ARCHITECTURE.md#5-authentication-model).

**From the console instead**

The **Reviews** tile carries a PR-list field that is the exact equivalent of the
explicit call: type `22971, 22972`, press **Run review now**, and the console
sends the same request. Leave the field empty for auto mode. It validates
against the rules above as you type, and the button stays disabled until the
list is valid, so a bad list is caught before it becomes a `400`.
