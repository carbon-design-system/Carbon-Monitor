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

| Method | Path                         | Description                                                                                                                                    |
| ------ | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/api/health`                | Liveness check — always open                                                                                                                   |
| `GET`  | `/api/ready`                 | Readiness check — always open; see [Readiness](#readiness)                                                                                     |
| `GET`  | `/api/auth/status`           | Whether sign-in is required and satisfied — always open                                                                                        |
| `POST` | `/api/auth/login` / `logout` | Session sign-in — always open                                                                                                                  |
| `GET`  | `/api/mcp/callback`          | OAuth redirect target — guarded by one-shot `state` + PKCE                                                                                     |
| `GET`  | `/api/status`                | All dependency checks (the agent CLI, its cost tile, Carbon MCP, GitHub, Elasticsearch); see [Agent and cost](#agent-and-cost)                 |
| `GET`  | `/api/config`                | Current configuration (sanitised — never returns credentials): the agent's name, `owner`, `repos` and the per-repository limits                |
| `GET`  | `/api/mcp/status`            | Carbon MCP connection detail                                                                                                                   |
| `POST` | `/api/mcp/connect`           | Begin the IBMid OAuth bootstrap                                                                                                                |
| `POST` | `/api/mcp/refresh`           | Force a refresh, or store a pasted token / session id                                                                                          |
| `POST` | `/api/mcp/test`              | Live probe — also repairs a session-backed connection                                                                                          |
| `POST` | `/api/mcp/disconnect`        | Forget the stored OAuth state and strip Bob's MCP headers                                                                                      |
| `GET`  | `/api/credits`               | The agent's balance or budget and its spend summary, in Bobcoins or USD                                                                        |
| `GET`  | `/api/credits/history`       | Per-review spend in the agent's unit, plus a cumulative series                                                                                 |
| `POST` | `/api/review/resolve`        | Find which configured repository each typed PR number belongs to; changes nothing — see [Finding a PR's repository](#finding-a-prs-repository) |
| `POST` | `/api/review/trigger`        | Trigger a review (202, runs in the background) — see [Triggering a review over HTTP](#triggering-a-review-over-http)                           |
| `GET`  | `/api/review/status`         | Current or most recent run: mode, PRs (`repo` and `number`), reviews in flight and queued                                                      |
| `GET`  | `/api/review/logs`           | Incremental log tail (`?since=` cursor, `?limit=` up to 1000, default 500, `?repo=` / `?pr=` / `?worker=` filters); returns `nextSince`        |
| `POST` | `/api/review/logs/clear`     | Empty the log buffer; allowed mid-run, returns the number of lines `cleared`                                                                   |
| `GET`  | `/api/schedule`              | Scheduled-run config (`enabled`, `timeLocal`, `paused`) with the computed `nextRunAt`                                                          |
| `POST` | `/api/schedule`              | Save a partial schedule update; `400` with a message on invalid input                                                                          |

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
(`Bob Shell CLI` or `Claude Code CLI`), with the owner, the repositories and the
limits:

```json
{
  "success": true,
  "config": {
    "agent": "bob",
    "agentName": "IBM Bob",
    "agentCli": "Bob Shell CLI",
    "owner": "carbon-design-system",
    "repos": ["carbon", "carbon-ai-chat"],
    "label": "AIReviewed",
    "maxPRs": 10,
    "daysBack": 21,
    "targetPR": null,
    "postInlineComments": true,
    "postSummaryComment": true,
    "carbonMcpUrl": "…",
    "elasticsearchConfigured": true,
    "elasticsearchHost": "…"
  },
  "timestamp": "2026-11-04T15:00:00.000Z"
}
```

`repos` lists repository names in batch order (`GITHUB_AI_AGENT_REPOS`; a single
`GITHUB_AI_AGENT_REPO` gives a one-entry list), all under `owner`. The old `repo`
field is gone. `maxPRs` and `daysBack` apply to **each repository**, not to the
run. `targetPR` is `GITHUB_AI_AGENT_PR_NUMBER` as set, so it may read
`carbon-ai-chat#1204`.

**`GET /api/status`** returns `{ success, checks, overall, timestamp }`. Each
check is `{ id, label, status, detail, hint }`, where `status` is `succeeded`,
`caution-major`, `failed` or `unknown`. The tiles:

| `id`                          | `label`                                            | Shown when                          | What it says                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------- | -------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agent`                       | The CLI's name: `Bob Shell CLI`, `Claude Code CLI` | always                              | `v<version> — API key configured` when the binary runs and the key is set. `failed` with `Not found on PATH`, or with `v<version> — not authenticated` and a hint naming the missing key (`BOB_API_KEY`, `ANTHROPIC_API_KEY`). `caution-major` when `--version` is slow (`BOB_CHECK_TIMEOUT_MS`)                                                                   |
| `profiles`                    | `Review profiles`                                  | always                              | `<repo>: <profile>` for every configured repository (`carbon: core, carbon-ai-chat: caic`). `failed`, with the error as the detail, when a repository's profile cannot run with the configured agent, for example `carbon-ai-chat` with Claude (the caic profile runs on Bob only).                                                                                |
| `bobcoins`                    | `Bobcoins`                                         | the agent is `bob`                  | The gateway balance: `<remaining> of <limit> remaining`, a warning below `BOB_CREDITS_LOW_PCT`                                                                                                                                                                                                                                                                     |
| `spend`                       | `Spend`                                            | the agent is not Bob (Claude today) | `$<n> spent this month`, or `$<n> spent this month of $<budget>` with `CLAUDE_MONTHLY_BUDGET_USD` set. The hint reads `No monthly budget set (CLAUDE_MONTHLY_BUDGET_USD).` without a budget, and `<n>% remaining.` with one, as a warning below `CLAUDE_BUDGET_LOW_PCT` and `failed` at zero. It starts `From the local ledger.` when Elasticsearch gave no figure |
| `github`                      | `GitHub`                                           | always                              | Probes every repository in `GITHUB_AI_AGENT_REPOS` at once. All reachable: the quota, with the hint `Monitoring carbon, carbon-ai-chat`. Otherwise `failed` naming the first failing repository in list order, for example `carbon-ai-chat: 404 (token cannot see this repository)`.                                                                               |
| `carbon-mcp`, `elasticsearch` |                                                    | always                              | Unchanged                                                                                                                                                                                                                                                                                                                                                          |

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

- `GET /api/review/status` adds `inFlight` (`[{ worker, repo, pr, startedAt }]`,
  one per running review), `queued` (`["carbon#22980"]`, the `repo#number` keys of
  PRs not yet started, in batch order) and `concurrency`. Both lists are empty when no batch runs. The `202` from
  `POST /api/review/trigger` also reports `concurrency`.
- `GET /api/review/logs` returns each line as `{ seq, at, stream, text }`, plus
  `worker`, `repo` and `pr` when a review wrote it. `text` starts with
  `[agent 1 carbon#1234] ` for such a line and `[batch] ` for a line outside any
  review. `?repo=<name>`, `?pr=<n>` and `?worker=<n>` return only that review's
  lines (unfiltered by default). Two repositories can both have a `#1204`, so to
  pick one review send `?repo=carbon-ai-chat&pr=1204`; `?pr=` without `?repo=`
  still matches that number in every repository. The `nextSince` cursor works
  the same either way.

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

**Review one specific PR** — copy, paste, change the number. The repository is
found for you:

```bash
curl -X POST "$BASE/api/review/trigger" -H "Content-Type: application/json" -d '{"prNumbers":[22971]}'
```

Or name the repository, which skips the lookup and is the form to script against:

```bash
curl -X POST "$BASE/api/review/trigger" -H "Content-Type: application/json" -d '{"prs":[{"repo":"carbon-ai-chat","number":1204}]}'
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

> Each of these posts a **real** review of inline comments, a summary comment (or
> a short verdict comment) and the `AIReviewed` label to the pull requests,
> publicly. The last one does it to
> every PR that passes the auto-select filter — up to `GITHUB_AI_AGENT_MAX_PRS`
> of them **in each configured repository**.

The rest of this section covers the full contract: every accepted body shape,
the validation rules, and the error responses.

`POST /api/review/trigger` starts a **real** review. It reads live open PRs from
the configured repositories, runs the selected agent against them, and posts a public
review of inline comments and a summary comment (a short verdict comment for a clean PR) on
each one, then labels them. There is no dry-run mode — every
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
does. Carbon Monitor selects, in each repository of `GITHUB_AI_AGENT_REPOS`, up to
`GITHUB_AI_AGENT_MAX_PRS` (default `10`) of the most recent open PRs created within `GITHUB_AI_AGENT_DAYS_BACK` days
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
  "prs": null,
  "maxPRs": 5,
  "concurrency": 2,
  "daysBack": 21
}
```

`maxPRs` is the cap **per repository**. `prs` is `null` in auto mode because the
run has not chosen its PRs yet.

**2. Explicit list — `prs`, naming the repository**

```bash
curl -X POST "$BASE/api/review/trigger" \
  -H 'Content-Type: application/json' \
  -d '{"prs": [{"repo": "carbon", "number": 22971}, {"repo": "carbon-ai-chat", "number": 1204}]}'
```

`repo` is a repository name from `GITHUB_AI_AGENT_REPOS` (not `owner/name`), and
`number` a positive integer. A bad entry, an unconfigured repository, or more
than `GITHUB_AI_AGENT_MAX_PRS` entries for one repository is a `400`. This is the
form the console sends. Duplicates (`carbon#22971` twice) are reviewed once.

Explicit PRs bypass every filter, the same way `--pr` does on the CLI (see
[Quick start](../README.md#quick-start)). A draft, a six-month-old PR, or
one already labelled `AIReviewed` is reviewed anyway — and a PR that was already
reviewed receives a second set of comments.

```json
{
  "success": true,
  "message": "Review triggered for carbon#22971, carbon-ai-chat#1204, running in background",
  "startedAt": "2026-08-08T14:22:03.118Z",
  "mode": "explicit",
  "prs": [
    { "repo": "carbon", "number": 22971 },
    { "repo": "carbon-ai-chat", "number": 1204 }
  ],
  "maxPRs": 5,
  "concurrency": 2
}
```

`daysBack` is absent in explicit mode because no age filter was applied.
`maxPRs` is still reported — it is the per-repository ceiling the list was
validated against.

Batch order holds for an explicit list as well: every `carbon` PR is reviewed
before any `carbon-ai-chat` PR, whatever order the list is in.

**3. Explicit list — `prNumbers`, array or comma-separated string**

```bash
curl -X POST "$BASE/api/review/trigger" \
  -H 'Content-Type: application/json' \
  -d '{"prNumbers": [22971, 1204]}'

curl -X POST "$BASE/api/review/trigger" \
  -H 'Content-Type: application/json' \
  -d '{"prNumbers": "22971, 1204"}'
```

The server asks GitHub which configured repository has each number (the same
lookup as [`/api/review/resolve`](#finding-a-prs-repository)) **before** it takes
the review lock, then reviews exactly the PRs it found. The `202` is the same as
for `prs`. Surrounding whitespace in the string form is ignored, and a single PR
is just a list of one: `{"prNumbers": "22971"}` is the HTTP equivalent of
`node src/index.js --pr 22971`.

A number that cannot be resolved to exactly one PR refuses the whole request
with a `422` (see [Unresolved numbers](#unresolved-numbers-422)). On a deployment
with one repository this is a **contract change for `prNumbers` callers**: a
number that does not exist used to start the run and be logged as a fetch
failure while the rest of the list was reviewed; now it stops the request before
anything starts. Prefer `prs`, which keeps the old per-number failure handling.

Both fields may be sent together. The refs from `prs` come first, the numbers
are resolved and appended, and the combined list is de-duplicated by
`repo#number` before the per-repository limit is counted, so
`{"prs": [{"repo":"carbon","number":5}], "prNumbers": [5]}` reviews one PR.

**4. `resolutionNotes` (optional, with `prs`)**

When a client chooses a repository for the operator, it can pass what it saw so
the run's log records it:

```json
{
  "prs": [{ "repo": "carbon-ai-chat", "number": 1204 }],
  "resolutionNotes": [
    {
      "repo": "carbon-ai-chat",
      "number": 1204,
      "alternatives": [
        {
          "repo": "carbon",
          "state": "closed",
          "mergedAt": "2019-01-01T00:00:00Z"
        }
      ]
    }
  ]
}
```

The run then logs `📌 #1204 → carbon-ai-chat#1204 (carbon#1204 was merged at lookup)`
before any review starts (`closed` when `mergedAt` is `null`). Notes are
informational snapshots: they never add a PR to the run. A note must name a
configured `repo` and a positive integer `number` that appears in `prs`; at most
one note per ref; `alternatives` is non-empty, each in a different configured
repository from the note's own, at most one per repository, with
`"state": "closed"` and `mergedAt` an ISO 8601 timestamp or `null` (the key is
required). Anything else is a `400` before the lock is read. For `prNumbers` the
server writes the same notes itself from its lookup, so callers never send them.

> **Precedence.** An explicit `prs` or `prNumbers` in the request body wins over
> `GITHUB_AI_AGENT_PR_NUMBER` / `--pr`, which in turn wins over auto-selection.
> So on a container started with `GITHUB_AI_AGENT_PR_NUMBER=12345` (or
> `carbon-ai-chat#12345`), a body-less trigger reviews that PR, and a trigger
> carrying `prs` or `prNumbers` reviews the PRs you named instead.

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
  "prs": [
    { "repo": "carbon", "number": 22971 },
    { "repo": "carbon", "number": 22972 },
    { "repo": "carbon-ai-chat", "number": 1204 }
  ],
  "inFlight": [
    {
      "worker": 1,
      "repo": "carbon",
      "pr": 22971,
      "startedAt": "2026-08-08T14:22:04.020Z"
    },
    {
      "worker": 2,
      "repo": "carbon",
      "pr": 22972,
      "startedAt": "2026-08-08T14:22:04.021Z"
    }
  ],
  "queued": ["carbon-ai-chat#1204"],
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
  "prs": null,
  "inFlight": [],
  "queued": [],
  "concurrency": 2,
  "timestamp": "2026-08-08T14:32:10.005Z"
}
```

`mode` and `prs` describe the current run, or the most recent one once
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

| Body                                           | Rejected because                                               |
| ---------------------------------------------- | -------------------------------------------------------------- |
| `{"prNumbers": "abc"}`                         | `abc` is not a number                                          |
| `{"prNumbers": [22971, 0]}`                    | `0` is not a positive integer                                  |
| `{"prNumbers": [-5]}`                          | negative                                                       |
| `{"prNumbers": [22971.5]}`                     | not an integer                                                 |
| `{"prNumbers": [22971, null]}`                 | `null` entry                                                   |
| `{"prNumbers": ", ,"}`                         | a stray comma leaves an empty value                            |
| `{"prNumbers": 22971}`                         | a bare number is neither an array nor a comma-separated string |
| `{"prNumbers": {"pr": 22971}}`                 | an object is neither an array nor a string                     |
| more distinct numbers than the aggregate limit | see below                                                      |
| `{"prs": "carbon#5"}`                          | `prs` must be an array of `{ repo, number }`                   |
| `{"prs": [{"repo": "nope", "number": 5}]}`     | `nope` is not in `GITHUB_AI_AGENT_REPOS`                       |
| `{"prs": [{"repo": "carbon", "number": "5"}]}` | `number` must be a positive integer, not a string              |
| a malformed `resolutionNotes`                  | see **4** above                                                |
| more PRs for one repository than the limit     | see below                                                      |

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

**The limits.** `GITHUB_AI_AGENT_MAX_PRS` is **per repository**. A list of bare
numbers is first checked against the total, `GITHUB_AI_AGENT_MAX_PRS` times the
number of configured repositories, before any lookup:

```json
{
  "error": "Too many PRs: 21 requested, but at most 20 may be reviewed per run (GITHUB_AI_AGENT_MAX_PRS per repository, across all repositories).",
  "timestamp": "2026-08-08T23:24:33.491Z"
}
```

The per-repository limit is then enforced on the final list, after numbers are
resolved to repositories, `prs` and `prNumbers` are merged and duplicates are
dropped. It is also a `400`, and nothing starts:

```json
{
  "error": "Too many PRs for carbon: 11 requested, but at most 10 may be reviewed per repository (GITHUB_AI_AGENT_MAX_PRS).",
  "timestamp": "2026-08-08T23:24:33.491Z"
}
```

So with a limit of 10, ten `carbon` and ten `carbon-ai-chat` numbers are
accepted, and eleven that all resolve to `carbon` are not. Duplicates are not an
error: `[22971, 22971, 22972]` is de-duplicated to `[22971, 22972]` with the
original order preserved, and the limit is checked _after_ de-duplication.
Raise `GITHUB_AI_AGENT_MAX_PRS` if you genuinely need a longer list; it governs
both modes. Malformed JSON, or a body over 256 KB, is also a `400`.

<a id="unresolved-numbers-422"></a>

**7. Unresolved numbers (422)**

A `prNumbers` entry that is not in any configured repository, or is in more than
one and the open-PR rule cannot pick (see below), refuses the request with
`422 Unprocessable Content`. Nothing starts and the review lock is not taken. It
is a `422` rather than a `409` so that `409` keeps its one meaning, "a review is
already running".

```json
{
  "success": false,
  "code": "ambiguous",
  "message": "PR #1204 matches carbon and carbon-ai-chat. Name it as carbon-ai-chat#1204.",
  "results": [
    {
      "number": 1204,
      "choice": null,
      "resolution": "ambiguous",
      "matches": [
        {
          "repo": "carbon",
          "number": 1204,
          "title": "…",
          "author": "…",
          "createdAt": "…",
          "state": "open",
          "mergedAt": null,
          "draft": false,
          "url": "…"
        },
        {
          "repo": "carbon-ai-chat",
          "number": 1204,
          "title": "…",
          "author": "…",
          "createdAt": "…",
          "state": "open",
          "mergedAt": null,
          "draft": false,
          "url": "…"
        }
      ]
    }
  ]
}
```

`code` is `ambiguous` when any unresolved number matches more than one repository
(retry with `prs`, or name the PR as `repo#number`) and `not-found` when every
unresolved number matches none. `results` has one entry for **every** number sent,
resolved or not, in the shape of `/api/review/resolve`. If GitHub itself fails
during the lookup (anything but a `404`), the trigger answers `502`; with no
`GITHUB_AI_AGENT_TOKEN` configured it answers `503`. Neither starts a run.

**8. Already running (409)**

```json
{
  "success": false,
  "message": "A review of carbon#22971, carbon-ai-chat#1204 is already running (started 2026-08-08T23:24:33.525Z). Carbon Monitor runs one review session at a time — wait for it to finish before starting another.",
  "startedAt": "2026-08-08T23:24:33.525Z",
  "mode": "explicit",
  "prs": [
    { "repo": "carbon", "number": 22971 },
    { "repo": "carbon-ai-chat", "number": 1204 }
  ]
}
```

The message reads `auto-selected PRs` instead of the keys in auto mode, and
`prs` is `null`.

Only one review session runs at a time. This is not a resource limit — it is there
because two agents reviewing the same PR would post the same findings twice:
duplicate inline comments on the same diff lines, and two summary comments. The
`409` carries the in-flight run's `startedAt`, `mode` and `prs`, so a
caller can tell what is already running without a second request.

The lock is read **after** the request body is parsed and any `prNumbers` are
looked up, and claimed in the same step, so two triggers arriving together cannot
both start. A request that is invalid (`400`) or unresolved (`422`) is therefore
answered as such even while a review runs.

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

### Finding a PR's repository

`POST /api/review/resolve` answers "which configured repository is PR 1204 in?"
without reviewing anything. It makes no changes and does not take the review
lock, so it works while a review is running.

```bash
curl -X POST "$BASE/api/review/resolve" \
  -H 'Content-Type: application/json' \
  -d '{"prNumbers": [22971, 1204, 99999]}'
```

`prNumbers` is an array or a comma-separated string, validated like the trigger's
(positive integers, de-duplicated, at most `GITHUB_AI_AGENT_MAX_PRS` times the
number of repositories). Absent or empty is a `400` here. Each number is looked
up in every configured repository, at most four requests at a time.

```json
{
  "success": true,
  "results": [
    {
      "number": 22971,
      "choice": { "repo": "carbon", "number": 22971 },
      "resolution": "unique",
      "matches": [
        {
          "repo": "carbon",
          "number": 22971,
          "title": "…",
          "author": "…",
          "createdAt": "2026-10-01T00:00:00Z",
          "state": "open",
          "mergedAt": null,
          "draft": false,
          "url": "https://github.com/carbon-design-system/carbon/pull/22971"
        }
      ]
    },
    {
      "number": 1204,
      "choice": null,
      "resolution": "ambiguous",
      "matches": [
        { "repo": "carbon", "…": "…" },
        { "repo": "carbon-ai-chat", "…": "…" }
      ]
    },
    {
      "number": 99999,
      "choice": null,
      "resolution": "not-found",
      "matches": []
    }
  ],
  "timestamp": "2026-11-04T15:00:00.000Z"
}
```

`results` follows the order the numbers were sent; `matches` follows
`GITHUB_AI_AGENT_REPOS` order. `state` is `open` or `closed`, and `mergedAt` is
the merge time or `null`, which tells a merged PR from one closed unmerged.

| `resolution` | `choice`       | When                                                                                                                                      |
| ------------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `unique`     | the match      | exactly one repository has the PR                                                                                                         |
| `only-open`  | the open match | several have it, and exactly one of those is `open`: a merged `carbon#1204` from 2019 does not compete with an open `carbon-ai-chat#1204` |
| `ambiguous`  | `null`         | several have it and none, or more than one, is open                                                                                       |
| `not-found`  | `null`         | no configured repository has it                                                                                                           |

Errors: `400` for bad input, with the standard `{ "error", "timestamp" }`
envelope; `502` when GitHub fails with anything but a `404` (a `404` only means
"not in this repository"); `503` when `GITHUB_AI_AGENT_TOKEN` is not set.

**Discovery only.** Resolve does not apply the per-repository limit: a set of
choices that exceeds one repository's `GITHUB_AI_AGENT_MAX_PRS` is returned
as found. The trigger enforces the final limit, on the whole list, once the
choices are made (a `400`, see **6**). Because the open-PR rule can pick a
different PR than the operator meant, a client that acts on an `only-open`
choice should say so with `resolutionNotes`.

**From the console instead**

The **Reviews** tile carries a PR-list field that is the exact equivalent of the
explicit call: type `22971, 22972`, press **Run review now**, and the console
sends the same request. With more than one repository configured it first calls
`/api/review/resolve` and sends `prs`, asking only when a number matches several
repositories. Leave the field empty for auto mode. It validates
against the rules above as you type, and the button stays disabled until the
list is valid, so a bad list is caught before it becomes a `400`.
