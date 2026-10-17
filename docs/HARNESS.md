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
                                     │   for each item:
                                     │     ├─ fetch the item          githubClient.fetchPRFiles / fetchPRDiff (+ linked issue)
                                     │     ├─ size gate               MAX_FILES_PER_PR → pr_skipped_too_large, label, comment
                                     │     ├─ build workspace         reviewBundle.buildReviewBundle
                                     │     ├─ run the agent           agentRunner.runAgent → bob run … (10-minute cap)
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

| Invariant | Where | Why |
|-----------|-------|-----|
| One run at a time | `reviewState.running` in `src/api/server.js`; a second trigger gets `409` | two runs would act on the same item twice |
| One instance, never zero | `MIN_SCALE=1`, `MAX_SCALE=1` in `deploy_ce.sh` | the refresh timer needs a resident process; the rotating MCP refresh token needs a single writer |
| Done marker after write-back | `addReviewedLabel` runs after the comments post in `src/index.js` | a crash between the two leaves the item eligible for retry, not silently dropped |

---

## 2. Harness inventory: keep as is

| Area | Files | Responsibility |
|------|-------|----------------|
| Image | `Dockerfile` | Debian base, Node 22, the agent install, non-root user, `/workspace`, seeded agent state, healthcheck. The `carbon-builder` fetch block is task layer (section 3, Ground truth) |
| Deploy | `deploy_ce.sh`, `docker-compose.yml` | Code Engine create/update, secret sync of the keys `SECRET_KEYS` names, from `.env`, registry secret, scale and timeout flags, `BASE_URL` folded into the revision, Knative annotation |
| Server | `src/api/server.js` | routing, static console, the run guard, `202` and poll, log tail, `BASE_URL`-derived OAuth callback |
| Sign-in | `src/api/sessionAuth.js` | cookie sessions, bearer auth, the `AUTH_REQUIRED` flag |
| Schedule | `src/api/scheduleManager.js` | daily run, time-zone handling, idempotency token, auto-pause on low balance |
| Cost | `src/api/bobCredits.js`, `src/api/creditLedger.js` | balance from the agent's gateway, per-run spend ledger |
| Run log | `src/api/reviewLog.js` | in-memory tail the console streams |
| Health | `src/api/healthChecks.js` `checkBob`, `checkBobCredits`, `checkElasticsearch` | the harness tiles; the task tiles are in section 3 |
| MCP connection | `src/api/mcpConnection.js`, `src/api/tokenManager.js` | OAuth discovery, PKCE bootstrap, unattended refresh, durable state in Elasticsearch, the config write the agent reads |
| Agent runner | `src/agentRunner.js` | spawns the CLI in a workspace with a timeout; the agent slot (section 4) |
| Telemetry | `src/observability/esClient.js`, `src/observability/eventService.js` | client with circuit breaker; `emitEvent` with level, scrubbing and the `[metrics:…]` log line |
| Dashboard | `scripts/init-index.js`, `scripts/init-kibana.js`, `scripts/rebuild-dashboard.js`, `scripts/refresh-kibana-dataview.js` | index template and ILM, data view, Lens panels |
| Slack | `src/slackNotifier.js` transport, `postLowTokenAlert` | webhook posting, markdown stripping, the low-balance alert |
| Console shell | `client/src/App.jsx`, `Login.jsx`, `StatusTile.jsx`, `SchedulePanel.jsx`, `McpConnectionPanel.jsx`, `ErrorBoundary.jsx`; `BobcoinsPanel.jsx` and `ReviewLog.jsx` stay, with their task-named headings listed in section 3 | Carbon React shell, tiles, settings dialog |
| Config | `src/loadEnv.js`, `src/config/env.js` | `.env` is authoritative; trimmed reads |

---

## 3. Task layer inventory: the extension points

Each row is a seam. A SPEC gives every row a decision: keep, configure, modify,
replace, remove, or add.

| Seam | File and function | What it does today | What a new job puts here |
|------|-------------------|--------------------|--------------------------|
| Orchestrator | `src/index.js` `reviewPRs`, with `resolveReviewTargets`, `parsePrNumbers`, `recordReviewCost`, `cleanupBundle` | the per-item loop above, PR-shaped | the same loop over your items; keep the event emits, the cost record and the cleanup |
| Work-item source | `src/githubClient.js` `createGitHubClient` → `fetchReviewablePRs`, `fetchSinglePR`, `fetchPRFiles`, `fetchPRDiff` | lists open PRs, excludes drafts, bots, old and already-labelled PRs; fetches diff and files | a client for your external system: list eligible items, fetch one item |
| Done marker | `addReviewedLabel`; `REVIEW_LABEL` and `SKIP_LABELS` in `src/constants.js`; the exclusion inside `fetchReviewablePRs` | the `AIReviewed` label is both the receipt and the de-duplication key | whatever your system can carry: a label, a field, a tag, a comment, or a record in Elasticsearch |
| Selection limits | `src/constants.js` `MAX_PRS_PER_RUN`, `N_DAYS_SINCE_PR_CREATED`, `MAX_FILES_PER_PR`, `MAX_INPUT_TOKENS` | caps per run, age window, size gate, token budget | the same knobs under your names |
| Workspace | `src/reviewBundle.js` `buildReviewBundle`, `getWorkspaceRoot` | writes `PR_REVIEW_REQUEST.md`, `pr.json`, `files.json`, `diff.patch`, `.bob/rules/01-output.md`, copies `.bob/skills/carbon-builder` | the files your agent needs for one item, plus its rules and skills |
| Prompt | `src/reviewPrompt.js` `buildReviewPrompt`, `estimateTokenUsage` | the review rubric and output instructions | your instructions and output contract |
| Output contract and parser | `src/reviewParser.js` `parseReviewOutput`, `computeRecommendation`, `filterUnverifiedCarbonFindings`, `extractCarbonBuilderSkillReads` | finds the `BEGIN_REVIEW_JSON` block, validates it, detects truncation, computes the recommendation | your markers, your schema, your validity rules |
| Write-back | `src/githubClient.js` `postReviewComments`, `postSummaryComment`; `src/reviewPrompt.js` `formatInlineComment`, `formatSummaryComment`; `src/diffMapper.js` | inline comments mapped to diff positions, one summary comment | where your results go and how they are rendered |
| Ground truth | `src/api/mcpConnection.js` (`CARBON_MCP_URL`, `ALWAYS_ALLOW`), the `carbon-builder` skill and its fetch block in the `Dockerfile`, `healthChecks.checkCarbonMcp`, `McpConnectionPanel.jsx` | Carbon MCP over OAuth, tools the agent may call | another MCP server, or none. There is no off switch today: a blank `CARBON_MCP_URL` falls back to the production URL, so a SPEC choosing none says what happens to the connection module, its refresh timer, the tile and the panel |
| Telemetry vocabulary | event types in `src/index.js` and `src/slackNotifier.js`; `INDEX_MAPPING` in `scripts/init-index.js`; panels in `scripts/rebuild-dashboard.js` | `run_started`, `run_completed`, `run_failed`, `pr_review_started`, `pr_review_completed`, `pr_review_failed`, `pr_skipped_too_large`, `parse_failed`, `agent_timeout`, `skill_unavailable`, `slack_digest_sent`, `slack_digest_failed`; payload fields such as `findings_*`, `recommendation`, `token_*`, `bobcoins_*` | your event names and payload fields; the mapping and panels follow |
| Digest content | `src/slackNotifier.js` `buildPayload` (exported as `_buildPayload`), `_flagFor` | one line per PR with a verdict flag, count and summary; a run footer | one line per item in your terms |
| Console task surface | `client/src/pages/Console.jsx` (the Reviews panel, PR-number field, run buttons, "Reviewing pull requests in …"), `client/src/components/ReviewLog.jsx` ("Review output"), `client/src/components/BobcoinsPanel.jsx` ("Spend & recent reviews"), `client/src/pages/HelpGuide.jsx`, `client/src/utils/prPhrasing.js` | review-shaped labels and inputs | your nouns and your inputs |
| Task API routes | `src/api/server.js` `POST /api/review/trigger`, `GET /api/review/status`, `GET /api/review/logs`, `POST /api/review/logs/clear` | trigger with optional PR list, poll, log tail | the same routes under your name; the body validation changes with the item type |
| Health tiles | `src/api/healthChecks.js` `checkGitHub`, `checkCarbonMcp` | reachability and quota of the external system and the ground truth | a check per external dependency |
| Env prefix | `GITHUB_AI_AGENT_*` across `src/constants.js`, `.env.example`, `deploy_ce.sh` | repo, token, limits, label, posting flags | your prefix |
| Test fixtures | `tests/reviewTargeting.test.js`, `tests/reviewablePrs.test.js`, `tests/prTargeting.test.js`, `tests/oversizedPr.test.js`, `tests/linkedIssue.test.js`, `tests/hasCatalogue.test.js`, `tests/carbonBuilderAuthority.test.js`, `tests/reviewPrompt.test.js`, `tests/slackNotifier.test.js`, `tests/test-parser.js`, `tests/test-diff-mapper.js` | review semantics | tests for your selection, parsing and write-back rules |
| Scratch-target helpers | `scripts/create-test-pr.js`, `scripts/create-oversized-test-pr.js` | create PRs in a scratch repo | a helper that creates scratch items in your system |

---

## 4. The agent slot

The harness asks four things of a worker agent and nothing else:

1. A non-interactive invocation that takes a prompt and a working directory and
   exits when done, within a timeout.
2. Authentication by environment variable, so the Code Engine secret can carry it.
3. A configuration file it reads MCP servers from, so `mcpConnection.js` has
   somewhere to write a fresh token.
4. A way to see what a run cost, or at least how many tokens it used.

Everything Bob-specific sits behind those four:

| Concern | Bob today |
|---------|-----------|
| Selection | `GITHUB_AI_AGENT_CLI`, read as `REVIEW_AGENT` in `src/constants.js` and checked against `validAgents` in `src/agentRunner.js`; `deploy_ce.sh` pins it with `--env GITHUB_AI_AGENT_CLI=bob` |
| Invocation | `bob run --trust --accept-license [--team-id] "<prompt>"` in `src/agentRunner.js` |
| Authentication | `BOB_API_KEY`, `BOB_TEAM_ID`, `BOB_INSTANCE_ID` |
| MCP configuration | `~/.bob/settings/mcp.json`, written by `mcpConnection.writeBobMcpHeaders` |
| Cost | the Bob gateway admin API in `src/api/bobCredits.js`; the Bobcoins tile; the balance-based auto-pause |
| Install and seeding | the pinned tarball and the `~/.bob` seeding blocks in the `Dockerfile` |
| Rules and skills | `.bob/rules/` and `.bob/skills/` in each workspace |
| Health | `healthChecks.checkBob` |

`src/agentRunner.js` already carries `claude` and `codex` cases, never exercised.
`docs/adapt-harness/agents/` has one file per agent with the Dockerfile block,
the runner case, the health check, the config shape and a verification command.
Only the Bob path is production-tested; the others are starting points to verify.

---

## 5. Names that change with the job

Review is baked into names throughout the task layer. A new job renames all of
these, and the SPEC lists each one, old and new.

| Kind | Today |
|------|-------|
| API routes | `/api/review/trigger`, `/api/review/status`, `/api/review/logs`, `/api/review/logs/clear` |
| Console strings | "Reviews — Automated", "Review output", "Spend & recent reviews", "Pull request numbers", "Review latest N PRs", "Reviewing pull requests in … with the bob agent" |
| Env prefix | `GITHUB_AI_AGENT_*` |
| Event types | the `pr_review_*` and `pr_skipped_*` names |
| Elasticsearch | alias `carbon-monitor-events`, template `carbon-monitor-events-template`, ILM policy `carbon-monitor-events-ilm`, the `payload.*` review fields, state index `carbon-monitor-mcp-state` |
| State files | `carbon-monitor-schedule.json` (`src/api/scheduleManager.js`) and `carbon-monitor-credit-ledger.jsonl` (`src/api/creditLedger.js`), both beside `MCP_STATE_PATH` |
| Kibana | data view `carbon-monitor-index-pattern`, dashboard `carbon-monitor-dashboard`, the seven panel titles in `scripts/rebuild-dashboard.js` |
| Slack | "Review Digest", verdict wording, "PRs reviewed" |
| External-system marker | the `AIReviewed` label |
| Product identity | `carbon-monitor` in `package.json`, `APP`, `IMAGE_NAME`, `SECRET_NAME`, the console header |

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
