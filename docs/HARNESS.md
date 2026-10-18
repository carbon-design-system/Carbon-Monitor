# Carbon Monitor as a harness

Bob is the agent. Carbon Monitor is the harness around it: everything that runs
it on a schedule in IBM Cloud, pays for it, logs it, and reports on it. The
review logic is the one part that is specific to the job.

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
                                     │     ├─ run the agent           agentRunner.runAgent → bob run --format stream-json … (10-minute cap)
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

- **Per-review `HOME`.** `seedBobHome` (`src/reviewBundle.js`) builds
  `<bundle>/home/.bob/` from the real `~/.bob` (`settings.json`,
  `settings/settings.json`, `settings/mcp.json`, `trustedFolders.json` with the
  bundle added, a copy of `rules/`, a symlink to `skills/`) and `runAgent` spawns
  Bob with `HOME` pointed there. Two Bob processes then share no file: task
  history, logs, trust and the MCP header file are each their own. The server
  refreshes the Carbon MCP bearer under its own lock, so a review never needs the
  harness to rewrite its copy mid-flight: a review's copy of `mcp.json` is
  refreshed only at run boundaries, before the first run and again before a
  parse-failure retry (`refreshBobMcp`). Cleanup removes the bundle, and with it
  the home.
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
  a scheduled batch each review consults `bobCredits.isLowBalance` (the check the
  scheduler uses, on the cached balance) before it starts, and a confirmed low
  balance skips it with a reason in the digest. A manual or `--pr` batch is on the
  operator's authority and skips the check. At `REVIEW_CONCURRENCY=1` a scheduled
  batch also runs it, one cached `getBalance` call between reviews.
- **Cost under overlap.** Each review brackets its run with two balance reads. When
  a sibling was in flight at either read, or started during the run, the bracket
  includes the sibling's spend, so the cross-check is skipped and a review with no
  reported cost is recorded as unknown (ledger source `unknown`, no `coinsSpent`)
  instead of with the inflated delta. Bob's result record is the cost of record.

**Sizing.** Bob wants 4 GB per process (its install docs). At `REVIEW_CONCURRENCY=2`
on the default 1 vCPU / 4 GB a large PR may OOM one review; pair 2 with
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

**Other agents.** Only Bob gets a private `HOME`. For any other
`GITHUB_AI_AGENT_CLI` the effective concurrency is 1 and the batch logs one line
saying `REVIEW_CONCURRENCY` was ignored: Claude Code, for one, rewrites
`~/.claude.json` on every run.

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

---

## 2. Harness inventory: keep as is

| Area           | Files                                                                                                                                                                                                                     | Responsibility                                                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Image          | `Dockerfile`                                                                                                                                                                                                              | Debian base, Node 24, the agent install, non-root user, `/workspace`, seeded agent state, healthcheck. The `carbon-builder` fetch block is task layer (section 3, Ground truth)        |
| Deploy         | `deploy_ce.sh`, `docker-compose.yml`                                                                                                                                                                                      | Code Engine create/update, secret sync of the keys `SECRET_KEYS` names, from `.env`, registry secret, scale and timeout flags, `BASE_URL` folded into the revision, Knative annotation |
| Server         | `src/api/server.js`                                                                                                                                                                                                       | routing, static console, the run guard, `202` and poll, log tail, `BASE_URL`-derived OAuth callback                                                                                    |
| Sign-in        | `src/api/sessionAuth.js`                                                                                                                                                                                                  | cookie sessions, bearer auth, the `AUTH_REQUIRED` flag                                                                                                                                 |
| Schedule       | `src/api/scheduleManager.js`                                                                                                                                                                                              | daily run, time-zone handling, idempotency token, auto-pause on low balance                                                                                                            |
| Cost           | `src/api/bobCredits.js`, `src/api/creditLedger.js`                                                                                                                                                                        | per-run spend from the agent's result record (balance delta as fallback), balance from its gateway, per-run spend ledger                                                               |
| Run log        | `src/api/reviewLog.js`, `src/api/reviewProgress.js`                                                                                                                                                                       | in-memory tail the console streams                                                                                                                                                     |
| Health         | `src/api/healthChecks.js` `checkBob`, `checkBobCredits`, `checkElasticsearch`                                                                                                                                             | the harness tiles; the task tiles are in section 3                                                                                                                                     |
| MCP connection | `src/api/mcpConnection.js`                                                                                                                                                                                                | OAuth discovery, PKCE bootstrap, unattended refresh, durable state in Elasticsearch, the config write the agent reads                                                                  |
| Agent runner   | `src/agentRunner.js`                                                                                                                                                                                                      | spawns the CLI in a workspace with a timeout; the agent slot (section 4)                                                                                                               |
| Telemetry      | `src/observability/esClient.js`, `src/observability/eventService.js`                                                                                                                                                      | client with circuit breaker; `emitEvent` with level, scrubbing and the `[metrics:…]` log line                                                                                          |
| Dashboard      | `scripts/init-index.js`, `scripts/init-kibana.js`, `scripts/rebuild-dashboard.js`, `scripts/refresh-kibana-dataview.js`                                                                                                   | index template and ILM, data view, Lens panels                                                                                                                                         |
| Slack          | `src/slackNotifier.js` transport, `postLowTokenAlert`                                                                                                                                                                     | webhook posting, markdown stripping, the low-balance alert                                                                                                                             |
| Console shell  | `client/src/App.jsx`, `Login.jsx`, `StatusTile.jsx`, `SchedulePanel.jsx`, `McpConnectionPanel.jsx`, `ErrorBoundary.jsx`; `BobcoinsPanel.jsx` and `ReviewLog.jsx` stay, with their task-named headings listed in section 3 | Carbon React shell, tiles, settings dialog                                                                                                                                             |
| Config         | `src/loadEnv.js`, `src/config/env.js`                                                                                                                                                                                     | `.env` is authoritative; trimmed reads                                                                                                                                                 |

---

## 3. Task layer inventory: the extension points

Each row is a seam. A SPEC gives every row a decision: keep, configure, modify,
replace, remove, or add.

| Seam                       | File and function                                                                                                                                                                                                                                                                                                                             | What it does today                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | What a new job puts here                                                                                                                                                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Orchestrator               | `src/index.js` `reviewPRs`, with `resolveReviewTargets`, `parsePrNumbers`, `recordReviewCost`, `cleanupBundle`                                                                                                                                                                                                                                | the per-item loop above, PR-shaped                                                                                                                                                                                                                                                                                                                                                                                                                                                       | the same loop over your items; keep the event emits, the cost record and the cleanup                                                                                                                                                |
| Work-item source           | `src/githubClient.js` `createGitHubClient` → `fetchReviewablePRs`, `fetchSinglePR`, `fetchPRFiles`, `fetchPRDiff`                                                                                                                                                                                                                             | lists open PRs, excludes drafts, bots, old and already-labelled PRs; fetches diff and files                                                                                                                                                                                                                                                                                                                                                                                              | a client for your external system: list eligible items, fetch one item                                                                                                                                                              |
| Done marker                | `addReviewedLabel`; `REVIEW_LABEL` and `SKIP_LABELS` in `src/constants.js`; the exclusion inside `fetchReviewablePRs`                                                                                                                                                                                                                         | the `AIReviewed` label is both the receipt and the de-duplication key                                                                                                                                                                                                                                                                                                                                                                                                                    | whatever your system can carry: a label, a field, a tag, a comment, or a record in Elasticsearch                                                                                                                                    |
| Selection limits           | `src/constants.js` `MAX_PRS_PER_RUN`, `N_DAYS_SINCE_PR_CREATED`, `MAX_FILES_PER_PR`, `MAX_INPUT_TOKENS`                                                                                                                                                                                                                                       | caps per run, age window, size gate, token budget                                                                                                                                                                                                                                                                                                                                                                                                                                        | the same knobs under your names                                                                                                                                                                                                     |
| Workspace                  | `src/reviewBundle.js` `buildReviewBundle`, `getWorkspaceRoot`                                                                                                                                                                                                                                                                                 | writes `PR_REVIEW_REQUEST.md`, `pr.json`, `files.json`, `diff.patch`, `.bob/rules/01-output.md`, copies `.bob/skills/carbon-builder`                                                                                                                                                                                                                                                                                                                                                     | the files your agent needs for one item, plus its rules and skills                                                                                                                                                                  |
| Prompt                     | `src/reviewPrompt.js` `buildReviewPrompt`, `estimateTokenUsage`                                                                                                                                                                                                                                                                               | the review rubric and output instructions                                                                                                                                                                                                                                                                                                                                                                                                                                                | your instructions and output contract                                                                                                                                                                                               |
| Output contract and parser | `src/reviewParser.js` `parseReviewOutput`, `computeRecommendation`, `filterUnverifiedCarbonFindings`, `extractCarbonBuilderSkillReads`                                                                                                                                                                                                        | finds the `BEGIN_REVIEW_JSON` block, validates it, detects truncation, computes the recommendation                                                                                                                                                                                                                                                                                                                                                                                       | your markers, your schema, your validity rules                                                                                                                                                                                      |
| Write-back                 | `src/githubClient.js` `postReviewComments`, `postSummaryComment`; `src/reviewPrompt.js` `formatInlineComment`, `formatSummaryComment`; `src/diffMapper.js`                                                                                                                                                                                    | inline comments mapped to diff positions, one summary comment                                                                                                                                                                                                                                                                                                                                                                                                                            | where your results go and how they are rendered                                                                                                                                                                                     |
| Ground truth               | `src/api/mcpConnection.js` (`CARBON_MCP_URL`, `ALWAYS_ALLOW`), the `carbon-builder` skill and its fetch block in the `Dockerfile`, `healthChecks.checkCarbonMcp`, `McpConnectionPanel.jsx`                                                                                                                                                    | Carbon MCP over OAuth, tools the agent may call                                                                                                                                                                                                                                                                                                                                                                                                                                          | another MCP server, or none. There is no off switch today: a blank `CARBON_MCP_URL` falls back to the production URL, so a SPEC choosing none says what happens to the connection module, its refresh timer, the tile and the panel |
| Telemetry vocabulary       | event types in `src/index.js` and `src/slackNotifier.js`; `INDEX_MAPPING` in `scripts/init-index.js`; panels in `scripts/rebuild-dashboard.js`                                                                                                                                                                                                | `run_started`, `run_completed`, `run_failed`, `pr_review_started`, `pr_review_completed`, `pr_review_failed`, `pr_skipped_too_large`, `parse_failed`, `agent_timeout`, `agent_limit_reached`, `skill_unavailable`, `slack_digest_sent`, `slack_digest_failed`; payload fields such as `findings_*`, `recommendation`, `token_*` (including `token_cache_read`, `token_cache_write`, `token_source`), `coins_source`, `bob_task_id`, `tool_calls`, `mcp_tool_calls`, `runs`, `bobcoins_*` | your event names and payload fields; the mapping and panels follow                                                                                                                                                                  |
| Digest content             | `src/slackNotifier.js` `buildPayload` (exported as `_buildPayload`), `_flagFor`                                                                                                                                                                                                                                                               | one line per PR with a verdict flag, count and summary; a run footer                                                                                                                                                                                                                                                                                                                                                                                                                     | one line per item in your terms                                                                                                                                                                                                     |
| Console task surface       | `client/src/pages/Console.jsx` (the Reviews panel, PR-number field, run buttons, "Reviewing pull requests in …"), `client/src/components/ReviewLog.jsx` ("Review output"), `client/src/components/BobcoinsPanel.jsx` ("Spend & recent reviews"), `client/src/pages/HelpGuide.jsx`, `client/src/utils/prPhrasing.js`                           | review-shaped labels and inputs                                                                                                                                                                                                                                                                                                                                                                                                                                                          | your nouns and your inputs                                                                                                                                                                                                          |
| Task API routes            | `src/api/server.js` `POST /api/review/trigger`, `GET /api/review/status`, `GET /api/review/logs`, `POST /api/review/logs/clear`                                                                                                                                                                                                               | trigger with optional PR list, poll, log tail                                                                                                                                                                                                                                                                                                                                                                                                                                            | the same routes under your name; the body validation changes with the item type                                                                                                                                                     |
| Health tiles               | `src/api/healthChecks.js` `checkGitHub`, `checkCarbonMcp`                                                                                                                                                                                                                                                                                     | reachability and quota of the external system and the ground truth                                                                                                                                                                                                                                                                                                                                                                                                                       | a check per external dependency                                                                                                                                                                                                     |
| Env prefix                 | `GITHUB_AI_AGENT_*` across `src/constants.js`, `.env.example`, `deploy_ce.sh`                                                                                                                                                                                                                                                                 | repo, token, limits, label, posting flags                                                                                                                                                                                                                                                                                                                                                                                                                                                | your prefix                                                                                                                                                                                                                         |
| Test fixtures              | `tests/reviewTargeting.test.js`, `tests/reviewablePrs.test.js`, `tests/prTargeting.test.js`, `tests/oversizedPr.test.js`, `tests/linkedIssue.test.js`, `tests/hasCatalogue.test.js`, `tests/carbonBuilderAuthority.test.js`, `tests/reviewPrompt.test.js`, `tests/slackNotifier.test.js`, `tests/test-parser.js`, `tests/test-diff-mapper.js` | review semantics                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | tests for your selection, parsing and write-back rules                                                                                                                                                                              |
| Scratch-target helpers     | `scripts/create-test-pr.js`, `scripts/create-oversized-test-pr.js`                                                                                                                                                                                                                                                                            | create PRs in a scratch repo                                                                                                                                                                                                                                                                                                                                                                                                                                                             | a helper that creates scratch items in your system                                                                                                                                                                                  |

---

## 4. The agent slot

The harness asks four things of a worker agent and nothing else. A fifth applies
to concurrency: only Bob gets a private `HOME` per review (`seedBobHome`), so any
other agent runs with an effective `REVIEW_CONCURRENCY` of 1.

1. A non-interactive invocation that takes a prompt and a working directory and
   exits when done, within a timeout.
2. Authentication by environment variable, so the Code Engine secret can carry it.
3. A configuration file it reads MCP servers from, so `mcpConnection.js` has
   somewhere to write a fresh token.
4. A way to see what a run cost, or at least how many tokens it used.

Everything Bob-specific sits behind those four:

| Concern             | Bob today                                                                                                                                                                                                                                                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Selection           | `GITHUB_AI_AGENT_CLI`, read as `REVIEW_AGENT` in `src/constants.js` and checked against `validAgents` in `src/agentRunner.js`; `deploy_ce.sh` pins it with `--env GITHUB_AI_AGENT_CLI=bob`                                                                                                                                       |
| Invocation          | `bob run --format stream-json --trust --accept-license [--team-id] [--max-cost] [--max-turns] [--disable-tool-groups] "<prompt>"` in `src/agentRunner.js`; resolves `{ text, lastMessage, toolCalls, stats, status, format }`; `BOB_OUTPUT_FORMAT=pretty` drops `--format` and restores the plain-text run; the caps still apply |
| Authentication      | `BOB_API_KEY`, `BOB_TEAM_ID`, `BOB_INSTANCE_ID`                                                                                                                                                                                                                                                                                  |
| MCP configuration   | `~/.bob/settings/mcp.json`, written by `mcpConnection.writeBobMcpHeaders`                                                                                                                                                                                                                                                        |
| Cost                | per-run spend from the result record's `stats.session_costs`, falling back to the balance delta from the Bob gateway admin API in `src/api/bobCredits.js`; the Bobcoins tile; the balance-based auto-pause                                                                                                                       |
| Install and seeding | the pinned tarball and the `~/.bob` seeding blocks in the `Dockerfile`                                                                                                                                                                                                                                                           |
| Rules and skills    | `.bob/rules/` and `.bob/skills/` in each workspace                                                                                                                                                                                                                                                                               |
| Health              | `healthChecks.checkBob`                                                                                                                                                                                                                                                                                                          |

`src/agentRunner.js` already carries `claude` and `codex` cases, never exercised.
`docs/adapt-harness/agents/` has one file per agent with the Dockerfile block,
the runner case, the health check, the config shape and a verification command.
Only the Bob path is production-tested; the others are starting points to verify.

---

## 5. Names that change with the job

Review is baked into names throughout the task layer. A new job renames all of
these, and the SPEC lists each one, old and new.

| Kind                   | Today                                                                                                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API routes             | `/api/review/trigger`, `/api/review/status`, `/api/review/logs`, `/api/review/logs/clear`                                                                                               |
| Console strings        | "Reviews — Automated", "Review output", "Spend & recent reviews", "Pull request numbers", "Review latest N PRs", "Reviewing pull requests in … with the bob agent"                      |
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

**Still single.** The Bobcoins team allocation, the reviewing GitHub account's
rate limit, and the Carbon MCP per-session throttle (120 requests per minute per
session by default, then an hour of 429). The token budget, not the platform, is
the ceiling.

**Prerequisites before building it.** Per-review cost from the agent's result
record (done), worker-tagged logs (done), GitHub write throttling (done), the
ledger of record in Elasticsearch rather than the instance's disk, and a confirmed
answer from the Carbon MCP team on concurrent sessions per bearer at the intended
scale.
