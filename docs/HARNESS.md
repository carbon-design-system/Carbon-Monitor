# Carbon Monitor as a harness

The agent is IBM Bob or Claude. Carbon Monitor is the harness around it:
everything that runs it on a schedule in IBM Cloud, pays for it, logs it, and
reports on it. The review logic is the one part that is specific to the job.

This document is the map for reusing that harness. It names every part you keep,
every part you replace, and the seams between them, with file and function. The
`skills/carbon-monitor-adapt-harness` skill reads it to interview you and write a SPEC; a human
can follow it directly.

---

## 1. The loop

One run, whichever way it starts:

```
  scheduleManager.tick()                  server.js  POST /api/review/trigger        npm start [--pr N]
  reviewPRs({ triggeredBy: 'schedule' })  reviewPRs({ prNumbers })                   reviewPRs()
            └──────────────────────────────────────┬──────────────────────────────────────┘
                                                   ▼
                                   reviewPRs()                       src/index.js
                                     │  emit run_started
                                     ├─► select work items            githubClient.fetchReviewablePRs / fetchSinglePR
                                     │   for each item (REVIEW_CONCURRENCY workers, default 2):
                                     │     ├─ fetch the item          githubClient.fetchPRFiles / fetchPRDiff (+ linked issue)
                                     │     ├─ size gate               MAX_FILES_PER_PR → pr_skipped_too_large, label, comment
                                     │     ├─ build workspace         reviewBundle.buildReviewBundle
                                     │     ├─ run the agent           agentRunner.runAgent → the adapter's CLI, bob run or claude -p (10-minute cap)
                                     │     ├─ parse the output        reviewParser.parseReviewOutput (one retry on parse failure)
                                     │     ├─ write back              githubClient.postReviewComments / postSummaryComment
                                     │     ├─ set the done marker     githubClient.addReviewedLabel
                                     │     ├─ record cost             creditLedger.record
                                     │     ├─ emit pr_review_completed
                                     │     └─ clean the workspace
                                     │  emit run_completed
                                     └─► slackNotifier.postRunDigest   scheduled runs only

  every emit → eventService.emitEvent → esClient → carbon-monitor-events-YYYY.MM → Kibana
  the console polls /api/status · /api/review/status · /api/review/logs · /api/credits · /api/schedule
```

Three invariants hold the loop together. Keep them unless the SPEC says why not.

| Invariant                    | Where                                                                     | Why                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| One batch at a time          | `reviewState.running` in `src/api/server.js`; a second trigger gets `409` | two batches would act on the same item twice; the reviews inside one batch are distinct items    |
| One instance, never zero     | `MIN_SCALE=1`, `MAX_SCALE=1` in `deploy_ce.sh`                            | the refresh timer needs a resident process; the rotating MCP refresh token needs a single writer |
| Done marker after write-back | `addReviewedLabel` runs after the comments post in `src/index.js`         | a crash between the two leaves the item eligible for retry, not silently dropped                 |

### Reviews in flight

Terminal and `ibmcloud ce app logs` output carries the same `[agent <n> #<pr>]` and
`[batch]` tags as the console, including CLI runs (`npm start -- --pr a,b`). The
real stream holds a partial line back until it ends, so in `pretty` mode the
progress dots appear per completed line rather than live.

A batch is one trigger and one ordered PR list, and it stays single-flight: the
scheduler and `POST /api/review/trigger` claim `reviewState.running` before
anything starts, and a second trigger gets the same `409` and message as before.
Inside the batch, `reviewPRs` runs the list through `REVIEW_CONCURRENCY` workers
(default `2`; `1` is the old sequential loop). Workers are numbered from 1; each
takes the next PR in list order, and takes another when its review ends, however
it ends. The digest keeps the original order, one review's failure never reaches
another, and the batch waits for all of them.

Four things keep two reviews from sharing state:

- **Per-review state.** Each adapter's `seedHome` gives a review its own
  config. For Claude that is `<bundle>/claude-config`, which `runAgent` passes
  as `CLAUDE_CONFIG_DIR` (section 4); `HOME` stays real. For Bob it is a private
  `HOME`: `seedBobHome` (`src/reviewBundle.js`) builds `<bundle>/home/.bob/` from
  the real `~/.bob` (`settings.json`,
  `settings/settings.json`, `settings/mcp.json`, `trustedFolders.json` with the
  bundle added, a copy of `rules/`, a symlink to `skills/`) and `runAgent` spawns
  Bob with `HOME` pointed there. Two Bob processes then share no file: task
  history, logs, trust and the MCP header file are each their own. The server
  refreshes the Carbon MCP bearer under its own lock, so a review never needs the
  harness to rewrite its copy mid-flight: a review's copy of `mcp.json` is
  refreshed only at run boundaries, before the first run and again before a
  parse-failure retry (`refreshBobMcp`). Claude's `claude-mcp.json` follows the
  same rule: written from `mcpConnection.getCredentials()` at seeding and
  rewritten by its `refresh` before a retry. Cleanup removes the bundle, and
  with it the home or config directory.
- **Tagged log lines.** `reviewLog.js` keeps an `AsyncLocalStorage` store of
  `{ worker, pr }` set around each review; the child's stream handlers are created
  inside it and inherit it. Every captured line for a review carries `worker` and
  `pr` fields and a `[agent 1 #1234] ` prefix; lines outside any review (the banner,
  the PR list, the digest) get `[batch] `. The real stdout and stderr receive the
  same tagged lines, so `ibmcloud ce app logs` tells two reviews apart. A
  fragment a review leaves without a newline is emitted into its own sequence
  when the review ends.
- **Progress without server imports.** `reviewPRs` calls `options.onProgress({
inFlight, queued, concurrency })`. The server and the scheduler pass a callback
  that updates `reviewState` (`src/api/reviewProgress.js`); the CLI passes none.
- **Serialised ledger and a per-review pause check.** `creditLedger.record` runs
  through a promise chain, so the prune's read-modify-write cannot interleave. In
  a scheduled batch each review consults the agent's `credits()` before it starts
  (for Bob, `bobCredits.isLowBalance` on the cached balance, the check the
  scheduler uses; for Claude, the month-to-date budget when
  `CLAUDE_MONTHLY_BUDGET_USD` is set), and a confirmed low reading skips it with
  a reason in the digest. A manual or `--pr` batch is on the operator's
  authority and skips the check. At `REVIEW_CONCURRENCY=1` a scheduled batch
  also runs it, one cached `getBalance` call between reviews for Bob.
- **Cost under overlap.** Claude has no balance to bracket: its result record is
  the only cost figure, so overlap does not touch it. For Bob, each review
  brackets its run with two balance reads. When a sibling was in flight at either
  read, or started during the run, the bracket includes the sibling's spend, so
  the cross-check is skipped and a review with no reported cost is recorded as
  unknown (ledger source `unknown`, no `coinsSpent`) instead of with the inflated
  delta. Bob's result record is the cost of record.

**Sizing.** Bob wants 4 GB per process (its install docs), and `deploy_ce.sh`
budgets a Claude process the same. At `REVIEW_CONCURRENCY=2` on the default
1 vCPU / 4 GB a large PR may OOM one review; pair 2 with
`MEMORY=8G` in `deploy_ce.sh`, or set `REVIEW_CONCURRENCY=1`. Inference runs
remotely, so CPU is rarely the limit. Reviews post to GitHub through the one
throttled Octokit. Its plugin spaces issue and review comments 3 seconds apart
and other writes 1 second apart, across both workers, so 12 inline comments take
about 36 seconds. The default stays.

**Shared ceiling.** The Carbon MCP server limits each `X-MCP-Session` to 120
requests per minute by default, then answers `429` for an hour. Both reviews
present the same session, so the limit is shared. A review makes a handful of
calls a minute, far under it, and the `mcp_tool_calls` field on each
`pr_review_completed` event is the number to watch if you raise the setting.

**Isolation by agent.** Both built-in adapters are `isolated`: Bob by its
per-review `HOME`, Claude by its per-bundle `CLAUDE_CONFIG_DIR`, because Claude
Code rewrites `~/.claude.json` on every run. An adapter with `isolated: false`,
or an unknown agent, gets an effective concurrency of 1 and the batch logs one
line saying `REVIEW_CONCURRENCY` was ignored.

**Live-check notes.** Two things the offline suite cannot show. Bob finding skills
through the `~/.bob/skills` symlink is unverified; the bundle's own
`.bob/skills/carbon-builder` copy is what a review relies on. And where the
fallback settings path makes Bob run `npx`, each review would cache into its own
`home/.npm`.

**What the tests expect** (`tests/concurrency.test.js`, `evals/concurrency/`):

- Two PRs requested together start together, one per worker.
- Five PRs show 2 in flight and 3 queued, never more than 2 in flight (a status
  poll through the server).
- A second trigger while the batch runs still gets `409` (through
  `handleRequest`).
- A failing review leaves its sibling intact: the sibling posts and labels, the
  failed PR does not.
- `REVIEW_CONCURRENCY=1` is today's sequencing: never two in flight, list order.
- Claude at `REVIEW_CONCURRENCY=2` overlaps two reviews, each in its own
  `CLAUDE_CONFIG_DIR` (`evals/concurrency/06-non-bob-agent.js`).

---

## 2. Harness inventory: keep as is

| Area           | Files                                                                                                                                                                                                                     | Responsibility                                                                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Image          | `Dockerfile`                                                                                                                                                                                                              | Debian base, Node 24, the agent installs (Bob and Claude Code), non-root user, `/workspace`, seeded agent state, healthcheck. The `carbon-builder` fetch block is task layer (section 3, Ground truth) |
| Deploy         | `deploy_ce.sh`, `docker-compose.yml`                                                                                                                                                                                      | Code Engine create/update, secret sync of the keys `SECRET_KEYS` names, from `.env`, registry secret, scale and timeout flags, `BASE_URL` folded into the revision, Knative annotation                 |
| Server         | `src/api/server.js`                                                                                                                                                                                                       | routing, static console, the run guard, `202` and poll, log tail, `BASE_URL`-derived OAuth callback                                                                                                    |
| Sign-in        | `src/api/sessionAuth.js`                                                                                                                                                                                                  | cookie sessions, bearer auth, the `AUTH_REQUIRED` flag                                                                                                                                                 |
| Schedule       | `src/api/scheduleManager.js`                                                                                                                                                                                              | daily run, time-zone handling, idempotency token, auto-pause on low balance                                                                                                                            |
| Cost           | `src/api/bobCredits.js`, `src/api/spend.js`, `src/api/creditLedger.js`                                                                                                                                                    | per-run spend from the agent's result record in its own unit (Bob: balance delta as fallback and balance from its gateway; Claude: month-to-date dollars), per-run spend ledger                        |
| Run log        | `src/api/reviewLog.js`, `src/api/reviewProgress.js`                                                                                                                                                                       | in-memory tail the console streams                                                                                                                                                                     |
| Health         | `src/api/healthChecks.js` `checkAgent`, `checkBobCredits`, `checkSpend`, `checkElasticsearch`                                                                                                                             | the harness tiles (`checkBobCredits` for Bob, `checkSpend` for Claude); the task tiles are in section 3                                                                                                |
| MCP connection | `src/api/mcpConnection.js`                                                                                                                                                                                                | OAuth discovery, PKCE bootstrap, unattended refresh, durable state in Elasticsearch, the config write the agent reads                                                                                  |
| Agent runner   | `src/agentRunner.js`, `src/agents/`                                                                                                                                                                                       | spawns the adapter's CLI in a workspace with a timeout and folds its event stream; the agent slot (section 4)                                                                                          |
| Telemetry      | `src/observability/esClient.js`, `src/observability/eventService.js`                                                                                                                                                      | client with circuit breaker; `emitEvent` with level, scrubbing and the `[metrics:…]` log line                                                                                                          |
| Dashboard      | `scripts/init-index.js`, `scripts/init-kibana.js`, `scripts/rebuild-dashboard.js`, `scripts/refresh-kibana-dataview.js`                                                                                                   | index template and ILM, data view, Lens panels                                                                                                                                                         |
| Slack          | `src/slackNotifier.js` transport, `postLowTokenAlert` (names the agent's budget and the remedy for its unit)                                                                                                              | webhook posting, markdown stripping, the low-balance alert                                                                                                                                             |
| Console shell  | `client/src/App.jsx`, `Login.jsx`, `StatusTile.jsx`, `SchedulePanel.jsx`, `McpConnectionPanel.jsx`, `ErrorBoundary.jsx`; `BobcoinsPanel.jsx` and `ReviewLog.jsx` stay, with their task-named headings listed in section 3 | Carbon React shell, tiles, settings dialog                                                                                                                                                             |
| Config         | `src/loadEnv.js`, `src/config/env.js`                                                                                                                                                                                     | `.env` is authoritative; trimmed reads                                                                                                                                                                 |

---

## 3. Task layer inventory: the extension points

Each row is a seam. A SPEC gives every row a decision: keep, configure, modify,
replace, remove, or add.

| Seam                       | File and function                                                                                                                                                                                                                                                                                                                             | What it does today                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | What a new job puts here                                                                                                                                                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Orchestrator               | `src/index.js` `reviewPRs`, with `resolveReviewTargets`, `parsePrNumbers`, `recordReviewCost`, `cleanupBundle`                                                                                                                                                                                                                                | the per-item loop above, PR-shaped                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | the same loop over your items; keep the event emits, the cost record and the cleanup                                                                                                                                                |
| Work-item source           | `src/githubClient.js` `createGitHubClient` → `fetchReviewablePRs`, `fetchSinglePR`, `fetchPRFiles`, `fetchPRDiff`                                                                                                                                                                                                                             | lists open PRs, excludes drafts, bots, old and already-labelled PRs; fetches diff and files                                                                                                                                                                                                                                                                                                                                                                                                                                             | a client for your external system: list eligible items, fetch one item                                                                                                                                                              |
| Done marker                | `addReviewedLabel`; `REVIEW_LABEL` and `SKIP_LABELS` in `src/constants.js`; the exclusion inside `fetchReviewablePRs`                                                                                                                                                                                                                         | the `AIReviewed` label is both the receipt and the de-duplication key                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | whatever your system can carry: a label, a field, a tag, a comment, or a record in Elasticsearch                                                                                                                                    |
| Selection limits           | `src/constants.js` `MAX_PRS_PER_RUN`, `N_DAYS_SINCE_PR_CREATED`, `MAX_FILES_PER_PR`, `MAX_INPUT_TOKENS`                                                                                                                                                                                                                                       | caps per run, age window, size gate, token budget                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | the same knobs under your names                                                                                                                                                                                                     |
| Workspace                  | `src/reviewBundle.js` `buildReviewBundle`, `getWorkspaceRoot`                                                                                                                                                                                                                                                                                 | writes `PR_REVIEW_REQUEST.md`, `pr.json`, `files.json`, `diff.patch`, then the agent's rules and the Carbon Builder skill through `adapter.prepareBundle` (`.bob/rules/01-output.md` and `.bob/skills/carbon-builder` for Bob, `CLAUDE.md` and `.claude/skills/carbon-builder` for Claude)                                                                                                                                                                                                                                              | the files your agent needs for one item, plus its rules and skills                                                                                                                                                                  |
| Prompt                     | `src/reviewPrompt.js` `buildReviewPrompt`, `estimateTokenUsage`                                                                                                                                                                                                                                                                               | the review rubric and output instructions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | your instructions and output contract                                                                                                                                                                                               |
| Output contract and parser | `src/reviewParser.js` `parseReviewOutput`, `computeRecommendation`, `filterUnverifiedCarbonFindings`, `extractCarbonBuilderSkillReads`                                                                                                                                                                                                        | finds the `BEGIN_REVIEW_JSON` block, validates it, detects truncation, computes the recommendation                                                                                                                                                                                                                                                                                                                                                                                                                                      | your markers, your schema, your validity rules                                                                                                                                                                                      |
| Write-back                 | `src/githubClient.js` `postReviewComments`, `postSummaryComment`; `src/reviewPrompt.js` `formatInlineComment`, `formatSummaryComment`; `src/diffMapper.js`                                                                                                                                                                                    | inline comments mapped to diff positions, one summary comment                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | where your results go and how they are rendered                                                                                                                                                                                     |
| Ground truth               | `src/api/mcpConnection.js` (`CARBON_MCP_URL`, `ALWAYS_ALLOW`, `getCredentials`), the `carbon-builder` skill and its fetch block in the `Dockerfile`, `healthChecks.checkCarbonMcp`, `McpConnectionPanel.jsx`                                                                                                                                  | Carbon MCP over OAuth, tools the agent may call                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | another MCP server, or none. There is no off switch today: a blank `CARBON_MCP_URL` falls back to the production URL, so a SPEC choosing none says what happens to the connection module, its refresh timer, the tile and the panel |
| Telemetry vocabulary       | event types in `src/index.js` and `src/slackNotifier.js`; `INDEX_MAPPING` in `scripts/init-index.js`; panels in `scripts/rebuild-dashboard.js`                                                                                                                                                                                                | `run_started`, `run_completed`, `run_failed`, `pr_review_started`, `pr_review_completed`, `pr_review_failed`, `pr_skipped_too_large`, `parse_failed`, `agent_timeout`, `agent_limit_reached`, `skill_unavailable`, `slack_digest_sent`, `slack_digest_failed`; payload fields such as `findings_*`, `recommendation`, `token_*` (including `token_cache_read`, `token_cache_write`, `token_source`), `cost_unit`, `coins_source`, `bob_task_id` (carries Claude's session id too), `tool_calls`, `mcp_tool_calls`, `runs`, `bobcoins_*` | your event names and payload fields; the mapping and panels follow                                                                                                                                                                  |
| Digest content             | `src/slackNotifier.js` `buildPayload` (exported as `_buildPayload`), `_flagFor`                                                                                                                                                                                                                                                               | one line per PR with a verdict flag, count and summary; a run footer                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | one line per item in your terms                                                                                                                                                                                                     |
| Console task surface       | `client/src/pages/Console.jsx` (the Reviews panel, PR-number field, run buttons, "Reviewing pull requests in …"), `client/src/components/ReviewLog.jsx` ("Review output"), `client/src/components/BobcoinsPanel.jsx` ("Spend & recent reviews"), `client/src/pages/HelpGuide.jsx`, `client/src/utils/prPhrasing.js`                           | review-shaped labels and inputs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | your nouns and your inputs                                                                                                                                                                                                          |
| Task API routes            | `src/api/server.js` `POST /api/review/trigger`, `GET /api/review/status`, `GET /api/review/logs`, `POST /api/review/logs/clear`                                                                                                                                                                                                               | trigger with optional PR list, poll, log tail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | the same routes under your name; the body validation changes with the item type                                                                                                                                                     |
| Health tiles               | `src/api/healthChecks.js` `checkGitHub`, `checkCarbonMcp`                                                                                                                                                                                                                                                                                     | reachability and quota of the external system and the ground truth                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | a check per external dependency                                                                                                                                                                                                     |
| Env prefix                 | `GITHUB_AI_AGENT_*` across `src/constants.js`, `.env.example`, `deploy_ce.sh`                                                                                                                                                                                                                                                                 | repo, token, limits, label, posting flags                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | your prefix                                                                                                                                                                                                                         |
| Test fixtures              | `tests/reviewTargeting.test.js`, `tests/reviewablePrs.test.js`, `tests/prTargeting.test.js`, `tests/oversizedPr.test.js`, `tests/linkedIssue.test.js`, `tests/hasCatalogue.test.js`, `tests/carbonBuilderAuthority.test.js`, `tests/reviewPrompt.test.js`, `tests/slackNotifier.test.js`, `tests/test-parser.js`, `tests/test-diff-mapper.js` | review semantics                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | tests for your selection, parsing and write-back rules                                                                                                                                                                              |
| Scratch-target helpers     | `scripts/create-test-pr.js`, `scripts/create-oversized-test-pr.js`                                                                                                                                                                                                                                                                            | create PRs in a scratch repo                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | a helper that creates scratch items in your system                                                                                                                                                                                  |

---

## 4. The agent slot

The harness asks four things of a worker agent and nothing else:

1. A non-interactive invocation that takes a prompt and a working directory and
   exits when done, within a timeout.
2. Authentication by environment variable, so the Code Engine secret can carry it.
3. A configuration file it reads MCP servers from, so `mcpConnection.js` has
   somewhere to write a fresh token.
4. A way to see what a run cost, or at least how many tokens it used.

Two agents are built in: IBM Bob (`bob`, the default) and Claude (`claude`).
Everything agent-specific sits in one adapter file per agent in `src/agents/`.
The runner, the bundle builder, the orchestrator, the health checks and the
scheduler call the adapter and do not name an agent. The cost tile, the spend
panel and the Slack remedy still branch on `costUnit`.
`GITHUB_AI_AGENT_CLI` selects one; `deploy_ce.sh` passes it through from `.env`.

### The registry

`src/agents/index.js` is the only list of agents. Nothing else keeps one: the
`GITHUB_AI_AGENT_CLI` check, the startup key check in `src/config/env.js`, the
readiness probe and the concurrency rule all read it.

| Export                                  | What it does                                                                                                         |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `get(id)`                               | The adapter for `id` (default: the configured agent). Throws `Invalid agent type: <id>. Must be one of: bob, claude` |
| `find(id)`                              | The adapter, or `null` for an unknown id                                                                             |
| `ids()`                                 | The registered ids, in order                                                                                         |
| `current()`                             | `get(REVIEW_AGENT)`, the agent `GITHUB_AI_AGENT_CLI` names                                                           |
| `resolve(id)`                           | For status surfaces: the named agent (default: the environment now), else Bob. Never throws                          |
| `effectiveConcurrency(adapter, wanted)` | `wanted` for an isolated agent, otherwise `1`                                                                        |
| `DEFAULT_ID`                            | `'bob'`                                                                                                              |

`src/agents/common.js` holds what both adapters share: the Carbon MCP server and
tool names, `contentToText`, `mcpToolName` and `summarize`, which builds the
evidence summary.

### The adapter contract

| Member                                               | Contract                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `displayName`, `cliName`                       | `bob`, IBM Bob, Bob Shell CLI; `claude`, Claude, Claude Code CLI. The id appears in logs, events and readiness reasons, `displayName` in the PR comment and the console sentence, `cliName` as the agent tile label                                                                                                           |
| `binary`, `requiredEnv`                              | The executable on `PATH` and the environment variable that authenticates it (`BOB_API_KEY`, `ANTHROPIC_API_KEY`)                                                                                                                                                                                                              |
| `costUnit`, `creditLabel`, `resultSource`            | The unit the agent spends in (`bobcoins`, `usd`), the name the console and Slack give its budget (`Bobcoins`, `Claude budget`), and the ledger source for a cost read from its result record (`bob-result`, `claude-result`)                                                                                                  |
| `isolated`                                           | `true` when two runs share no per-user state. Only an isolated agent runs `REVIEW_CONCURRENCY` reviews at once                                                                                                                                                                                                                |
| `skill { tool, dir, sentinel, pattern }`             | How the agent invokes the Carbon Builder skill: the tool name, the directory in the bundle, the sentinel the log records for a tool-call match, and the transcript pattern that is the fallback evidence                                                                                                                      |
| `defaults()`                                         | `{ format, caps }` used when `runAgent` is called without them                                                                                                                                                                                                                                                                |
| `streams(format)`                                    | Whether stdout is an NDJSON event stream the collector parses. Bob returns `false` for `pretty`; Claude always `true`                                                                                                                                                                                                         |
| `buildArgs({ prompt, format, caps, bundleDir })`     | The argument vector. The prompt goes last                                                                                                                                                                                                                                                                                     |
| `env(base, { home, bundleDir })`                     | The child's environment, built from the harness's                                                                                                                                                                                                                                                                             |
| `prepareBundle(bundleDir, { rules, skillSource })`   | Writes the agent's rules file and skill into the bundle, and any credential file it needs                                                                                                                                                                                                                                     |
| `seedHome(bundleDir, creds)`                         | Builds the agent's private state and returns `{ home, refresh }`. `creds` is `mcpConnection.getCredentials()`. The seeded state carries the bearer for the first run, and `refresh()` re-applies a renewed one before a parse-failure retry                                                                                   |
| `promptFragments`                                    | The four strings that vary in `buildReviewPrompt`: `noCompletion`, `noFileWrite`, `skillPath`, `readTool`. Bob's are the exact text of the prompt before adapters existed, pinned by a snapshot test                                                                                                                          |
| `parseEvent(json, state)`                            | One parsed NDJSON line in, a normalised event, an array of them, or `null` out. `state` is per run, for counters                                                                                                                                                                                                              |
| `finalizeText(text, toolCalls)`, `plainText(stdout)` | Optional, Bob only: strip Bob's continuation notice and append the `attempt_completion` result; keep the last `## Step 1` of a `pretty` run                                                                                                                                                                                   |
| `evidence(toolCalls)`                                | `{ skillInvoked, skillFiles, mcpCalls, total }` from the observed tool calls                                                                                                                                                                                                                                                  |
| `credits()`                                          | `{ available, low, threshold, remaining, percentRemaining, reason, summary }`, where `low` is a confirmed low reading and `summary` is the skip and pause text. The per-review skip uses it for every agent. The scheduler and `/api/credits` use it for agents not billed in Bobcoins; Bob's paths call the gateway directly |

### Normalised events

`parseEvent` is the only code that knows an agent's wire format. The collector in
`src/agentRunner.js` consumes these types and nothing else:

| Type          | Fields                                                | Effect                                                                                                                                                                                                                                                                                                      |
| ------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init`        | `model`, `mcpServers [{ name, status }]`, `skills []` | Logged once as `🧭 <agent> session: …`. A `carbon-mcp` status other than `connected`, or a skill list without `carbon-builder`, is a warning. The skill list includes the CLI's own bundled skills (19 in a live run), so only a missing `carbon-builder` warns. Claude only                                |
| `text`        | `text`, `messageId`                                   | Joins the current message when the previous event was text with the same `messageId` (Bob has none, so its pieces join). A new message is joined to the others by a blank line                                                                                                                              |
| `tool_use`    | `id`, `name`, `params`, optional `server`, `tool`     | Recorded as a tool call and printed as `⚙ <tool>`. Ends the current message                                                                                                                                                                                                                                 |
| `tool_result` | `id`, `status`                                        | Sets the status of the call with that `id`                                                                                                                                                                                                                                                                  |
| `error`       | `message`, `severity`, `limit`                        | Recorded and printed as `⚠ …`. A `limit` of `cost-limit` or `turn-limit` fails a run that did not finish cleanly as that kind                                                                                                                                                                               |
| `result`      | `status`, `stats`, `lastMessage`, `limit`, `denials`  | The end of the run. `stats` keeps the shape `task_id`, `session_costs`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `total_tokens`, `duration_ms`, `tool_calls` and, from Claude, `cost_unit`. `denials` is a list of tool names the agent was refused, logged as a warning |
| `break`       | none                                                  | Ends the current message, so the next text starts a new one                                                                                                                                                                                                                                                 |

`runAgent` rejects with an `AgentRunError` whose `kind` is `timeout`,
`cost-limit`, `turn-limit`, `agent-error` (a result with an error status),
`exit` (a non-zero exit with no better reason) or `spawn`. It resolves with
`{ text, lastMessage, toolCalls, stats, status, format }`.

### Bob and Claude as built

| Concern           | Bob                                                                                                                                                                                                                                  | Claude                                                                                                                                                                                                                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Selection         | `GITHUB_AI_AGENT_CLI=bob` (the default)                                                                                                                                                                                              | `GITHUB_AI_AGENT_CLI=claude`                                                                                                                                                                                                                                                                                                           |
| Invocation        | `bob run --format stream-json --trust --accept-license [--team-id] [--max-cost] [--max-turns] [--disable-tool-groups] "<prompt>"`. `BOB_OUTPUT_FORMAT=pretty` drops `--format` and restores the plain-text run; the caps still apply | `claude -p --output-format stream-json --verbose --permission-mode dontAsk --permission-prompts none --allowedTools … --disallowedTools … --mcp-config <bundle>/claude-config/claude-mcp.json --strict-mcp-config --setting-sources project --no-session-persistence --model … --effort … [--max-budget-usd] [--max-turns] "<prompt>"` |
| Authentication    | `BOB_API_KEY`, `BOB_TEAM_ID`, `BOB_INSTANCE_ID`                                                                                                                                                                                      | `ANTHROPIC_API_KEY`                                                                                                                                                                                                                                                                                                                    |
| Isolation         | A private `HOME` per review (`<bundle>/home/.bob/`). The child gets the harness's whole environment                                                                                                                                  | A private `CLAUDE_CONFIG_DIR` per review (`<bundle>/claude-config`); `HOME` stays real. Nothing is seeded: the CLI creates its own `.claude.json`, `policy-limits.json`, `projects/` and `sessions/` there on first run. The child gets an allowlist, none of the harness's secrets                                                    |
| MCP configuration | `~/.bob/settings/mcp.json`, written by `mcpConnection.writeBobMcpHeaders`, copied into each review's home                                                                                                                            | `<bundle>/claude-config/claude-mcp.json` at mode 0600, written from `mcpConnection.getCredentials()`, which reads the same `mcp.json` the refresh timer maintains                                                                                                                                                                      |
| Rules and skills  | `.bob/rules/01-output.md` and `.bob/skills/carbon-builder` in the bundle, and a bundle `.env` with `BOB_API_KEY`                                                                                                                     | `CLAUDE.md` with the same rules, `.claude/skills/carbon-builder`, and `.claude/settings.json`; no `.env`                                                                                                                                                                                                                               |
| Cost              | `stats.session_costs` from the result record in Bobcoins, with the gateway balance delta as the fallback (`src/api/bobCredits.js`); the Bobcoins tile; the balance-based auto-pause                                                  | `total_cost_usd` from the result record in dollars; no balance. The `spend` tile; with `CLAUDE_MONTHLY_BUDGET_USD` set, month-to-date spend from `src/api/spend.js` drives the pause                                                                                                                                                   |
| Install           | The pinned tarball and the `~/.bob` seeding blocks in the `Dockerfile`                                                                                                                                                               | `npm install -g @anthropic-ai/claude-code@2.1.302` in the `Dockerfile`, with `DISABLE_AUTOUPDATER=1`                                                                                                                                                                                                                                   |
| Health            | `healthChecks.checkAgent` (`bob --version`, then `BOB_API_KEY`) and `checkBobCredits`                                                                                                                                                | `healthChecks.checkAgent` (`claude --version`, then `ANTHROPIC_API_KEY`) and `checkSpend`                                                                                                                                                                                                                                              |

The settings behind the Claude column are in
[CONFIGURATION.md](CONFIGURATION.md#claude-code). `docs/adapt-harness/agents/`
has a note per agent: `bob.md` and `claude-code.md` describe the built adapters,
and the other three map what an adapter for that CLI would need.

### Add an agent

An agent is one adapter file and a few lines around it. Start from
`src/agents/claude.js` for a CLI that streams JSON events, or `bob.js` for one
with a plain-text mode.

1. **Adapter.** Add `src/agents/<id>.js` that exports every member above.
   Settings it reads belong in `src/constants.js`, with their defaults, in the
   `CLAUDE_*` pattern.
2. **Registry.** Add one `require` to `ADAPTERS` in `src/agents/index.js`. That
   makes the id valid for `GITHUB_AI_AGENT_CLI`, makes `requiredEnv` a startup
   warning and a red agent tile when unset, and feeds readiness, the prompt, the
   scheduler and the concurrency rule.
3. **Image.** Add one install block to the `Dockerfile`, pinned, with the CLI's
   auto-update turned off and a check that it installed. If the CLI cannot run
   under the emulation a build host uses, check the installed version and the
   binary's architecture instead, as the Claude block does.
4. **Configuration.** Add one block to `.env.example`. In `deploy_ce.sh`, add the
   key to the `SECRET_KEYS` default, a guard that refuses to deploy without it
   when this agent is selected, and an `--env` line for each setting. (A
   `SECRET_KEYS` set in `.env` replaces the whole default list, so it must
   repeat every key.)
5. **Console and alerts.** The cost views are not generic yet. Add the agent's
   mark under `client/src/assets/agents/` and a branch for the agent's id in
   `client/src/components/BobcoinsPanel.jsx`, an entry for its unit in
   `LOW_CREDIT_ACTION` in `src/slackNotifier.js` (other units fall back to the
   Bobcoins text), and the agent's name in `client/src/pages/HelpGuide.jsx` and
   `client/src/components/AboutAi.jsx`. Today the `spend` tile, the monthly
   budget variables (`CLAUDE_MONTHLY_BUDGET_USD`, `CLAUDE_BUDGET_LOW_PCT`) and
   the `usd` ledger unit are Claude's: the panel's `usd` branch shows Claude's
   mark, `checkSpend` reads the Claude variables for any agent not billed in
   Bobcoins, and the ledger and `src/api/spend.js` filter by unit or source,
   not by agent. A second dollar-billed agent needs its own budget variables
   and a unit or agent filter, or its spend would mix with Claude's.
6. **Documentation.** Add a row to "Supported agents" in `README.md`, the
   settings to `docs/CONFIGURATION.md`, and a note under `docs/adapt-harness/agents/`.
7. **Tests.** Add a fake CLI at `tests/fixtures/bin/<binary>` that checks the flags
   the adapter must send and replays NDJSON from `tests/fixtures/<id>/` in split
   chunks, as `tests/fixtures/bin/claude` does. Extend `tests/agents.test.js`
   (every adapter must carry the full contract), `tests/agentRunner.test.js`,
   `tests/evidence.test.js`, `tests/reviewPrompt.test.js` and
   `tests/healthChecks.test.js`. Add a whole-review file like
   `tests/claudeReview.test.js`, which runs through the mock GitHub server in
   `tests/fixtures/concurrencyHarness.js`, and put it in `test:all` in
   `package.json`.

A CLI with no JSON stream can still be an adapter: `streams()` returns `false`
and the runner takes stdout as the review text. An agent whose `costUnit` is not
`bobcoins` has no balance to bracket, so the `stats.session_costs` of its result
record is the only cost figure, and a run without one is recorded as unknown.

---

## 5. Names that change with the job

Review is baked into names throughout the task layer. A new job renames all of
these, and the SPEC lists each one, old and new.

| Kind                   | Today                                                                                                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API routes             | `/api/review/trigger`, `/api/review/status`, `/api/review/logs`, `/api/review/logs/clear`                                                                                               |
| Console strings        | "Reviews — Automated", "Review output", "Spend & recent reviews", "Pull request numbers", "Review latest N PRs", "Reviewing pull requests in … with <agentName>" (IBM Bob or Claude)    |
| Env prefix             | `GITHUB_AI_AGENT_*`                                                                                                                                                                     |
| Event types            | the `pr_review_*` and `pr_skipped_*` names                                                                                                                                              |
| Elasticsearch          | alias `carbon-monitor-events`, template `carbon-monitor-events-template`, ILM policy `carbon-monitor-events-ilm`, the `payload.*` review fields, state index `carbon-monitor-mcp-state` |
| State files            | `carbon-monitor-schedule.json` (`src/api/scheduleManager.js`) and `carbon-monitor-credit-ledger.jsonl` (`src/api/creditLedger.js`), both beside `MCP_STATE_PATH`                        |
| Kibana                 | data view `carbon-monitor-index-pattern`, dashboard `carbon-monitor-dashboard`, the seven panel titles in `scripts/rebuild-dashboard.js`                                                |
| Slack                  | "Review Digest", verdict wording, "PRs reviewed"                                                                                                                                        |
| External-system marker | the `AIReviewed` label                                                                                                                                                                  |
| Product identity       | `carbon-monitor` in `package.json`, `APP`, `IMAGE_NAME`, `SECRET_NAME`, the console header                                                                                              |

Two deployments that share one Elasticsearch cluster must rename the alias, the
state index and the state files, because the spend summary in `src/api/server.js`
does not filter by repository.

---

## 6. Two paths

**PR reviews for another repository.** Set `GITHUB_AI_AGENT_OWNER` and
`GITHUB_AI_AGENT_REPO`; give the reviewing account Triage on that repository
(`docs/GITHUB_ACCESS.md`); adjust the limits and labels; keep, trim or replace
the rubric in `src/reviewPrompt.js`; keep Carbon MCP or point `CARBON_MCP_URL`
at another server; pick the worker agent; set the schedule, Slack and sign-in in
`.env`; deploy with `./deploy_ce.sh`. Nothing in section 5 changes.

**A different job on the harness.** Decide every row of section 3; replace the
work-item source, the workspace builder, the prompt, the parser and the
write-back; modify the orchestrator, the event payloads, the digest and the
console labels; rename everything in section 5; keep section 2 untouched and
the invariants in section 1 intact; add tests for the new selection, parsing
and write-back rules; deploy with the same script.

The skill at `skills/carbon-monitor-adapt-harness/` walks either path by interview and writes
the SPEC. Its README has the install command.

## 7. Scale-out: workers as Code Engine jobs (design, not implemented)

`REVIEW_CONCURRENCY` (section 1) scales reviews inside one instance. When one
task outgrows one instance, the next step is to split the harness into a control
plane and workers. Nothing below exists in the code yet; it is the design the
current invariants were chosen to allow.

**Control plane.** Today's app, unchanged in role: the console, the webhook, the
scheduler, the single Carbon MCP refresh writer, and the dispatcher. It keeps
`MIN_SCALE=1` and `MAX_SCALE=1`, because the refresh token rotates and needs one
writer, and because the timer that renews it must be resident.

**Workers.** The same image run as a Code Engine job, not an app. One job run per
work item, or an array run of N. A worker reads the current Carbon MCP bearer and
session from the Elasticsearch state document, claims its item, reviews, posts,
sets the done marker and exits. Jobs allow 7 200 seconds per run by default (up to
86 400), up to 1 000 parallel instances, scale to zero between runs, and are not
bound by the 600-second request timeout that applies to apps. The control plane
submits runs through the Code Engine API and prunes old job runs, since a project
holds 100 before cleanup is needed.

**Claim.** An Elasticsearch document per item (`<repo>#<pr>`) created with
`op_type: create`, so a second worker's claim fails atomically, with an expiry so
a crashed worker's item is retried. The done marker on the item stays the durable
receipt; the claim only prevents two workers starting the same item.

**Invariants restated.** One refresh writer; one control plane that never scales
to zero; the done marker set after write-back. "One batch at a time" becomes "one
claim per item".

**Still single.** The agent's budget (the Bobcoins team allocation for Bob, the
Anthropic account's spend for Claude), the reviewing GitHub account's
rate limit, and the Carbon MCP per-session throttle (120 requests per minute per
session by default, then an hour of 429). The token budget, not the platform, is
the ceiling.

**Prerequisites before building it.** Per-review cost from the agent's result
record (done), worker-tagged logs (done), GitHub write throttling (done), the
ledger of record in Elasticsearch rather than the instance's disk, and a confirmed
answer from the Carbon MCP team on concurrent sessions per bearer at the intended
scale.
