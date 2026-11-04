# SPEC: Carbon Monitor reviews carbon-ai-chat (CAIC) as a second deployment

|              |                                    |
| ------------ | ---------------------------------- |
| Status       | draft                              |
| Source       | Carbon-Monitor at commit `134efff` |
| Branch       | PR review for another repo         |
| Worker agent | bob (built in)                     |
| Written      | 2026-10-27                         |

## 1. Intent

Each day at a scheduled time (off until an operator enables it, staggered from
core's 9 PM CDT run), a second Code Engine app built from the same image lists up
to 20 open, non-draft, non-bot PRs in `carbon-design-system/carbon-ai-chat` from
the last 30 days, skipping those labelled `DO NOT MERGE`, `status: WIP 👩‍💻` or
`AIReviewed`. For each, Bob reviews the diff against a caic-specific prompt and a
new `caic-pr-review` skill, with Carbon MCP as ground truth for Carbon claims. It
posts one inline review plus a summary headed `[AI agent review - CAIC]`, then
adds `AIReviewed`. The review is advisory; maintainers decide. The existing
`core` deployment reviewing `carbon-design-system/carbon` is unchanged in
behaviour, text, Elasticsearch names and schedule.

The mechanism is a **profile** chosen at startup by `REVIEW_PROFILE`. `core` is the
default and takes the existing code paths untouched. `caic` is a purely additive
branch: every change to shared code is an optional parameter whose default is
today's behaviour. The caic profile supports the Bob agent only; `caic` with
`GITHUB_AI_AGENT_CLI=claude` is a startup error.

**Design rule that keeps core safe.** A change to shared code is allowed only if
(a) it adds an optional parameter or an early branch that core never takes, and
(b) a Phase 0 characterization test pins the old output first. Where the code
already does the right thing for caic, nothing is changed (see §3).

## 2. Interview record

| #   | Question          | Answer                                                                                                                                                                                                       | Default used |
| --- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| 1   | Target repo       | `carbon-design-system/carbon-ai-chat`, a second deployment. Scope filters as core's.                                                                                                                         | no           |
| 2   | Reviewing account | The account that posts core reviews. Triage on carbon-ai-chat is **not verified** (§13).                                                                                                                     | no           |
| 3   | Selection         | 20 PRs/run, 30 days, skip `DO NOT MERGE` and `status: WIP 👩‍💻`, mark `AIReviewed`, skip drafts and bots. (Code default is 10/21; core's deployed env is 20/30.)                                               | no           |
| 4   | Rubric            | Keep the Step 1–4 skeleton and the parser contract (catalogue lines, `BEGIN_REVIEW_JSON`, Cat 1/Cat 2). Replace the rules with caic's distilled ones. Core's prompt unchanged.                               | no           |
| 5   | Ground truth      | Carbon MCP and `carbon-builder` stay; Cat 1 and Cat 2 both stay.                                                                                                                                             | no           |
| 6   | Worker agent      | Bob 2.0.5, as core.                                                                                                                                                                                          | yes          |
| 7   | Schedule, Slack   | Independent schedule per deployment, caic starts off, staggered from core. Slack digest only if a webhook is configured, shared with core.                                                                   | yes          |
| 8   | Console access    | `AUTH_REQUIRED=true`, own `CONSOLE_USERNAME`/`CONSOLE_PASSWORD` in the caic secret, same operator.                                                                                                           | yes          |
| 9   | Telemetry         | Keep Elasticsearch with an `ES_INDEX_PREFIX`; core's default unchanged. Kibana out of scope for v1.                                                                                                          | yes          |
| 10  | Comment wording   | Header `[AI agent review - CAIC]`. The "Carbon verification: …" summary line appears only when the review has at least one Cat 1 finding. Core's text untouched and pinned by a test. Everything else as is. | no           |

Constraints from the user: planning first; no commits by the agent; regression
risk at most 10% in each dimension (§3 design rule, §10, §11 and the risk
register in §11 are how that is enforced); `.env` is never read or printed.

## 3. Keep / change map

Decisions: keep, configure, modify, replace, remove, add. A "modify" row names
the optional parameter or early branch, and core's default path is unchanged.
Line numbers were checked against commit `134efff`.

### Harness (`docs/HARNESS.md` §2)

| Area                     | File / function                                                                                                         | Decision    | What changes                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Harness · image          | `Dockerfile`, `.dockerignore`                                                                                           | keep        | **Unchanged.** `Dockerfile:83` already copies `src/`, so the caic skill ships from `src/profiles/caic/skills/` with no image change. It is deliberately not under `.bob/`, where `Dockerfile:191` copies skills into the home that every review links, which would expose it to core reviews, and where developers' Bob sessions would also pick it up.                                                    |
| Harness · deploy         | `deploy_ce.sh`, `docker-compose.yml`                                                                                    | modify      | Reason: the script sources `.env` (`:13`) and defaults `APP=carbon-monitor` (`:18`), so a wrong env file would update production core. Add `DEPLOY_ENV_FILE` (default `.env`), a printed target and a mismatch guard (§9), and pass `REVIEW_PROFILE`, `ES_INDEX_PREFIX`, `MCP_STATE_INDEX`, `MCP_STATE_DOC_ID` with empty defaults beside the other `--env` flags (`:446-474`). `docker-compose.yml` keep. |
| Harness · server         | `src/api/server.js`                                                                                                     | modify      | Reason: `CREDIT_EVENTS_INDEX = 'carbon-monitor-events-*'` at `:545`. Take it from the names module. Repo reads at `:521-522` keep: they read the environment at call time and caic sets its own.                                                                                                                                                                                                           |
| Harness · sign-in        | `src/api/sessionAuth.js`                                                                                                | keep        | `AUTH_REQUIRED=true` and separate credentials in the caic secret.                                                                                                                                                                                                                                                                                                                                          |
| Harness · schedule       | `src/api/scheduleManager.js`                                                                                            | modify      | Reason: index `carbon-monitor-schedule` and doc `singleton` (`:193-194`) would be shared in Elasticsearch. Index comes from the names module. Default-off (`:170`) keep. The local state file (`:69`, `:82`) is container-local and keep. Repo reads at `:627`, `:697` keep.                                                                                                                               |
| Harness · cost           | `src/api/bobCredits.js`, `src/api/spend.js`, `src/api/creditLedger.js`                                                  | modify/keep | `spend.js:9` events wildcard from the names module. `bobCredits.js` keep (the account-wide gauge is accepted, §13 Q9). `creditLedger.js` keep: it writes a local file (`carbon-monitor-credit-ledger.jsonl` unless `CREDIT_LEDGER_PATH`), and each Code Engine app has its own disk.                                                                                                                       |
| Harness · run log        | `src/api/reviewLog.js`, `src/api/reviewProgress.js`                                                                     | keep        | In memory, per process.                                                                                                                                                                                                                                                                                                                                                                                    |
| Harness · health         | `src/api/healthChecks.js`                                                                                               | keep        | `checkGitHub` reads owner and repo from the environment at call time (`:282-283`), so the tile follows the caic env with no edit.                                                                                                                                                                                                                                                                          |
| Harness · MCP connection | `src/api/mcpConnection.js`                                                                                              | modify      | `:215-219` already reads `MCP_STATE_INDEX` / `MCP_STATE_DOC_ID`. The default index name comes from the names module so a prefix applies when the variable is unset. Caic gets its own token family. Whether two sign-ins coexist is untested (§13 Q1).                                                                                                                                                     |
| Harness · agent runner   | `src/agentRunner.js`, `src/agents/`                                                                                     | modify      | `agentRunner.js` **keep**: its `carbon-builder` discovery warning (`:184`) stays correct for caic. `bob.js` and `claude.js` `prepareBundle(bundleDir, { rules, skillSource })` gain an optional `extraSkills = []` (`[{name, source}]`). Bob copies each to `.bob/skills/<name>`; Claude throws if the list is non-empty. `tests/agents.test.js:1050` still calls the old shape.                           |
| Harness · telemetry      | `src/observability/esClient.js`, `eventService.js`                                                                      | modify      | `eventService.js:53` write index and its read wildcard from the names module. `esClient.js` keep.                                                                                                                                                                                                                                                                                                          |
| Harness · dashboard      | `scripts/init-index.js`, `init-kibana.js`, `rebuild-dashboard.js`, `refresh-kibana-dataview.js`                         | modify/keep | `init-index.js`: `ALIAS`, `TEMPLATE`, `ILM_NAME` (`:43-45`) from the names module; add `profile` (keyword) to `INDEX_MAPPING`. The three Kibana scripts keep.                                                                                                                                                                                                                                              |
| Harness · Slack          | `src/slackNotifier.js`                                                                                                  | keep        | The digest already prints `*Repo:*` (`:247`), so a shared webhook shows which deployment spoke. `tests/slackNotifier.test.js` unchanged.                                                                                                                                                                                                                                                                   |
| Harness · console shell  | `client/src/App.jsx`, `Login.jsx`, `StatusTile.jsx`, `SchedulePanel.jsx`, `McpConnectionPanel.jsx`, `ErrorBoundary.jsx` | keep        | The header derives from `cfg.owner`/`cfg.repo` (`Console.jsx:517`).                                                                                                                                                                                                                                                                                                                                        |
| Harness · config         | `src/loadEnv.js`, `src/config/env.js`                                                                                   | keep        |                                                                                                                                                                                                                                                                                                                                                                                                            |

### Task layer (`docs/HARNESS.md` §3)

| Seam                       | File / function                                                                                                                   | Decision       | What changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Profile (new slot)         | `src/profiles/index.js` (new), `src/profiles/caic/` (new)                                                                         | add            | `resolve(agentId)` reads `REVIEW_PROFILE` at call time (empty means `core`), rejects unknown values, rejects `caic` with a non-Bob agent, and for `caic` fails fast if the skill files are missing (the loud version of the silent-loss failure `Dockerfile:90-94` warns about). `core` is an object with no overrides.                                                                                                                                                                                                                                                                                                                     |
| Orchestrator               | `src/index.js` `reviewPRs`                                                                                                        | modify         | Resolve the profile once at the start. Pass it to `buildReviewBundle` and to the three `format*` calls (`:807`, `:1341`, `:1350`). Add `profile` to event payloads. Add `extra_skills_used` (Bob tool calls `use_skill` naming an extra skill), computed only when the profile has extra skills. `skillReadsFor`, the `skill_unavailable` event (`:1162`) and everything for `carbon-builder` keep.                                                                                                                                                                                                                                         |
| Work-item source           | `src/githubClient.js`                                                                                                             | keep           | Draft, bot, skip-label and `AIReviewed` filters exist (`:91-99`). Explicit PR numbers bypass the label (`index.js:597`). `ORIGINAL_FILES.json` is looked up first and falls back to the GitHub file list when absent (`index.js:703-726`), so ordinary PRs work.                                                                                                                                                                                                                                                                                                                                                                            |
| Done marker                | `addReviewedLabel`, `REVIEW_LABEL`, `SKIP_LABELS`                                                                                 | keep           | `SKIP_LABELS` is hardcoded at `constants.js:10` as `DO NOT MERGE` and `status: WIP 👩‍💻`, which is caic's list. No new variable. A failing label call fails the run after posting (`GITHUB_ACCESS.md`), so Triage is verified before the schedule is enabled.                                                                                                                                                                                                                                                                                                                                                                                 |
| Selection limits           | `src/constants.js`                                                                                                                | configure      | Caic env: `GITHUB_AI_AGENT_MAX_PRS=20`, `GITHUB_AI_AGENT_DAYS_BACK=30` (code defaults 10 and 21). `constants.js` itself is not edited.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Workspace                  | `src/reviewBundle.js` `buildReviewBundle`; `src/reviewCoverage.js` `classify`, `selectCoverage`                                   | modify         | `buildReviewBundle` takes an optional `profile`. Absent or `core`: the existing inline rules string (`:338-365`), skill source (`:369-375`) and `buildReviewPrompt` call (`:379`) run unchanged. `caic`: its own rules text, `extraSkills: [caic-pr-review]`, and extra coverage patterns. `classify(filename, extra)` and `selectCoverage({…, extraPatterns})` gain an optional last argument. Under caic, generated adds `es-custom/`, `storybook-static/`, `storybook-react-static/`, `custom-elements.json`, `telemetry.yml`; support adds `*_spec.ts(x)` and `/tests/`. Core's two regexes (`reviewCoverage.js:13-16`) are not edited. |
| Prompt                     | `src/reviewPrompt.js` `buildReviewPrompt`                                                                                         | modify         | One early branch at the top: when `profile.id === 'caic'` return `buildCaicPrompt(...)` from `src/profiles/caic/prompt.js`. The existing body (`:458` on) is not edited. `estimateTokenUsage` keep.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Output contract and parser | `src/reviewParser.js`                                                                                                             | keep           | **Unchanged.** `not-carbon-specific` findings already pass the filter unconditionally (`:185-187`), so caic convention findings such as hardcoded `cds--` survive when the caic prompt marks them Cat 2. `extractCarbonBuilderSkillReads` and `computeRecommendation` (`:1033`) keep. Caic uses core's recommendation rule in v1; a caic-specific threshold is added only if the eval shows it is needed (§13 Q8).                                                                                                                                                                                                                          |
| Write-back                 | `src/reviewPrompt.js` `formatSummaryComment` (`:309-311`), `formatLooksGoodComment` (`:251`), `formatNotReviewedComment` (`:224`) | modify         | Each gains optional `headerLabel` (default `'AI agent review — Carbon grounded'`, so core's text is byte-identical) and `showCarbonVerification` (default `true`). Caic passes `'AI agent review - CAIC'` and `true` only when the review has a Cat 1 finding. `githubClient.js` and `diffMapper.js` keep.                                                                                                                                                                                                                                                                                                                                  |
| Ground truth               | `mcpConnection.js`, `carbon-builder` skill and fetch block, `checkCarbonMcp`, `McpConnectionPanel.jsx`                            | keep/configure | Same Carbon MCP URL and skill. Caic has its own MCP state keys (above).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Telemetry vocabulary       | event types in `src/index.js`, `src/slackNotifier.js`; `INDEX_MAPPING`; `rebuild-dashboard.js`                                    | modify         | No new event types. New payload fields `profile` and `extra_skills_used`. `payload` is `dynamic: true` (`init-index.js:116`), so both work before any mapping change; `profile` also gets an explicit keyword mapping.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Digest content             | `src/slackNotifier.js`                                                                                                            | keep           | See Harness · Slack.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Console task surface       | `Console.jsx`, `ReviewLog.jsx`, `BobcoinsPanel.jsx`, `HelpGuide.jsx`, `prPhrasing.js`                                             | keep           | No repo dropdown. The Bobcoins gauge is account-wide; the history list is per app. Optional help-text line (Task 10).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Task API routes            | `src/api/server.js` `/api/review/*`                                                                                               | keep           | Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Health tiles               | `src/api/healthChecks.js`                                                                                                         | keep           | See Harness · health.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Env prefix                 | `GITHUB_AI_AGENT_*`                                                                                                               | keep           | New variables are in §7.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Test fixtures              | the files listed in `HARNESS.md` §3                                                                                               | add            | Three existing tests pin core text: `reviewPrompt.test.js`, `carbonBuilderAuthority.test.js`, `agents.test.js`. They must pass unmodified. New tests in §11.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Scratch-target helpers     | `scripts/create-test-pr.js`, `create-oversized-test-pr.js`                                                                        | add            | New `scripts/create-caic-eval-prs.js`, driven by `evals/caic/manifest.json`. Never run without the user's explicit go-ahead.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

**Files this change must not touch** (checked with `git diff --stat` before
review, AC-8): `src/reviewParser.js`, `src/agentRunner.js`, `src/constants.js`,
`src/githubClient.js`, `src/api/healthChecks.js`, `src/api/bobCredits.js`,
`src/slackNotifier.js`, `Dockerfile`, `.dockerignore`.

## 4. External system contract

**Read side.** One work item is one open PR in `carbon-design-system/carbon-ai-chat`.
Listing and filtering are as `fetchReviewablePRs` today: open, non-draft, not by a
bot, created within `GITHUB_AI_AGENT_DAYS_BACK`, without a skip label or
`AIReviewed`. Skip labels: `DO NOT MERGE`, `status: WIP 👩‍💻`. The done marker is the
`AIReviewed` label, set after write-back.

**Write side.** One inline review (comments mapped to diff lines by
`diffMapper.js`) and one summary comment, then `AIReviewed`. A retry after a
partial failure re-posts rather than deduplicates, as core does today; the label
being set last is what limits that. Header: `[AI agent review - CAIC]`.

**Authentication.** `GITHUB_AI_AGENT_TOKEN`, a different credential from the `gh`
login used for scratch work. It needs Triage (to add labels) and PR comment
rights on carbon-ai-chat, as in `docs/GITHUB_ACCESS.md`, and may need SAML SSO
authorization for the org. **Not verified** (§13 Q4). On the scratch repo
`Chance-Gong/caic-pr-review-test` the token's account needs write and triage.

**Limits.** GitHub rate limits and `MAX_FILES_PER_PR`/`MAX_INPUT_TOKENS` as core.
When no file fits the diff budget, no agent runs and the PR gets a Not Reviewed
comment and the label (existing behaviour). A per-run Bobcoin cap is
`BOB_MAX_COST` (`constants.js:17`), set for caic after the pilot (§11).

## 5. Agent run contract

- **Workspace.** As today: `PR_REVIEW_REQUEST.md`, `pr.json`, `files.json`,
  `diff.patch`, plus rules and skills through `adapter.prepareBundle`. For caic the
  bundle holds `.bob/skills/carbon-builder` (as core) and
  `.bob/skills/caic-pr-review`. Bob loads project-level skills from the bundle's
  `.bob/skills/` and global ones from `~/.bob/skills/`, with the project copy
  winning on a name clash (Bob docs, "Skill locations"). `seedBobHome` links the
  global folder into each review's HOME, which holds `carbon-builder` only, so the
  caic skill is visible to caic reviews and never to core's. There is no checkout,
  shell, `gh` or sub-agent, so upstream skills cannot be used as written.
- **Prompt.** `src/profiles/caic/prompt.js` (new), keeping the Step 1–4 skeleton
  and the output contract text of core. It replaces core's Figma, Storybook
  `argTypes`, codemod and box-model rules with: the path-to-Carbon-flavor table
  from caic's `code-patterns.md` (both main packages are Web Components;
  `@carbon/react` must never be imported under `packages/ai-chat/src/`; every
  Carbon MCP call passes `filters.component_type`); the highest-value caic
  conventions; test-proof integrity; the ten-finding cap (Important plus Nit at
  most 10, Nits at most 3, Blockers never dropped); and severity mapping
  Blocker→`blocking`, Important→`major`, Nit→`nit`, `minor` unused. Caic
  convention findings (hardcoded `cds--`, descendant selectors, and similar) are
  Cat 2 with `verificationSource: "not-carbon-specific"`. The linked issue and PR
  description are context for intent only, never a checklist. Suggestions stay in
  the finding `body` as an imperative.
- **Skill `caic-pr-review`** (new): `src/profiles/caic/skills/caic-pr-review/`
  with `SKILL.md` carrying `name: caic-pr-review` and a non-empty `description`
  (Bob ignores skills without one) plus reference files. Self-contained, PR
  content only (diff, description, changed-files list), no output-format rules so
  it cannot conflict with the parser. Distilled, not vendored: every rule is
  tagged with its source document and the upstream commit is pinned. A size cap is
  set from a measured token cost with and without the skill (Task 7). Content:
  what is not a finding; conventions checkable from a diff (no hardcoded `cds--`,
  use `#{$prefix}--`; BEM with no descendant nesting; CSS logical properties;
  logic in plain modules not components; new UI in `components/` not
  `components-legacy/`; default no comments; never hand-edit generated output);
  test-proof integrity (loosened assertion, deleted or skipped case, regenerated
  snapshot); PR size (≤200 preferred, 201–400 warn, >400 split by default);
  severity calibration; finding wording (orient then diagnose, no hedging, name
  the trigger, end with an imperative); a refute step before shipping Blocker or
  Important. It does not flag a `telemetry.yml` change that accompanies a source
  change (caic's own docs disagree; recorded in the ledger). The skill is optional
  for the agent, so the top rules are duplicated in the prompt.
- **Output.** Unchanged: visible catalogue lines (`SKIP`, `NO-FINDINGS`,
  `[file:line] —`), `BEGIN_REVIEW_JSON`, severities `blocking|major|minor|nit`,
  Cat 1 / Cat 2 resolutions. On parse failure the parser marks the review
  unreliable and returns `suggested-improvements`, as today; no retry is added.
- **Limits.** `AGENT_TIMEOUT_MS` and token budget as core. Per-review cost record
  and budget check (`adapter.credits()`) before every review, also at N=1.
- **Ground truth.** Carbon MCP, OAuth with PKCE, `carbon-builder` skill. The
  caic deployment holds its own token family. If a second IBMid sign-in revokes
  core's token, the fallback is in §13 Q1.
- **Success and failure.** As core: a reliable parse plus write-back plus label is
  success for the item; a failure in one item does not stop the batch.

## 6. Generalisation

None. Routes, labels, event types and the `GITHUB_AI_AGENT_*` prefix keep their
names. The additions (names module, `ES_INDEX_PREFIX`, `REVIEW_PROFILE`) are in §7.

## 7. Configuration

New variables (all go in `.env.example`, each with a comment on what it does):

| Variable          | Default                      | Purpose                                                                                                                                                                                |
| ----------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REVIEW_PROFILE`  | empty (means `core`)         | `core` or `caic`. An unknown value, or `caic` with a non-Bob agent, is a startup error.                                                                                                |
| `ES_INDEX_PREFIX` | empty (core's literal names) | Builds every Elasticsearch name. For caic: `carbon-monitor-caic`, giving `carbon-monitor-caic-events-YYYY.MM`, never `carbon-monitor-events-caic-*`, which core's wildcard would read. |
| `DEPLOY_ENV_FILE` | `.env`                       | Env file `deploy_ce.sh` sources.                                                                                                                                                       |

Existing variables now passed through by `deploy_ce.sh`: `MCP_STATE_INDEX` and
`MCP_STATE_DOC_ID` (read at `mcpConnection.js:215-219`; unset means the names
module default). `BOB_MAX_COST` is already passed (`deploy_ce.sh:459`).

Caic env file: `GITHUB_AI_AGENT_OWNER=carbon-design-system`,
`GITHUB_AI_AGENT_REPO=carbon-ai-chat`, `REVIEW_PROFILE=caic`,
`ES_INDEX_PREFIX=carbon-monitor-caic`, `APP=carbon-monitor-caic`,
`IMAGE_NAME=carbon-monitor-caic`, `SECRET_NAME=carbon-monitor-caic-secrets`,
`AUTH_REQUIRED=true`, its own `CONSOLE_USERNAME`/`CONSOLE_PASSWORD`,
`GITHUB_AI_AGENT_MAX_PRS=20`, `GITHUB_AI_AGENT_DAYS_BACK=30`, and `BOB_MAX_COST`
set after the pilot. `SECRET_KEYS` for the caic secret mirrors core's list (no new
secret keys). The names the module builds from a prefix `P` (empty `P` gives
today's literals):

| Use             | Core (empty)                        | Caic (`carbon-monitor-caic`)                  |
| --------------- | ----------------------------------- | --------------------------------------------- |
| Events write    | `carbon-monitor-events-YYYY.MM`     | `carbon-monitor-caic-events-YYYY.MM`          |
| Events read     | `carbon-monitor-events-*`           | `carbon-monitor-caic-events-*`                |
| Alias           | `carbon-monitor-events`             | `carbon-monitor-caic-events`                  |
| Template, ILM   | `…-events-template`, `…-events-ilm` | `carbon-monitor-caic-events-template`, `-ilm` |
| Schedule index  | `carbon-monitor-schedule`           | `carbon-monitor-caic-schedule`                |
| MCP state index | `carbon-monitor-mcp-state`          | `carbon-monitor-caic-mcp-state`               |

## 8. Telemetry and reporting

- **Events.** No new types. New payload fields `profile` (keyword) on review and
  run events, and `extra_skills_used` (array) on review events for profiles that
  have extra skills.
- **Dashboard.** None for v1. Events are written to the caic index so a data view
  can be added later.
- **Slack.** Shared webhook. One digest per deployment, each showing its `*Repo:*`
  line. No change.
- **Console.** Header already shows the repo. The Bobcoins gauge is account-wide
  (it reads the gateway's `usage` and `budget_limit`, `bobCredits.js:312-321`) and
  the history list is per app.

## 9. Deployment

- **Image.** Same `Dockerfile`, **unchanged**. The caic skill is in `src/`.
- **App.** Second Code Engine app, `min-scale 1`, `max-scale 1`. The one-instance
  invariant applies per app. The done marker is still set after write-back.
- **Deploy guard.** `deploy_ce.sh` prints app, repo, profile and prefix. If the app
  already exists, it compares the live app's `GITHUB_AI_AGENT_REPO`,
  `REVIEW_PROFILE` and `ES_INDEX_PREFIX` (from `ibmcloud ce app get --output json`,
  as the script already reads at `:128-131`) with the env file's and aborts on a
  difference unless `DEPLOY_ALLOW_TARGET_CHANGE=1`. The comparison lives in a
  function in its own file so a test can run it against a stubbed `ibmcloud`.
- **Elasticsearch.** `scripts/init-index.js` runs once with `ES_INDEX_PREFIX` set
  and must succeed before caic's first review. Without it the first write creates
  an index with dynamic mapping (the script sets `dynamic:false` and explicit
  fields at `:97-169`). The script is idempotent: it upserts the ILM policy and
  template, creates the month index only if missing, and moves the alias only when
  needed (`:201-323`). Caic's names must not match core's patterns (§7 table).
  Kibana: none.
- **First-run steps a human performs once:** create the caic secret, run
  `init-index.js`, sign in with IBMid in the caic console, verify the label
  rights, enable posting, then enable the schedule.
- **Rollout order.** Deploy caic with the schedule off. Run explicit PR numbers
  against the scratch repo (posting on is harmless there). Then run explicit PR
  numbers against a few real carbon-ai-chat PRs with both posting flags
  (`GITHUB_AI_AGENT_POST_INLINE_COMMENTS`, `GITHUB_AI_AGENT_POST_SUMMARY_COMMENT`)
  set to `false`; that checks the output without commenting, but a run still adds
  `AIReviewed` (`index.js:1380`), so remove the label by hand afterwards or do this
  trial last. Then turn posting on, then enable the schedule staggered from
  9 PM CDT.
- **Core is not redeployed for caic to work.** Isolation rests on core's old code
  using the literal names and caic's new code using prefixed ones. Core picks up
  the shared code at its next normal deploy, and by then the Phase 0 tests have
  pinned its behaviour. The previous revision is the rollback.
- **Caic rollback.** (1) Pause the schedule in the console. (2) Update the app to
  its previous image digest or revision. (3) Remove `AIReviewed` from any PR that
  received a bad review (`gh pr edit --remove-label`). (4) Events in the caic index
  are kept for diagnosis. None of these steps touch core's app or indexes.

## 10. Acceptance criteria

Core is unchanged:

- **AC-1** Given `REVIEW_PROFILE` unset, when `buildReviewPrompt` is called, then
  the output equals the stored characterization snapshot of today's prompt.
- **AC-2** Given no profile (or `core`), when the review bundle is built for Bob,
  then the file set (including that `.bob/skills/` holds only `carbon-builder`),
  the rules text and the Claude bundle equal the stored snapshots.
- **AC-3** Given a corpus of stored model outputs, when the parser runs, then
  parsed findings, dropped findings and recommendation equal the stored results;
  a grid over finding counts gives today's `computeRecommendation`.
- **AC-4** Given no profile, when comments are formatted, then the text is
  byte-identical, including `[AI agent review — Carbon grounded]` and the
  "Carbon verification:" line.
- **AC-5** Given no `ES_INDEX_PREFIX`, when any name is built, then it equals
  today's literal (the §7 table, core column).
- **AC-6** Given a `classify()` corpus, when called without the extra argument,
  then every class equals today's.
- **AC-7** The three existing pinning tests pass unmodified, as do
  `tests/agents.test.js` `prepareBundle` and every other test in `test:all`.
- **AC-8** Given the finished change set, then `git diff --stat` shows no change
  to the files listed under "Files this change must not touch" in §3.

Caic works and is isolated:

- **AC-9** Given `ES_INDEX_PREFIX=carbon-monitor-caic`, when names are built, then
  no caic name matches core's `carbon-monitor-events-*` wildcard or template
  pattern, and no core name matches caic's.
- **AC-10** Given a caic review with no Cat 1 finding, when the summary is built,
  then it starts `[AI agent review - CAIC]` and has no "Carbon verification:" line.
- **AC-11** Given a caic review with a Cat 1 finding, then the line is present.
- **AC-12** Given a caic finding "hardcoded `cds--`" with
  `verificationSource: 'not-carbon-specific'`, when filtered, then it is kept; and
  a Carbon-specific finding with no MCP evidence is still dropped. The caic prompt
  text contains the instruction that sends convention findings to Cat 2.
- **AC-13** Given a caic-style output with no catalogue line, then the review is
  unreliable and the recommendation is `suggested-improvements`.
- **AC-14** Given paths `es-custom/…`, `telemetry.yml`, `custom-elements.json` and
  `x_spec.ts`, when classified with the caic extra patterns, then the first three
  are generated and the last is support; the same paths without them classify as
  today.
- **AC-15** Given the caic profile, when the Bob bundle is built, then
  `.bob/skills/` holds exactly `carbon-builder` and `caic-pr-review`.
- **AC-16** Given the skill directory, then `SKILL.md` has `name` equal to the
  directory name and a non-empty `description`; and given the file missing,
  `profiles.resolve('bob')` for `caic` throws.
- **AC-17** Given `caic` with `GITHUB_AI_AGENT_CLI=claude`, then startup fails with
  a clear message; given `core` with Claude, the bundle equals its snapshot.
- **AC-18** Given a fresh caic deployment, then the schedule `enabled` is false and
  it is read from and written to the caic-prefixed index only.
- **AC-19** Given `deploy_ce.sh` pointed at an existing app whose live repo or
  profile differs from the env file, then it aborts before any write; with
  matching values it proceeds; with `DEPLOY_ALLOW_TARGET_CHANGE=1` it proceeds.
- **AC-20** Given the deployed caic app, then `/api/config` reports
  `carbon-ai-chat` and the GitHub health tile is green against that repo.
- **AC-21** Given the test PRs in the scratch repo, when the eval runs the real
  pipeline on explicit PR numbers, then every run has a parseable catalogue and
  JSON block, seeded-defect recall meets the agreed target (§13 Q8), clean PRs
  (B1–B6) get no false positives, dropped Cat 2 findings are near zero, cost per
  review is no higher than core's prompt on the same PRs, the caic skill was used
  in a stated share of runs (`extra_skills_used`), and the recommendation rule is
  confirmed or a threshold is chosen from the data.

## 11. Verification plan

All new tests are plain Node scripts, each exiting non-zero on failure, and are
added to `test:all`. They run with no `.env`.

- **Phase 0, characterization, on unmodified code, before any change:**
  `tests/characterization.core.test.js` stores snapshots under
  `tests/fixtures/characterization/` for the core prompt, the rules text, the Bob
  and Claude bundle file sets, parser outputs over a model-output corpus, summary
  text, a `computeRecommendation` grid, a `classify()` corpus and the ES names
  (AC-1 to AC-6). The snapshots are generated once from commit `134efff` and
  reviewed by a human; a later change to a snapshot needs a stated reason.
- **Phase 1–3:** `tests/profile.test.js` (AC-16, AC-17),
  `tests/esNames.test.js` (AC-5, AC-9, AC-18), `tests/caicParser.test.js`
  (AC-12, AC-13), `tests/caicCoverage.test.js` (AC-14),
  `tests/caicSummary.test.js` (AC-10, AC-11), `tests/caicBundle.test.js` (AC-15,
  using the fake Bob in `tests/fixtures/bin/bob`), `tests/deployGuard.test.js`
  (AC-19, needs zsh; if CI lacks it the test is skipped there and run locally).
- **Unchanged-files check:** `git diff --stat` against the list in §3 (AC-8).
- **Carbon MCP experiment (Phase 0, cloud only):** deploy a bare second instance,
  sign in, check core stays connected through at least two refreshes each. This
  is the gate for Cat 1 on caic. It can disconnect core if the answer is bad, so
  run it in the daytime with core's schedule paused and the manual re-sign-in
  steps (`docs/MCP_TOKEN_REFRESH.md`) open.
- **Rule ledger:** every skill rule is traced to a source document and a commit.
  The user (or a caic member) reviews it before the schedule is enabled; it is not
  a gate for building.
- **Skill discovery at run time:** one real caic review on a scratch PR (Task 8);
  the agent's init event lists skills, and `caic-pr-review` must appear. The
  mechanism is the one already relied on for `carbon-builder`, and Bob's
  documentation states project-level skills are loaded, but a real run is the only
  full proof.
- **Eval:** `evals/caic/` holds `manifest.json` and a runner that drives the real
  pipeline with explicit PR numbers (which ignore the `AIReviewed` label,
  `src/index.js:597`) against the scratch repo, posting on, once with
  `REVIEW_PROFILE=caic` and once with `core`, and records parse success, findings,
  drops, cost, recommendation and `extra_skills_used` from the events. Comments
  from the two profiles are told apart by their header text. Re-running a PR adds
  another comment, which is harmless on a scratch repo.
  - **Cost.** 26 PRs twice is 52 real reviews. Task 9 first runs a 4-PR pilot,
    computes the mean Bobcoins per review from the ledger, states the total for 52
    runs, and the user approves it before the full run. No number is assumed here.
  - **Scoring.** A review finding matches a manifest entry when the file path
    matches and the reported line is within ±5 lines of the expected line, or the
    manifest marks the expectation file-level. Category labels are ignored. A
    human resolves unmatched findings and spot-checks 5 matches. Recall is matched
    expected defects over expected defects; a false positive is a finding on a
    clean PR that the human judges wrong.
  - A1–A12 seeded defects: `@carbon/react` import in `packages/ai-chat/src/`,
    hardcoded `cds--`, physical SCSS properties, descendant selector, new
    component under `components-legacy/`, logic trapped in a Lit element,
    listener teardown skipped, a11y regression, weakened test, new dependency
    with no reason, hand edit of generated output, invalid attribute on a
    `cds-*` element (the exact value is verified against MCP when written).
  - B1–B6 clean: clean refactor, source plus regenerated `telemetry.yml`,
    correct docs, a description explaining an odd change (a real defect must
    not be dropped on "author says intentional"), an issue with unmet "Done
    when" items (no completeness finding), a different but valid approach.
  - C1–C4 size and scope: about 150, 300 and 600 lines (the 600-line one bundles
    two unrelated changes), and one where regenerated `es-custom/` dominates.
  - D1–D4 copy: `en.json` tone, JSDoc with no unit, vague error string, comment
    that restates code.
  - Real merged caic PRs run through both prompts and are scored blind by a human,
    because the synthetic PRs are written by the assistant.
- **Scratch target:** `Chance-Gong/caic-pr-review-test`, public, default branch
  `main`. The baseline commit and the `AIReviewed` label exist. The 26 PRs are
  created by `scripts/create-caic-eval-prs.js` only with the user's go-ahead.
  Pushes use HTTPS with the `gh` login (the SSH key on this machine belongs to a
  different account, `ChanceG0`).
- **Cloud only:** the MCP experiment, Triage on carbon-ai-chat, the first
  scheduled run, a Slack digest from the caic app.
- **After the first scheduled run:** check the caic events index count, that core's
  index has no documents with `profile=caic`, the Slack digest, and that core's
  next run is unaffected.

### Regression risk register

Estimates, not measurements. Each depends on the named test existing and passing.
The target is at most 10% in each row.

| Risk                                                          | Before | After | What holds it down                                                                                                                                                     |
| ------------------------------------------------------------- | ------ | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core prompt, comments or bundle change                        | 25%    | 3%    | Early branch and optional parameters only; AC-1, 2, 4, 7; byte snapshots made before any edit.                                                                         |
| Parser, filter or recommendation behaviour changes            | 45%    | 2%    | Parser, runner and constants are not edited (AC-8); AC-3 pins outputs.                                                                                                 |
| Caic skill leaks into core reviews                            | 30%    | 2%    | Skill outside `.bob/` and outside the home folder, copied into a bundle only for `caic` (AC-2, AC-15).                                                                 |
| Core image build breaks                                       | 20%    | 1%    | `Dockerfile` and `.dockerignore` unchanged (AC-8).                                                                                                                     |
| Elasticsearch names collide or core reads caic data           | 40%    | 4%    | One names module; empty prefix gives literals (AC-5); disjoint patterns (AC-9); `init-index.js` is idempotent.                                                         |
| Deploy script updates the wrong app                           | 35%    | 7%    | Printed target, live-versus-file guard, separate `APP`/`SECRET_NAME`/`IMAGE_NAME` (AC-19). Remaining risk is that the guard cannot be tested against live Code Engine. |
| Core's running app is affected by the rollout                 | 25%    | 3%    | Core is not redeployed for caic; its old code uses literal names.                                                                                                      |
| Carbon MCP second sign-in disconnects core                    | 30%    | 8%    | Experiment first, in the daytime with schedule paused and the re-sign-in steps ready; a disconnect is recoverable by signing in again.                                 |
| Convention findings dropped by the Carbon filter              | 45%    | 4%    | Prompt marks them `not-carbon-specific`; existing parser line passes them (AC-12).                                                                                     |
| Shared Bobcoins budget starves core                           | 30%    | 8%    | `BOB_MAX_COST` per run, pilot cost estimate approved first, schedules staggered, `adapter.credits()` check before every review.                                        |
| Distilled rules wrong or noisy (quality, not core regression) | 40%    | 10%   | Source-tagged ledger, human review before the schedule is enabled, eval with no-false-positive requirement. Without the review this stays near 20%.                    |
| Wrong Carbon flavour (React versus Web Components) in reviews | 45%    | 8%    | Flavor table in the prompt; eval cases A1 and A12; `component_type` required on every MCP call.                                                                        |

## 12. Tasks

Each task is small, verified against its criteria, and done in a fresh session
from this SPEC. No task redeploys core.

1. Phase 0a. Write the characterization tests and fixtures on unmodified code
   (AC-1 to AC-6). Record the "must not touch" file list. Files:
   `tests/characterization.core.test.js`, `tests/fixtures/characterization/`,
   `package.json`.
2. Phase 0b. Run the Carbon MCP two-sign-in experiment (user-run, daytime, core's
   schedule paused). Record the result in §13. Decides whether Cat 1 is on for caic.
3. Phase 0c. Read the remaining caic docs (`packages/ai-chat/AGENTS.md`,
   `packages/ai-chat-components/AGENTS.md`, `accessibility.md`, `measuring.md`,
   `types/AGENTS.md`, `authoring-agents-md.md`) and build the rule ledger at
   `specs/caic-pr-review/rules-ledger.md`. Pin the upstream commit.
4. Phase 1. Profile plumbing with no behaviour change: `src/profiles/index.js`
   (`core` default, `caic` validation), optional parameters in `buildReviewBundle`,
   `classify`/`selectCoverage`, both adapters' `prepareBundle`, the three
   `format*` functions and the early branch in `buildReviewPrompt` (returning a
   stub for `caic` until Task 8); resolve the profile once in `src/index.js` and
   add `profile` to events. AC-1 to AC-8, AC-16 (resolve part), AC-17.
5. Phase 2a. `src/esNames.js` and its use in `eventService.js`, `spend.js`,
   `server.js`, `scheduleManager.js`, `mcpConnection.js`, `scripts/init-index.js`;
   add `profile` to `INDEX_MAPPING`; `.env.example`. Re-grep `carbon-monitor-`
   over `src/` and `scripts/` to confirm no literal is missed. AC-5, AC-9, AC-18.
6. Phase 2b. `deploy_ce.sh`: `DEPLOY_ENV_FILE`, printed target, guard function in
   its own file, passthrough of `REVIEW_PROFILE`, `ES_INDEX_PREFIX`,
   `MCP_STATE_INDEX`, `MCP_STATE_DOC_ID`. `tests/deployGuard.test.js`. AC-19.
7. Phase 3a. The `caic-pr-review` skill under `src/profiles/caic/skills/`,
   linked to the ledger; measure its token cost with and without it and set the
   size cap; `tests/caicBundle.test.js` for the extra-skill copy. AC-15, AC-16.
8. Phase 3b. Caic content: `src/profiles/caic/prompt.js`, rules text, flavor table,
   extra coverage patterns, summary header and conditional verification line,
   `extra_skills_used`. Run one real review on a scratch PR and confirm the init
   event lists `caic-pr-review`. AC-10 to AC-14.
9. Phase 4. Eval: `evals/caic/manifest.json`, runner, the script that builds the
   scratch PRs (user's go-ahead first), the 4-PR pilot and cost approval, the full
   run, the blind-scored real-PR comparison. AC-21.
10. Phase 5a. Docs: `docs/CONFIGURATION.md`, `docs/HARNESS.md` §5/§6 note,
    `docs/REVIEW_OUTPUT.md` (caic header), `README.md` pointer. Optional help-text
    line in the console about the account-wide gauge.
11. Phase 5b. Rollout: create the caic secret, run `init-index.js`, deploy caic with
    the schedule off; check AC-20; run explicit PR numbers; enable posting; enable
    the schedule.
12. Phase 5c (optional, later). Redeploy core with the shared code at its next
    normal deploy, previous revision as rollback; check the next core run.

## 13. Open questions

| #   | Question                                                                                                                                                                                                                                                                                                                                                                        | Owner                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| 1   | **Carbon MCP: does a second IBMid sign-in revoke the first?** Undocumented. Test in Task 2. If it fails, stop and re-plan: either caic reads core's bearer without refreshing (the `HARNESS.md` §7 worker design, not built) or caic starts with Cat 1 disabled (needs a prompt variant, not specified). A confirmed answer from the Carbon MCP team is also a §7 prerequisite. | User (needs a second IBMid login) |
| 2   | Closed. `ORIGINAL_FILES.json` is tried first and the GitHub file list is the fallback (`index.js:703-726`), so ordinary PRs need nothing.                                                                                                                                                                                                                                       | none                              |
| 3   | Closed for the current tree. A grep of `src/` found the hardcoded names only in `eventService.js:53`, `spend.js:9`, `server.js:545`, `scheduleManager.js:193`, `mcpConnection.js:216` and `scripts/init-index.js:43-45`. Task 5 repeats the grep before editing.                                                                                                                | Implementer, Task 5               |
| 4   | Does the reviewing account have Triage on carbon-ai-chat, and is `GITHUB_AI_AGENT_TOKEN` authorized (SAML SSO)? Which GitHub account owns it? On this machine the SSH key belongs to `ChanceG0` and the `gh` login is `Chance-Gong`; the scratch repo is `Chance-Gong`'s, so pushes use HTTPS, and the token's account needs write and triage on it.                            | User                              |
| 5   | Closed. `creditLedger.js`, the schedule state file and the MCP state file are container-local; only the Elasticsearch copies need prefixes.                                                                                                                                                                                                                                     | none                              |
| 6   | Human review of the rule ledger (about an hour), by the user or a caic member, before the schedule is enabled.                                                                                                                                                                                                                                                                  | User                              |
| 7   | Caic's own docs conflict on `telemetry.yml` (`AGENTS.md`: never hand-edit; `large-diffs.md`: committed and regenerated). The skill treats a change that accompanies a source change as fine. Confirm with caic.                                                                                                                                                                 | Caic maintainers                  |
| 8   | The seeded-defect recall target, and whether core's recommendation rule suits caic (caic's `major` is narrower). Set from the eval data; a caic threshold is added only if needed.                                                                                                                                                                                              | User, with the Task 9 results     |
| 9   | Shared Bobcoins budget: both apps draw from one account balance and `adapter.credits()` sees the account-wide figure. Is a combined budget acceptable, and who is alerted?                                                                                                                                                                                                      | User                              |
| 10  | Eval set: the user can ask caic members for real PRs; for now it is the scratch repo plus real merged PRs scored blind.                                                                                                                                                                                                                                                         | User                              |
| 11  | Does a full real caic review show `caic-pr-review` in Bob's skill list? Documented behaviour and the `carbon-builder` mechanism say yes; Task 8 confirms with one run.                                                                                                                                                                                                          | Implementer, Task 8               |
| 12  | `tests/deployGuard.test.js` needs zsh. Is zsh available in CI? If not, the test runs locally only.                                                                                                                                                                                                                                                                              | Implementer, Task 6               |
