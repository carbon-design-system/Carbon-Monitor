# SPEC: ibm-products-monitor

_Example SPEC produced by the adapt-harness skill from an interview; the answers are illustrative._

|              |                                    |
| ------------ | ---------------------------------- |
| Status       | example                            |
| Source       | Carbon-Monitor at commit `48e0a3f` |
| Branch       | PR review for another repo         |
| Worker agent | bob                                |
| Written      | 2026-10-16                         |

## 1. Intent

Each morning at 06:00 America/New_York, the reviewer selects up to 10 open, non-draft pull requests in `carbon-design-system/ibm-products` opened in the last 14 days that touch `packages/ibm-products/` or `packages/ibm-products-web-components/`. It reviews each one with Bob against the Carbon rubric, checking every Carbon API finding against Carbon MCP (and now `@carbon/ibm-products` component props as well), posts one review of inline comments and a summary comment, and labels the PR `AIReviewed`. The Carbon for IBM Products team sees the comments on their PRs and gets a Slack digest with one line per PR. Operators sign in to a separate Code Engine deployment of the same console.

## 2. Interview record

| #   | Question                 | Answer                                                                                                                                                         | Default used                    |
| --- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| 1   | Target repository        | `carbon-design-system/ibm-products`, a monorepo; review only PRs that touch `packages/ibm-products/` or `packages/ibm-products-web-components/`                | no                              |
| 2   | Reviewing GitHub account | A dedicated reviewing GitHub account (i.e. machine user) with Triage on `ibm-products`                                                                         | yes                             |
| 3   | Selection rules          | 10 PRs per run, 14 days back, skip label `status: blocked`, skip Dependabot and Renovate, reviewed label `AIReviewed`                                          | no (bots and label are default) |
| 4   | Rubric                   | Keep the rubric. Add the Carbon for IBM Products component list to Category 1 (the Carbon API category) so the agent verifies `@carbon/ibm-products` props too | no                              |
| 5   | Ground truth             | Carbon MCP, which the team says covers both libraries (see section 13)                                                                                         | yes                             |
| 6   | Worker agent             | Bob                                                                                                                                                            | yes                             |
| 7   | Schedule and digest      | Daily at 06:00 America/New_York; Slack digest on                                                                                                               | no                              |
| 8   | Console access           | Sign-in on                                                                                                                                                     | yes                             |
| 9   | Telemetry                | Keep Elasticsearch and the Kibana dashboard                                                                                                                    | yes                             |
| 10  | Comment wording          | Unchanged                                                                                                                                                      | yes                             |

## 3. Keep / change map

| Area                              | File / function                                                                                                                                                                      | Decision  | What changes                                                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Harness · image                   | `Dockerfile`                                                                                                                                                                         | keep      |                                                                                                                                              |
| Harness · deployment              | `deploy_ce.sh`                                                                                                                                                                       | modify    | Add `--env GITHUB_AI_AGENT_PATH_PREFIXES="${GITHUB_AI_AGENT_PATH_PREFIXES:-}"` to `COMMON_FLAGS`, beside the other `GITHUB_AI_AGENT_*` lines |
| Harness · scheduler               | `src/api/scheduleManager.js`                                                                                                                                                         | configure | Set `SCHEDULE_TIMEZONE=America/New_York` in `.env` (the default is `America/Chicago`); the operator sets 06:00 in the console                |
| Harness · sign-in                 | `src/api/sessionAuth.js`                                                                                                                                                             | configure | `AUTH_REQUIRED=true`, new `CONSOLE_USERNAME`, `CONSOLE_PASSWORD`, `SESSION_SIGNING_KEY`                                                      |
| Harness · cost                    | `src/api/bobCredits.js`, `src/api/creditLedger.js`                                                                                                                                   | keep      |                                                                                                                                              |
| Harness · MCP connection          | `src/api/mcpConnection.js`                                                                                                                                                           | keep      | One operator signs in with IBMid once on the new deployment                                                                                  |
| Harness · telemetry and dashboard | `src/observability/*`, `scripts/init-index.js`, `scripts/init-kibana.js`, `scripts/rebuild-dashboard.js`                                                                             | configure | `ES_URL`, `ES_USERNAME`, `ES_PASSWORD`, `ES_CA_CERT_PATH` (see section 13 on sharing a cluster)                                              |
| Task · orchestrator               | `src/index.js` `reviewPRs`, `resolveReviewTargets`, `parsePrNumbers`, `recordReviewCost`, `cleanupBundle`                                                                            | keep      |                                                                                                                                              |
| Task · work-item source           | `src/githubClient.js` `fetchReviewablePRs`, `fetchSinglePR`, `fetchPRFiles`                                                                                                          | modify    | Path filter in `fetchReviewablePRs` only; see section 4                                                                                      |
| Task · done marker                | `addReviewedLabel`; `REVIEW_LABEL`, `SKIP_LABELS` in `src/constants.js`                                                                                                              | modify    | Append `'status: blocked'` to the hard-coded `SKIP_LABELS` array; the two existing entries stay. `REVIEW_LABEL` stays `AIReviewed`           |
| Task · selection limits           | `src/constants.js` `MAX_PRS_PER_RUN`, `N_DAYS_SINCE_PR_CREATED`, `MAX_FILES_PER_PR`, `MAX_INPUT_TOKENS`                                                                              | configure | `GITHUB_AI_AGENT_MAX_PRS=10`, `GITHUB_AI_AGENT_DAYS_BACK=14`; the other two keep their defaults                                              |
| Task · workspace                  | `src/reviewBundle.js` `buildReviewBundle`, `getWorkspaceRoot`; `src/reviewCoverage.js` `selectCoverage`                                                                              | keep      |                                                                                                                                              |
| Task · prompt                     | `src/reviewPrompt.js` `buildReviewPrompt`, `estimateTokenUsage`                                                                                                                      | modify    | Category 1 also covers Carbon for IBM Products components; see section 5                                                                     |
| Task · output contract and parser | `src/reviewParser.js` `parseReviewOutput`, `computeRecommendation`, `filterUnverifiedCarbonFindings`, `extractCarbonBuilderSkillReads`                                               | keep      | `looksCarbonSpecific` already matches `/ibm-products/`                                                                                       |
| Task · write-back                 | `src/githubClient.js` `postReviewComments`, `postSummaryComment`; `src/reviewPrompt.js` `formatInlineComment`, `formatSummaryComment`, `formatLooksGoodComment`; `src/diffMapper.js` | keep      |                                                                                                                                              |
| Task · ground truth               | `src/api/mcpConnection.js` (`CARBON_MCP_URL`, `ALWAYS_ALLOW`), the `carbon-builder` skill, `healthChecks.checkCarbonMcp`                                                             | keep      | Default `CARBON_MCP_URL`                                                                                                                     |
| Task · telemetry vocabulary       | event types in `src/index.js`, `src/slackNotifier.js`; `INDEX_MAPPING` in `scripts/init-index.js`; panels in `scripts/rebuild-dashboard.js`                                          | keep      |                                                                                                                                              |
| Task · digest content             | `src/slackNotifier.js` `buildPayload` (exported as `_buildPayload`), `flagFor` (`_flagFor`)                                                                                          | keep      |                                                                                                                                              |
| Task · console task surface       | `client/src/pages/Console.jsx`, `client/src/pages/HelpGuide.jsx`, `client/src/utils/prPhrasing.js`                                                                                   | keep      | The repo name comes from `/api/config`                                                                                                       |
| Task · task API routes            | `src/api/server.js` `POST /api/review/trigger`, `GET /api/review/status`, `GET /api/review/logs`, `POST /api/review/logs/clear`                                                      | keep      |                                                                                                                                              |
| Task · health tiles               | `src/api/healthChecks.js` `checkGitHub`, `checkCarbonMcp`                                                                                                                            | keep      | `checkGitHub` probes the configured repo and reports missing Triage                                                                          |
| Task · env prefix                 | `GITHUB_AI_AGENT_*` in `src/constants.js`, `.env.example`, `deploy_ce.sh`                                                                                                            | configure | One new variable, `GITHUB_AI_AGENT_PATH_PREFIXES` (section 7)                                                                                |
| Task · test fixtures              | `tests/reviewablePrs.test.js`, `tests/reviewPrompt.test.js` and the rest of the list in `docs/HARNESS.md`                                                                            | modify    | Add cases to the two named files; the others are unchanged                                                                                   |
| Task · scratch-target helpers     | `scripts/create-test-pr.js`, `scripts/create-oversized-test-pr.js`                                                                                                                   | configure | `TEST_PR_OWNER` / `TEST_PR_REPO` point at a scratch fork, never `ibm-products`                                                               |

## 4. External system contract

**Read side.** One work item is an open pull request in `carbon-design-system/ibm-products`. `fetchReviewablePRs` lists one page of 100 open PRs, newest first, and drops drafts, PRs older than 14 days, PRs carrying `AIReviewed` or any `SKIP_LABELS` entry, and PRs whose author has `user.type === 'Bot'` (this covers the Dependabot and Renovate apps; nothing names them individually). The new path filter goes in `fetchReviewablePRs`, after the existing `filtered.sort(...)` and before the final `slice`. It gets a `pathPrefixes` argument whose default is the new `PATH_PREFIXES` constant. When the list is empty, behaviour is unchanged. Otherwise it walks the sorted candidates, lists each PR's files with the same paging loop `fetchPRFiles` uses (`octokit.rest.pulls.listFiles`, 70 per page), keeps a PR if any `filename` starts with a prefix, and stops once `maxPRs` PRs are kept. A PR named explicitly (console, `--pr`, `GITHUB_AI_AGENT_PR_NUMBER`) goes through `fetchSinglePR`, which applies no filters, and the path filter is no exception. The done marker is the `AIReviewed` label on the PR.

**Write side.** Unchanged: the inline comments in one review through `pulls.createReview` (a 422 falls back to `pulls.createReviewComment`, non-fatal per comment), one summary comment through `issues.createComment` (a short Looks Good comment when nothing is above `nit`), then `issues.addLabels` with `AIReviewed`. Because the label goes on last, a crash before it leaves the PR eligible next run. That run posts a second summary rather than dropping the PR.

**Authentication.** `GITHUB_AI_AGENT_TOKEN` belongs to a dedicated reviewing GitHub account (i.e. machine user) in the `carbon-design-system` org with the **Triage** role on `ibm-products`. Without Triage, the label call fails and every run re-reviews the same PRs. Recommended: a fine-grained token, resource owner `carbon-design-system`, repository access `ibm-products` (plus any repo hosting linked parent issues), Pull requests read and write, Issues read and write, Contents read, Metadata read. After creating it, authorize it for SAML SSO (Configure SSO, then Authorize); without that step, every call returns 403. Fine-grained tokens expire, so put a renewal date in the team calendar. A new deployer follows `docs/GITHUB_ACCESS.md` with `ibm-products` in place of `carbon`.

**Limits.** The path filter adds at least one `listFiles` call per candidate inspected, and one more for each further 70 files. That is about 100 extra calls when few PRs match and the PRs are small, within the 5,000 per hour REST limit for an authenticated account. Only the newest 100 open PRs are seen per run (one page). A PR with more than 300 files is still reviewed, in part: whole files are fitted to the input budget, source first, and the rest are listed as not reviewed in the comment (`docs/REVIEW_OUTPUT.md`, Partial reviews), as today.

## 5. Agent run contract

- Workspace: unchanged. `PR_REVIEW_REQUEST.md` (metadata, linked issue, file list, files not reviewed, diff), `pr.json`, `files.json`, `diff.patch`, `.bob/rules/01-output.md`, `.bob/skills/carbon-builder`.
- Prompt: unchanged except Category 1. In `buildReviewPrompt`, the Category 1 definition also covers components exported by `@carbon/ibm-products` and its web-components package, with a list of their component names. The Step A import check, which today names `@carbon/react`, `@carbon/web-components` and `carbon-components`, gets both package names. Take the list from the packages' public exports at implementation time (owner in section 13). Because the prompt grows, re-measure it with `estimateTokenUsage` and raise `PROMPT_OVERHEAD_TOKENS` in `src/constants.js` if it now exceeds 12,000 tokens.
- Output: unchanged. The `BEGIN_REVIEW_JSON` / `END_REVIEW_JSON` block is parsed by `parseReviewOutput`, with one agent retry on parse failure, then `parse_failed`.
- Limits: 10-minute agent timeout, one retry, `MAX_INPUT_TOKENS` 140,000.
- Ground truth: Carbon MCP at the default `CARBON_MCP_URL` over OAuth, tools `code_search`, `docs_search`, `get_charts`, `labs_search`, `code_audit`.
- Success and failure: unchanged. A PR succeeds when comments post and the label lands. A failed PR is reported in the digest and stays eligible. A failed run emits `run_failed`.

## 6. Generalisation

none

## 7. Configuration

`.env` for this deployment (all names exist in `.env.example` except the new one):

```
GITHUB_AI_AGENT_OWNER=carbon-design-system
GITHUB_AI_AGENT_REPO=ibm-products
GITHUB_AI_AGENT_MAX_PRS=10
GITHUB_AI_AGENT_DAYS_BACK=14
GITHUB_AI_AGENT_REVIEW_LABEL=AIReviewed
GITHUB_AI_AGENT_PATH_PREFIXES=packages/ibm-products/,packages/ibm-products-web-components/
GITHUB_AI_AGENT_CLI=bob
AUTH_REQUIRED=true
APP=ibm-products-monitor
SECRET_NAME=ibm-products-monitor-secrets
```

New variable: `GITHUB_AI_AGENT_PATH_PREFIXES`, comma-separated, default empty (no filter). It is read in `src/constants.js` as `PATH_PREFIXES` (split on commas, trimmed, empties dropped), documented in `.env.example` under the `GITHUB_AI_AGENT_DAYS_BACK` line, and passed by the one `deploy_ce.sh` flag in section 3. It is not a secret, so `SECRET_KEYS` is unchanged. Secrets are the existing set: `GITHUB_AI_AGENT_TOKEN`, `BOB_API_KEY` (and `BOB_TEAM_ID` only for a general-type key), `ES_*`, `CONSOLE_*`, `SESSION_SIGNING_KEY`, `API_SECRET`, `SLACK_WEBHOOK_URL`. `APP`, `IMAGE_NAME` and `SECRET_NAME` are set in `.env` so this deployment does not overwrite the Carbon one.

## 8. Telemetry and reporting

- Events: unchanged (`run_*`, `pr_review_*`, `parse_failed`, `agent_timeout`, `skill_unavailable`, `slack_digest_*`); `pr_review_completed` carries `payload.coverage`. Every event carries `repo: carbon-design-system/ibm-products`.
- Dashboard: the seven existing panels. If the cluster is shared, filter the dashboard on `repo`.
- Slack: the existing "Review Digest", one line per PR with verdict flag, issue count and summary (and `partial review: N of M files` when a review is partial), and a footer with counts. The Criteria line reads "10 most recent PRs opened within the last 14 days"; it does not mention the path filter.
- Console: tiles for Bob, Bobcoins, Carbon MCP, GitHub (this repo, with permission check) and Elasticsearch, as today.

## 9. Deployment

Image unchanged. One flag added to `deploy_ce.sh`.

Scale stays at min 1 and max 1 because this deployment has its own rotating Carbon MCP refresh token.

First run: fill `.env`, run `./deploy_ce.sh`, run `node scripts/init-index.js` and `node scripts/init-kibana.js` then `node scripts/rebuild-dashboard.js` if the cluster is new, open the console, sign in, press "Sign in with IBMid" once, then set the schedule to 06:00 under Settings, Scheduled reviews.

## 10. Acceptance criteria

- **AC-1** Given `PATH_PREFIXES` is empty, when `fetchReviewablePRs` runs, then it returns exactly what it returns today and calls `listFiles` zero times.
- **AC-2** Given prefixes `packages/ibm-products/` and `packages/ibm-products-web-components/` and three eligible PRs of which only the newest and oldest touch those paths, when `fetchReviewablePRs` runs with `maxPRs: 10`, then it returns those two, newest first.
- **AC-3** Given 15 matching PRs, when `fetchReviewablePRs` runs with `maxPRs: 10`, then it returns 10 and stops listing files after the tenth match.
- **AC-4** Given a PR labelled `status: blocked`, when auto-selection runs, then the PR is not returned.
- **AC-5** Given a PR outside the prefixes, when an operator names it in the console, then it is reviewed (explicit targets are not path-filtered).
- **AC-6** Given the built prompt, when `buildReviewPrompt` is called, then its Category 1 text names `@carbon/ibm-products` and contains every component in the agreed list.
- **AC-7** Given the new deployment, when the GitHub tile is checked, then it names `carbon-design-system/ibm-products` and reports OK only if the account can label.
- **AC-8** Given the schedule is enabled at 06:00, when the first scheduled run ends, then Slack shows a Review Digest for `carbon-design-system/ibm-products` and each reviewed PR carries `AIReviewed`.
- **AC-9** Given a matching PR with more than 300 changed files, when auto-selection picks it, then it is reviewed in part: the comment carries the partial-review note and lists the files not reviewed, `pr_review_completed` has `payload.coverage.partial: true`, and the PR is labelled `AIReviewed`, as today.
- **AC-10** Given a review that posted its comments but failed to add the label, when the next run starts, then the PR is selected again.

## 11. Verification plan

Add path-filter cases to `tests/reviewablePrs.test.js` (AC-1 to AC-4) with a mock `octokit.rest.pulls.listFiles`, and a Category 1 case to `tests/reviewPrompt.test.js` (AC-6). Existing tests must still pass with no `.env`: `npm run test:all`, as in `.github/workflows/test.yml`. Dry run: point a local `.env` at a scratch fork with `TEST_PR_OWNER`/`TEST_PR_REPO`, create a PR under `packages/ibm-products/` with `scripts/create-test-pr.js`, and run `npm start -- --pr N` against the fork. In the cloud, check the tiles (AC-7), trigger one PR from the console (AC-5), then check the first scheduled run's Slack digest and Kibana events (AC-8). AC-9 and AC-10 describe behaviour that exists today. AC-9 stays covered by `tests/reviewCoverage.test.js`. Check AC-10 once on the scratch fork: run with a token that lacks Triage, restore the token, and confirm the next run selects the PR again.

## 12. Tasks

1. Add `PATH_PREFIXES` to `src/constants.js` and document the variable in `.env.example`. Files: `src/constants.js`, `.env.example`. AC-1.
2. Implement the path filter in `fetchReviewablePRs` as section 4 describes, with tests. Files: `src/githubClient.js`, `tests/reviewablePrs.test.js`. AC-1, AC-2, AC-3.
3. Append `'status: blocked'` to `SKIP_LABELS`, with a test. Files: `src/constants.js`, `tests/reviewablePrs.test.js`. AC-4.
4. Extend Category 1 with the agreed component list, re-measure the prompt overhead, add a test. Files: `src/reviewPrompt.js`, `src/constants.js`, `tests/reviewPrompt.test.js`. AC-6.
5. Add the `GITHUB_AI_AGENT_PATH_PREFIXES` flag to `deploy_ce.sh`. Files: `deploy_ce.sh`. AC-8.
6. Create the reviewing GitHub account token with Triage and SSO authorization, fill `.env`, deploy, bootstrap Elasticsearch and Kibana, connect Carbon MCP. Files: `.env` (local only). AC-5, AC-7, AC-10.
7. Enable the 06:00 schedule and watch the first run. Files: none. AC-8, AC-9.

## 13. Open questions

| Question                                                                                                                                                                                                                                                                                                                                     | Who decides                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Does Carbon MCP index `@carbon/ibm-products` components well enough for Step B checks? If `code_search` returns nothing for them, the prompt rule discards those findings as "component not indexed". Test with three known components before go-live.                                                                                       | Carbon MCP maintainers, with the IBM Products tech lead |
| Where does the authoritative component list come from (package exports, Storybook, docs site), and who updates the prompt when it changes?                                                                                                                                                                                                   | IBM Products tech lead                                  |
| Does a 10 PR limit fit the monorepo's volume? If more than 10 matching PRs open per day, the oldest never get reviewed. Check two weeks of PR history.                                                                                                                                                                                       | IBM Products engineering manager                        |
| Will this deployment share an Elasticsearch cluster with the Carbon one? The schedule index `carbon-monitor-schedule` (hard-coded in `scheduleManager.js`) and the MCP state index would collide. The spend summary in `server.js` does not filter by repo. If the cluster is shared, a code change is needed and this SPEC must be revised. | Platform owner for the cluster                          |
| Do Renovate PRs in this repo come from the Renovate app (type `Bot`) or from a user account? A user account would not be skipped.                                                                                                                                                                                                            | IBM Products maintainers                                |
| Is the 100-PR page enough, or can more than 100 open PRs be newer than 14 days?                                                                                                                                                                                                                                                              | IBM Products engineering manager                        |
