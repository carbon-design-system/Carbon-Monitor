# Carbon Monitor

Automated PR review agent for the `carbon-design-system/carbon` monorepo. Carbon Monitor fetches open, unreviewed pull requests, runs them through Bob (IBM's AI CLI agent), and posts structured review comments directly on the PR — including inline comments on specific diff lines and a summary comment with a final recommendation.

Carbon-specific claims (component props, tokens, icons, accessibility patterns) are verified at review time using the Carbon MCP server before they appear in any posted finding.

---

## How It Works

1. **Fetch** — Queries GitHub for open PRs and excludes: drafts, PRs older than 21 days (configurable), PRs already labelled `AIReviewed`, and bot-authored PRs (Dependabot, Renovate, etc.). Up to 5 PRs are reviewed per run (configurable).

2. **Bundle** — For each PR, builds a temporary workspace under `/private/tmp` containing:
   - `PR_REVIEW_REQUEST.md` — PR description, changed files list, and full unified diff in one file
   - `pr.json` / `files.json` / `diff.patch` — raw metadata
   - `.bob/rules/01-output.md` — agent behavioural rules injected into Bob's context
   - `.bob/skills/carbon-builder/` — Carbon Builder skill copied from the local workspace so Bob can load it inside the bundle directory

   **Linked issue context:** If the PR body contains a `Closes #N`, `Fixes #N`, or `Resolves #N` reference, Carbon Monitor fetches that issue (and its parent issue, if one exists) and includes it in the bundle as a `## Linked Issue Context` section.

   The agent prompt instructs Bob to read this section before cataloguing the diff. It is treated as the acceptance criteria and intent for the change, giving the agent the *why* behind the PR and not just the *what* — so it can distinguish an intentional API removal from an accidental one, verify the implementation matches the stated requirements, and avoid flagging changes the issue explicitly calls for.

   The issue content is capped at 5,000 tokens and truncated with a notice if it exceeds that. If no linked issue is found or fetching fails, the section is silently omitted and the review continues from the diff alone.

3. **Review** — Runs Bob (`bob run --trust --accept-license [--team-id …] "<prompt>"`) against the bundle directory. Bob works through a structured protocol:
   - **Step 1** — Reads `PR_REVIEW_REQUEST.md` and writes a visible catalogue of every suspicious item per file, classified as Category 1 (Carbon API — requires MCP) or Category 2 (generic — diff-visible).
   - **Step 2** — Resolves every pending catalogue item. Category 1 items are verified using the Carbon Builder skill and Carbon MCP tools (`code_search`, `docs_search`, `get_charts`). Category 2 items are resolved from the diff alone.
   - **Step 3** — Compiles the confirmed findings list with severity (`blocking`, `major`, `minor`, `nit`).
   - **Step 4** — Outputs a structured JSON block between `BEGIN_REVIEW_JSON` / `END_REVIEW_JSON` markers.

4. **Parse** — `reviewParser.js` extracts the JSON, validates it, detects truncation or collapsed-thinking runs, and computes a recommendation (`consider-revising`, `suggested-improvements`, or `looks-good`) from the finding severities.

5. **Post** — Findings that map to a line in the diff are posted as inline GitHub review comments. Remaining findings and the overall summary are posted as a PR issue comment. The `AIReviewed` label is added to the PR.

6. **Cleanup** — The temporary bundle directory is deleted (or kept if `GITHUB_AI_AGENT_KEEP_ARTIFACTS=true`).

---

## Architecture

```
Carbon-Monitor/
├── src/
│   ├── index.js             # Orchestrator — fetches PRs, coordinates all steps (CLI entrypoint)
│   ├── constants.js         # Env-driven defaults: owner, repo, label, limits
│   ├── loadEnv.js           # dotenv bootstrap
│   ├── githubClient.js      # GitHub API wrapper (fetch PRs/diffs/files, post comments, add labels)
│   ├── reviewBundle.js      # Builds the temp workspace Bob runs inside
│   ├── agentRunner.js       # Spawns the Bob process, captures output
│   ├── reviewParser.js      # Parses Bob's JSON output, filters findings, computes recommendation
│   ├── reviewPrompt.js      # Builds the review prompt; formats summary and inline comments
│   ├── diffMapper.js        # Maps finding file+line to a GitHub diff position for inline comments
│   ├── slackNotifier.js     # End-of-run digest to Slack
│   ├── textUtils.js         # Shared text helpers
│   ├── config/env.js        # Trimmed env reads for Elasticsearch
│   ├── observability/       # Elasticsearch client and review events
│   └── api/
│       ├── server.js        # Console + REST API (the Code Engine entrypoint)
│       ├── mcpConnection.js # Carbon MCP OAuth, refresh timer, persisted state
│       ├── healthChecks.js  # Dependency probes for the status tiles
│       ├── sessionAuth.js   # Console sign-in and bearer auth
│       ├── bobCredits.js    # Bobcoins balance
│       ├── creditLedger.js  # Per-review spend
│       ├── reviewLog.js     # Log tail for the console
│       ├── scheduleManager.js  # Scheduled reviews
│       └── tokenManager.js  # Compatibility shim → mcpConnection
├── client/                  # Carbon React console (Vite)
├── scripts/                 # Elasticsearch/Kibana setup, test-PR helpers, smoke test
├── tests/                   # node tests/*.test.js — all of them: npm run test:all
├── docs/
│   ├── ARCHITECTURE.md
│   ├── INLINE_COMMENTS.md
│   ├── MCP_TOKEN_REFRESH.md
│   └── TOKEN_USAGE_TRACKING.md
├── kibana/README.md         # Dashboard setup
├── .bob/skills/carbon-builder/  # Carbon Builder skill, copied into each review bundle
├── Dockerfile · docker-compose.yml · deploy_ce.sh
├── .env.example · QUICKSTART.md · CONTRIBUTING.md · LICENSE
└── package.json
```

---

## Prerequisites

1. **Node.js** >= 22.15.0 (required by Bob Shell)
2. **GitHub personal access token** — see [GitHub token](#github-token) for the
   exact permissions, including the repository role the token's account needs
3. **Bob Shell CLI** installed and on `PATH`
4. **Carbon MCP** configured globally in Bob as a streamable-HTTP connection (see setup below)

---

## GitHub token

The agent makes eight distinct API calls. Six are reads, and three write:
`pulls.createReviewComment` (inline comments), `issues.createComment` (the
summary) and `issues.addLabels` (the `AIReviewed` label).

### The label is the binding requirement

**Adding a label needs the Triage role or higher on the repository.** No token
scope grants this on its own — the *account* the token belongs to must hold that
role on `carbon-design-system/carbon`.

It is not optional:

- `addReviewedLabel` throws, and the per-PR handler treats that as a failure — so
  the run fails *after* it has already posted its comments.
- The label is the de-duplication key. `fetchReviewablePRs` skips any PR that
  already carries it, so a token that can comment but not label will **re-review
  the same PR on every run and post duplicate comments each time.**

Inline comment failures, by contrast, are non-fatal: they are logged and the loop
continues.

### Fine-grained token (recommended)

| Setting | Value |
|---------|-------|
| Resource owner | `carbon-design-system` |
| Repository access | `carbon` — plus any repo hosting linked parent issues |
| **Pull requests** | Read and write |
| **Issues** | Read and write |
| **Contents** | Read |
| **Metadata** | Read (mandatory, selected automatically) |

*Issues* write is needed for two reasons that are easy to miss: labels are an
issue-level concept, and the PR summary comment is posted through the issues
endpoint.

Grant access to more than one repository if PRs link to parent issues elsewhere —
`fetchLinkedIssueContext` follows `parent_issue_url` across repositories, and a
token scoped to a single repo silently returns no issue context rather than
failing.

### Classic token

`public_repo` is sufficient: the target repository is public, and that scope
grants write. Use full `repo` only when pointing at a private repository.

Classic tokens are coarser — `public_repo` grants write access to *every* public
repository the account can push to, which is why the fine-grained token is
preferred.

> **Not `write:discussion`.** Earlier revisions of this document listed that
> scope. It governs *team discussions*, which this agent never touches; it grants
> nothing the agent needs and can be dropped from existing tokens.

### Two things that will bite you

- **SAML SSO authorization.** `carbon-design-system` is IBM-managed, so after
  creating the token you must use **Configure SSO → Authorize** on it. Without
  that, every call returns 403 with an otherwise valid-looking token, and the
  console's GitHub tile reports `Token rejected`.
- **Fine-grained tokens expire** (one year maximum, often capped shorter by org
  policy). An expired token is indistinguishable from a revoked one in the status
  tile — both read `Token rejected`.

### Running without write access

Comment posting can be disabled:

```bash
GITHUB_AI_AGENT_POST_INLINE_COMMENTS=false
GITHUB_AI_AGENT_POST_SUMMARY_COMMENT=false
```

The label call is **not** behind a flag, so it still runs and still needs Triage.
There is currently no fully read-only mode.

---

## Installation

```bash
git clone https://github.com/carbon-design-system/Carbon-Monitor.git
cd Carbon-Monitor
npm install
```

---

## Configuration

### 1. Environment variables

```bash
cp .env.example .env
```

Edit `.env`:

```bash
# Required
GITHUB_AI_AGENT_TOKEN=ghp_your_github_token_here
# BOB_API_KEY, not BOBSHELL_API_KEY — Bob Shell v2 renamed it
BOB_API_KEY=your_bob_api_key_here

# Defaults shown — override as needed
GITHUB_AI_AGENT_OWNER=carbon-design-system
GITHUB_AI_AGENT_REPO=carbon
GITHUB_AI_AGENT_CLI=bob
GITHUB_AI_AGENT_MAX_PRS=5
GITHUB_AI_AGENT_DAYS_BACK=21
GITHUB_AI_AGENT_MAX_INPUT_TOKENS=140000
GITHUB_AI_AGENT_REVIEW_LABEL=AIReviewed
GITHUB_AI_AGENT_POST_INLINE_COMMENTS=true
GITHUB_AI_AGENT_POST_SUMMARY_COMMENT=true
GITHUB_AI_AGENT_KEEP_ARTIFACTS=false
```

Full variable reference:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GITHUB_AI_AGENT_TOKEN` | ✅ | — | GitHub PAT. Needs Pull requests + Issues write and Contents read, **and Triage on the repo** — see [GitHub token](#github-token) |
| `BOB_API_KEY` | ✅ | — | Bob Shell API key. Create with Scope **Inference** in the Bob web portal — browser SSO cannot complete in a container |
| `BOB_TEAM_ID` | ❌ | — | Only for a `general`-type Bob key; sending it with an Inference key breaks the run |
| `GITHUB_AI_AGENT_OWNER` | ❌ | `carbon-design-system` | Repository owner |
| `GITHUB_AI_AGENT_REPO` | ❌ | `carbon` | Repository name |
| `GITHUB_AI_AGENT_CLI` | ❌ | `bob` | Agent to use — only `bob` is supported |
| `GITHUB_AI_AGENT_PR_NUMBER` | ❌ | — | Review a specific PR by number; bypasses auto-selection. Can also be set via `--pr <number>` CLI flag. `DAYS_BACK` and `MAX_PRS` filters do not apply. |
| `GITHUB_AI_AGENT_MAX_PRS` | ❌ | `5` | Max PRs reviewed per run |
| `GITHUB_AI_AGENT_DAYS_BACK` | ❌ | `21` | How far back to look for PRs (days) |
| `GITHUB_AI_AGENT_MAX_INPUT_TOKENS` | ❌ | `140000` | Total input token budget. Three slices at the default: 12,000 prompt overhead + 5,000 issue context + 123,000 diff = 140,000 tokens. Effective diff budget = 492,000 chars. |
| `GITHUB_AI_AGENT_REVIEW_LABEL` | ❌ | `AIReviewed` | Label added after review |
| `GITHUB_AI_AGENT_POST_INLINE_COMMENTS` | ❌ | `true` | Post inline diff comments |
| `GITHUB_AI_AGENT_POST_SUMMARY_COMMENT` | ❌ | `true` | Post summary issue comment |
| `GITHUB_AI_AGENT_KEEP_ARTIFACTS` | ❌ | `false` | Keep temp bundle directory for debugging |

### 2. Bob Shell

Install Bob Shell and trust the directories it needs for MCP tool access:

```bash
npm install -g bobshell
bob --version

bob trust /private/tmp
bob trust /path/to/Carbon-Monitor
```

### 3. Carbon MCP (streamable HTTP)

Carbon Monitor uses Carbon MCP over streamable HTTP, not `npx carbon-mcp`. Create `~/.bob/settings/mcp.json`:

```json
{
  "mcpServers": {
    "carbon-mcp": {
      "type": "streamable-http",
      "url": "https://mcp.carbondesignsystem.com/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_IBM_JWT_TOKEN",
        "X-MCP-Session": "YOUR_SESSION_ID"
      }
    }
  }
}
```

Verify it is connected by opening Bob shell and running `/mcp list`:

```bash
bob
```

```
/mcp list
# Expected: carbon-mcp - Ready
```

> **Note:** IBM JWT tokens expire. The API server (see below) is being built to automate token refresh so the MCP connection stays valid when running in the cloud.

### 4. Carbon Builder skill

If `.bob/skills/carbon-builder` doesn't exist yet, install it by following the [Carbon Builder skill setup guide](https://carbondesignsystem.com/developing/carbon-mcp/onboarding-and-setup/#step-4:-adding-the-carbon-builder-skill). If it's already there, you're good to go.

---

## Running

### One-off review run

```bash
npm start
# or
node src/index.js
```

### Review a specific PR

```bash
# Primary form
node src/index.js --pr 12345

# Via npm start (note the -- separator — required by npm)
npm start -- --pr 12345

# Via env var
GITHUB_AI_AGENT_PR_NUMBER=12345 npm start
```

> `DAYS_BACK` and `MAX_PRS` filters are not applied when a specific PR is targeted. The PR is reviewed regardless of age, label, or draft status.

### Tests

```bash
npm test                # agent integration test
npm run test:parser     # reviewParser unit tests
npm run test:diff       # diffMapper unit tests
npm run test:all        # parser + diffMapper
```

### API server and console

```bash
npm run build:client   # build the console once
npm run api            # http://localhost:3000
```

Serves the operator console and the REST API on one port (`PORT`, then
`API_PORT`, default `3000`). Code Engine injects `PORT`, and exposes a single
port per app, which is why both share one.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Health check — always open |
| `GET` | `/api/auth/status` | Whether sign-in is required and satisfied — always open |
| `POST` | `/api/auth/login` / `logout` | Session sign-in — always open |
| `GET` | `/api/mcp/callback` | OAuth redirect target — guarded by one-shot `state` + PKCE |
| `GET` | `/api/status` | All dependency checks (Bob, Carbon MCP, GitHub, Elasticsearch, Bobcoins) |
| `GET` | `/api/config` | Current configuration (sanitised — never returns credentials) |
| `GET` | `/api/mcp/status` | Carbon MCP connection detail |
| `POST` | `/api/mcp/connect` | Begin the IBMid OAuth bootstrap |
| `POST` | `/api/mcp/refresh` | Force a refresh, or store a pasted token / session id |
| `POST` | `/api/mcp/test` | Live probe — also repairs a session-backed connection |
| `POST` | `/api/mcp/disconnect` | Forget the stored OAuth state and strip Bob's MCP headers |
| `GET` | `/api/credits` | Bobcoins balance and spend summary |
| `GET` | `/api/credits/history` | Per-review spend, plus a cumulative series |
| `POST` | `/api/review/trigger` | Trigger a review (202, runs in the background) — see [Triggering a review over HTTP](#triggering-a-review-over-http) |
| `GET` | `/api/review/status` | Current or most recent run, with its mode and PR numbers |

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
[Console sign-in](#console-sign-in-optional).

```bash
API_PORT=3000
API_SECRET=your_secure_api_secret_here   # bearer token for CI / curl
API_ENABLE_AUTH=true                     # only has effect when AUTH_REQUIRED=true
```

#### Triggering a review over HTTP

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
does. Carbon Monitor selects up to `GITHUB_AI_AGENT_MAX_PRS` (default `5`) of
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
[Review a specific PR](#review-a-specific-pr)). A draft, a six-month-old PR, or
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
`running` is `false` — which is how the console can say *what* is being
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

| Body | Rejected because |
|------|------------------|
| `{"prNumbers": "abc"}` | `abc` is not a number |
| `{"prNumbers": [22971, 0]}` | `0` is not a positive integer |
| `{"prNumbers": [-5]}` | negative |
| `{"prNumbers": [22971.5]}` | not an integer |
| `{"prNumbers": [22971, null]}` | `null` entry |
| `{"prNumbers": ", ,"}` | a stray comma leaves an empty value |
| `{"prNumbers": 22971}` | a bare number is neither an array nor a comma-separated string |
| `{"prNumbers": {"pr": 22971}}` | an object is neither an array nor a string |
| more distinct numbers than the limit | more than `GITHUB_AI_AGENT_MAX_PRS` after de-duplication |

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
*after* de-duplication — so listing the same PR six times is fine, while six
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
[Console sign-in](#console-sign-in-optional).

**From the console instead**

The **Reviews** tile carries a PR-list field that is the exact equivalent of the
explicit call: type `22971, 22972`, press **Run review now**, and the console
sends the same request. Leave the field empty for auto mode. It validates
against the rules above as you type, and the button stays disabled until the
list is valid, so a bad list is caught before it becomes a `400`.

---

## Output Format

Each reviewed PR receives two types of comments:

### Inline comments (on specific diff lines)

```
**Missing aria-label on time picker select**

> [blocking] Should be resolved before this ships.

<cds-time-picker-select> added in this diff has no aria-label attribute.
Interactive select elements inside a composite component must have an
accessible label. Add aria-label="Time zone" (or equivalent) to the element.

*✓ Verified with Carbon Builder + MCP*
```

### Summary comment (PR issue comment)

```
[AI agent review — Carbon grounded] · **Consider Revising**

Reviewed by: bob · Commit: a1b2c3d
Carbon verification: Carbon-specific claims require Carbon Builder and Carbon MCP verification.

## Recommendation

1 blocking finding: "Missing aria-label on time picker select"

There are issues in this PR that should be addressed before merging. ...

## Findings

| Area       | Category | Severity | Finding                                  | File                    |
|------------|----------|----------|------------------------------------------|-------------------------|
| General    | Cat 2    | blocking | Missing aria-label on time picker select | src/components/...      |
| Carbon API | Cat 1    | minor    | menu-alignment on wrong element          | src/components/...      |

## Summary

This PR updates the time picker Figma Code Connect mappings. 1 blocking finding: ...

Review artifacts:
- PR: #12345
- Commit: a1b2c3d
- Agent: bob
- Inline comments: 1
- Summary findings: 1

---
**Estimated Token Usage:**
- Input tokens: ~8,400
- Output tokens: ~2,100
- Total tokens: ~10,500
```

### Recommendation values

| Value | Meaning |
|-------|---------|
| `Consider Revising` | One or more `blocking` findings, or two or more `major` findings |
| `Suggested Improvements` | Any `major` or `minor` finding, or review reliability was uncertain |
| `Looks Good` | `nit`-level findings only, or no findings |

### Finding severities

| Severity | Meaning |
|----------|---------|
| `blocking` | Breaks user-facing behaviour or violates an accessibility requirement |
| `major` | Likely to cause a visible rendering difference or runtime error |
| `minor` | Maintainability risk or subtle behaviour difference — not immediately breaking |
| `nit` | Convention / hygiene — no functional consequence |

---

## Review Reliability

The parser checks for two signals in the agent's output before the JSON block:

- **Catalogue present** — at least one `[file:line] — ... — pending`, `NO-FINDINGS`, or `SKIP` line must appear. If absent, the agent skipped Step 1 and the review is flagged as unreliable (`catalogueWarning` is set in the comment).
- **Step 2 visible** — pending catalogue items must be resolved with `confirmed finding` or `discarded: [reason]` lines in the visible response. If pending items appear but no resolutions do, the run is treated the same as a missing catalogue.

An unreliable run still posts a comment but sets the recommendation to `Suggested Improvements` and includes a prominent warning note.

---

## Deployment

Carbon Monitor deploys to **IBM Cloud Code Engine** as a single always-on app
that serves an operator console, keeps the Carbon MCP connection alive, and runs
reviews on demand.

**[→ Full architecture documentation](docs/ARCHITECTURE.md)** — container layout,
Bob Shell packaging, the Carbon MCP OAuth bootstrap and unattended refresh, the
authentication model, and the Code Engine topology, with diagrams.

```bash
cp .env.example .env   # fill in credentials and the deployment target
./deploy_ce.sh         # syncs the secret from .env, builds, pushes, deploys
```

Then open the console and press **Sign in with IBMid** once. After that the
container renews its own Carbon MCP token — the connection no longer dies every
two hours.

Sign-in is off in code but **on in `.env.example` and in the `deploy_ce.sh` default**. It needs `CONSOLE_USERNAME` / `CONSOLE_PASSWORD` (and ideally `SESSION_SIGNING_KEY`) in `.env` — see [Console sign-in](#console-sign-in-optional).

The deployment target (`REGION`, `RESOURCE_GROUP`, `PROJECT`, `NAMESPACE`) comes from `.env`; see `.env.example`.

### The operator console

`npm run api` serves both the API and the Carbon React v11 console:

- **Status tiles** — Bob Shell, Carbon MCP, GitHub and Elasticsearch, each
  reporting what is wrong rather than only that something is
- **Carbon MCP connection** — sign in with IBMid, test the connection, force a
  refresh, paste a bearer token and session id as a fallback, or sign out and
  drop the stored credential entirely
- **Reviews** — trigger a run, name specific PRs to review, and see the state of
  the current or most recent run — see
  [Triggering a review over HTTP](#triggering-a-review-over-http)

```bash
npm run build:client   # build the console (also stages IBM Plex)
npm run api            # http://localhost:3000
npm run dev:client     # optional: live reload at :5173, proxying to :3000
```

### Console sign-in (optional)

The console is **open by default** — no login page, everywhere, including
production. Password protection is a feature flag:

```bash
AUTH_REQUIRED=true CONSOLE_USERNAME=operator CONSOLE_PASSWORD=secret \
  SESSION_SIGNING_KEY=$(openssl rand -hex 32) npm run api
```

With it on, the console shows a sign-in page that accepts
`CONSOLE_USERNAME` / `CONSOLE_PASSWORD`. With it off, the "Sign out" control is hidden — there is
no session to end.

The flag accepts `true`/`1`/`yes`/`on`; anything unrecognised is reported at
startup and treated as off, so a typo cannot leave you believing the console is
protected when it is not. Every start logs the resulting posture:

```
🔓 Sign-in:        open — no authentication (set AUTH_REQUIRED=true to enable)
```

> Worth knowing: the Code Engine app has a public HTTPS URL. With sign-in off,
> anyone with that URL can read status and trigger a review. No secret is exposed
> — the API never returns tokens, keys or passwords — but the actions are
> unauthenticated.

### Running reviews on a schedule

`npm start` still runs a single review pass and exits, so the agent can also be
driven by a scheduler. The CI/CD safety check in `index.js` skips execution when
`TRAVIS_BRANCH` is set to anything other than `main`, preventing accidental
reviews from feature-branch CI runs.

### Local container

```bash
npm run build:client
podman build --platform linux/amd64 -t carbon-monitor .
podman run -d -p 8080:8080 --env-file .env carbon-monitor
```

> The image must be Debian-based and Node 22+. Bob Shell requires
> Node >= 22.15.0, and its `node-pty` prebuild needs glibc 2.28+ with no musl
> variant published — so Alpine cannot run it. See
> [docs/ARCHITECTURE.md §3.1](docs/ARCHITECTURE.md).

---

## Troubleshooting

### Bob not found in PATH
```bash
npm install -g bobshell
which bob
```

### Carbon MCP not connected
```bash
bob
```

```
/mcp list
# Should show: carbon-mcp - Ready
# If not ready, check ~/.bob/settings/mcp.json and verify your JWT token is valid
```

### IBM JWT token expired
The Carbon MCP connection uses an IBM JWT that expires periodically. While running on IBM network/VPN:
1. Obtain a fresh token
2. Update `~/.bob/settings/mcp.json` with the new token, or call `POST /api/mcp/refresh` if the API server is running

### Bob requires IBM network
Bob Shell requires IBM office network or VPN access. If you're seeing Cloudflare errors, connect to IBM VPN and retry.

### No PRs to review
This is expected when all open PRs already have the `AIReviewed` label, or no PRs were opened within the `DAYS_BACK` window.

### Keep artifacts for debugging
```bash
GITHUB_AI_AGENT_KEEP_ARTIFACTS=true npm start
```
The bundle directory path is printed to the console. It contains `agent-output.txt` (Bob's full response) and `agent-stderr.txt`.

---

## Development

### Adding review rubric checks

The review prompt in [`src/reviewPrompt.js`](src/reviewPrompt.js) (`buildReviewPrompt`) contains the full 15-check rubric Bob follows. Adding a new check means appending a numbered rule to the prompt — no other files need to change.

### Changing the comment format

Summary comment rendering is in [`formatSummaryComment`](src/reviewPrompt.js) and inline comment rendering in [`formatInlineComment`](src/reviewPrompt.js).

### Adjusting finding filters

`reviewParser.js` contains `filterUnverifiedCarbonFindings` and `computeRecommendation`. The recommendation logic is in `computeRecommendation` starting at line 681.

---

## License

Apache-2.0
