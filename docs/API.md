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

| Method | Path                         | Description                                                                                                          |
| ------ | ---------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/api/health`                | Health check — always open                                                                                           |
| `GET`  | `/api/auth/status`           | Whether sign-in is required and satisfied — always open                                                              |
| `POST` | `/api/auth/login` / `logout` | Session sign-in — always open                                                                                        |
| `GET`  | `/api/mcp/callback`          | OAuth redirect target — guarded by one-shot `state` + PKCE                                                           |
| `GET`  | `/api/status`                | All dependency checks (Bob, Carbon MCP, GitHub, Elasticsearch, Bobcoins)                                             |
| `GET`  | `/api/config`                | Current configuration (sanitised — never returns credentials)                                                        |
| `GET`  | `/api/mcp/status`            | Carbon MCP connection detail                                                                                         |
| `POST` | `/api/mcp/connect`           | Begin the IBMid OAuth bootstrap                                                                                      |
| `POST` | `/api/mcp/refresh`           | Force a refresh, or store a pasted token / session id                                                                |
| `POST` | `/api/mcp/test`              | Live probe — also repairs a session-backed connection                                                                |
| `POST` | `/api/mcp/disconnect`        | Forget the stored OAuth state and strip Bob's MCP headers                                                            |
| `GET`  | `/api/credits`               | Bobcoins balance and spend summary                                                                                   |
| `GET`  | `/api/credits/history`       | Per-review spend, plus a cumulative series                                                                           |
| `POST` | `/api/review/trigger`        | Trigger a review (202, runs in the background) — see [Triggering a review over HTTP](#triggering-a-review-over-http) |
| `GET`  | `/api/review/status`         | Current or most recent run, with its mode and PR numbers                                                             |

`POST /api/mcp/disconnect` is the inverse of **Sign in with IBMid**: it deletes
the stored refresh token and removes the `Authorization` / `X-MCP-Session`
headers from `~/.bob/settings/mcp.json`, so the next review genuinely runs with
no Carbon MCP credential. It is idempotent — disconnecting an already
disconnected server still returns `{ "success": true, "disconnected": true }`.
Reconnecting costs a browser round trip through IBMid, which is why the console
asks for confirmation first.

**Authentication is off by default** — every route above answers without a
credential. When `AUTH_REQUIRED=true`, everything except the always-open routes
needs either a session cookie or `Authorization: Bearer <API_SECRET>`. See
[Console sign-in](ARCHITECTURE.md#5-authentication-model).

```bash
API_PORT=3000
API_SECRET=your_secure_api_secret_here   # bearer token for CI / curl
API_ENABLE_AUTH=true                     # only has effect when AUTH_REQUIRED=true
```

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
the configured repository, runs Bob against them, and posts public inline and
summary comments on each one, then labels them. There is no dry-run mode — every
command below writes to GitHub.

Two things follow from that, and both are deliberate:

- **The call is asynchronous.** It returns `202` the moment the run is accepted
  and does the work in the background. A review takes minutes, far longer than
  Code Engine's 300-second request ceiling, so there is nothing useful to wait
  on — the HTTP request would time out long before the review finished. Poll
  `GET /api/review/status` for the outcome.
- **Auth is off by default.** With `AUTH_REQUIRED` unset, the commands below work
  as written, including against the public deployment URL. When
  `AUTH_REQUIRED=true`, add `-H "Authorization: Bearer $API_SECRET"` to every
  call — see **With authentication on** at the end of this section.

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
  "prNumbers": [22971, 22972],
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
