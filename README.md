<p align="center"><img src="docs/images/hero.png" width="100%" alt="Carbon Monitor: Agentic AI pull request reviews, grounded by Carbon MCP. IBM Bob, Claude, Carbon MCP, GitHub. supports IBM Bob and Claude, adapt the pattern to any repo or a different job with the bundled skill."></p>

# Carbon Monitor

**Agentic AI pull request reviews, grounded by Carbon MCP.**

Carbon Monitor is two things. It is a working reviewer for the
`carbon-design-system/carbon` monorepo: each open pull request goes through an AI
CLI agent (IBM Bob by default, or Claude), every Carbon-specific claim (component
props, tokens, icons, accessibility patterns) is verified against the Carbon MCP
server, and the result lands on the PR as one review of inline comments and a
summary with a recommendation. A clean PR gets one short verdict comment
instead. It is also a harness for running any agent on a schedule in IBM Cloud, with cost
tracking, telemetry and a Slack report, that you can point at your own
repository or your own job. A skill adapts it for you. It asks up to ten
questions and writes the SPEC you build from, and you keep the Cloud deploy,
cost caps, telemetry and Slack report as they are.

<p align="center">
  <a href="#quick-start"><strong>Quick start</strong></a> ·
  <a href="#adapt-it-with-a-skill"><strong>Adapt it with a skill</strong></a> ·
  <a href="#how-a-review-works"><strong>How a review works</strong></a> ·
  <a href="#deploy"><strong>Deploy</strong></a> ·
  <a href="docs/ARCHITECTURE.md"><strong>Architecture</strong></a> ·
  <a href="docs/API.md"><strong>API</strong></a> ·
  <a href="CONTRIBUTING.md"><strong>Contributing</strong></a>
</p>

<p align="center"><a href="https://github.com/carbon-design-system/Carbon-Monitor/actions/workflows/test.yml"><img src="https://github.com/carbon-design-system/Carbon-Monitor/actions/workflows/test.yml/badge.svg" alt="Tests workflow status"></a> · Apache-2.0 · Built for the Carbon Design System</p>

---

## Supported agents

| Agent       | CLI                                         | Select with                  | Key from `.env`     | Cost unit  |
| ----------- | ------------------------------------------- | ---------------------------- | ------------------- | ---------- |
| **IBM Bob** | Bob Shell CLI (`bob run`), the default      | `GITHUB_AI_AGENT_CLI=bob`    | `BOB_API_KEY`       | Bobcoins   |
| **Claude**  | Claude Code CLI in print mode (`claude -p`) | `GITHUB_AI_AGENT_CLI=claude` | `ANTHROPIC_API_KEY` | US dollars |

Both CLIs are in the container image, and one variable picks the reviewer. The
rubric, the prompt, the output parser, the Carbon MCP checks, the schedule and
the console are the same for both. The summary comment says which one ran
(`Reviewed by: IBM Bob` or `Reviewed by: Claude`), and cost is recorded in the
agent's own unit. Each agent runs in its own private configuration directory, so
`REVIEW_CONCURRENCY` applies to both. Another CLI is one adapter file; see
[Add an agent](docs/HARNESS.md#add-an-agent).

## What it does

| Stage      | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Fetch**  | Queries GitHub for open PRs, excluding drafts, bot-authored PRs (Dependabot, Renovate), PRs older than 21 days and PRs already labelled `AIReviewed`. Up to 10 PRs per run. Both limits are configurable.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Bundle** | Builds a temporary workspace per PR: `PR_REVIEW_REQUEST.md` (description, changed files, the unified diff, and a list of files left out), `pr.json` / `files.json` / `diff.patch`, the agent rules (`.bob/rules/01-output.md` for Bob, `CLAUDE.md` for Claude), and the Carbon Builder skill. A `Closes #N`, `Fixes #N` or `Resolves #N` reference pulls in the linked issue (and its parent) as acceptance criteria, capped at 5,000 tokens. The diff is assembled from each file's patch as whole files fitted to the input budget, tests and docs after source, so no PR is skipped for its size; what does not fit is listed under Files Not Reviewed. |
| **Review** | Runs the selected agent in the bundle: `bob run --trust --accept-license [--team-id …] "<prompt>"` or `claude -p … "<prompt>"`. The agent writes a visible catalogue of every suspicious item per file, classified as Category 1 (Carbon API, needs MCP) or Category 2 (visible in the diff).                                                                                                                                                                                                                                                                                                                                                              |
| **Verify** | Resolves every catalogue item. Category 1 items are checked with the Carbon Builder skill and Carbon MCP tools (`code_search`, `docs_search`, `get_charts`, `labs_search`, `code_audit`); Category 2 items from the diff alone. The parser flags runs that skipped the catalogue or hid their resolutions.                                                                                                                                                                                                                                                                                                                                                 |
| **Post**   | Findings of `minor` severity or above that map to a diff line go out as inline comments in one GitHub review. The rest, plus the summary and recommendation, go in one PR comment, with any nits in a collapsed list; nits are never inline. A clean PR gets one short verdict comment and no review. A partial review says so in that comment and lists the files it did not cover. If no file fits the budget, no agent runs and the PR gets a Not Reviewed comment. The `AIReviewed` label is added.                                                                                                                                                    |
| **Report** | Scheduled runs post a digest to Slack when `SLACK_WEBHOOK_URL` is set. Review events are written to Elasticsearch for the Kibana dashboard.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

## Adapt it with a skill

The agent is IBM Bob or Claude. Carbon Monitor is the harness around it:
everything that runs it on a schedule in IBM Cloud, pays for it, logs it, and
reports on it. The
review logic is the one part that is specific to the job, and it sits behind
named seams.

| Harness, kept as is                        | Task layer, replaced per job               |
| ------------------------------------------ | ------------------------------------------ |
| Code Engine deployment, image, secret sync | Work-item source (GitHub today)            |
| Daily schedule with budget auto-pause      | Workspace, prompt and output parser        |
| Agent runner and MCP token refresh         | Write-back and the done marker             |
| Cost ledger, Elasticsearch events, Kibana  | Event fields, digest lines, console labels |
| Slack transport, console shell, sign-in    | Health tiles for the external system       |

Three ways to make it yours:

| Path                   | What changes                                                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Another repository** | Configuration, the reviewing account's access, and optionally the rubric and the MCP server                                                                                                 |
| **Another job**        | The task layer, against any system: Jira, ServiceNow, Box, a database, a feed                                                                                                               |
| **Another agent**      | Bob and Claude are built in and switch with `GITHUB_AI_AGENT_CLI`. Another CLI is one adapter file in `src/agents/`, plus its install and key; Codex, Gemini CLI and Copilot CLI are mapped |

The `carbon-monitor-adapt-harness` skill walks you through any of them. It
reads the harness map, asks at most ten questions, and writes a SPEC you
implement from. To use it:

1. From a clone of this repository, install the skill into your coding agent.
   No skill support? Say "Read `skills/carbon-monitor-adapt-harness/SKILL.md`
   and use it as your instructions" instead.

   ```bash
   npx skills add https://github.com/carbon-design-system/Carbon-Monitor/tree/main/skills/carbon-monitor-adapt-harness -a claude-code   # or -a bob, cursor, codex, github-copilot, gemini-cli
   ```

2. Open your agent in the clone and say "Adapt this harness to my use case"
   (in Claude Code, `/carbon-monitor-adapt-harness`). Answer the questions;
   "default" accepts a default. It writes `specs/<name>/SPEC.md`.
3. Start a fresh session and say "Implement `specs/<name>/SPEC.md`, one task
   at a time, verifying each against its acceptance criteria."

The map is [docs/HARNESS.md](docs/HARNESS.md). The skill is in [skills/carbon-monitor-adapt-harness](skills/carbon-monitor-adapt-harness/README.md); per-agent
swap notes and two finished example SPECs are in [docs/adapt-harness](docs/adapt-harness/agents/bob.md).

## What a review looks like

<p align="center"><img src="docs/images/pr-review-comment.png" width="720" alt="A GitHub pull request comment from carbon-monitor-agent headed 'AI agent review, Carbon grounded: Consider Revising'. It names the commit reviewed, states that Carbon claims were verified with the Carbon Builder skill and Carbon MCP, gives a recommendation citing two major findings, a collapsed Findings (3) section, a summary of the PR, and a note that human review is advised. Below it, the agent has added the AIReviewed label."></p>

<p align="center"><em>The summary comment on a reviewed PR, followed by the AIReviewed label.</em></p>

A PR with nothing above `nit` gets a much shorter comment: a verdict line, the
agent's summary and, when there are nits, a collapsed list of them with title and
location. It carries no recommendation section, findings table or token usage, and
the PR gets no inline comments. Nits are never inline on any PR. If the review's
reliability is in doubt, the PR gets the full summary comment with a reliability
note instead.

Every review ends in one of three recommendations:

| Value                    | Meaning                                                             |
| ------------------------ | ------------------------------------------------------------------- |
| `Consider Revising`      | One or more `blocking` findings, or two or more `major` findings    |
| `Suggested Improvements` | Any `major` or `minor` finding, or review reliability was uncertain |
| `Looks Good`             | `nit`-level findings only, or no findings                           |

Each finding carries a severity:

| Severity   | Meaning                                                                        |
| ---------- | ------------------------------------------------------------------------------ |
| `blocking` | Breaks user-facing behaviour or violates an accessibility requirement          |
| `major`    | Likely to cause a visible rendering difference or runtime error                |
| `minor`    | Maintainability risk or subtle behaviour difference — not immediately breaking |
| `nit`      | Convention / hygiene — no functional consequence                               |

The inline, summary and Looks Good comment formats, the partial-review note, and
the reliability checks behind the recommendation, are in
[docs/REVIEW_OUTPUT.md](docs/REVIEW_OUTPUT.md).

## See it running

<p align="center"><img src="docs/images/dashboard.webp" width="820" alt="The Carbon Monitor dashboard. Four status tiles show Bob Shell CLI v2.0.5 with an API key configured, Carbon MCP connected with auto-refresh active, GitHub with 4974 of 5000 API calls remaining, and an ElasticDB tile reporting the Elasticsearch cluster green. Below are the Reviews panel with run state, target and schedule times, a Bobcoins gauge at 86 percent remaining, the review output log for PR 23717, and a table of spend per recent review."></p>

<p align="center"><em>The operator console after a clean single-PR run.</em></p>

<table>
  <tr>
    <td width="50%"><img src="docs/images/settings-mcp.webp" alt="The Settings dialog on the Carbon MCP connection tab, showing status Connected, automatic renewal, the cached token's remaining time, the last refresh time and the server URL, with Sign in with IBMid, Test connection, Refresh now and Sign out buttons and a collapsed section for entering credentials manually."></td>
    <td width="50%"><img src="docs/images/settings-schedule.webp" alt="The Settings dialog on the Scheduled reviews tab, showing the daily scheduled review switched on, a daily run time of 9:00 PM Central Time, the review target, Save, Discard and Pause schedule controls, and the last and next scheduled run times."></td>
  </tr>
  <tr>
    <td><em>Carbon MCP connection: sign in once with IBMid, then the container renews its own token.</em></td>
    <td><em>Scheduled reviews: one daily run, off until an operator turns it on.</em></td>
  </tr>
</table>

<p align="center"><img src="docs/images/slack-digest.webp" width="820" alt="A Slack message from the Carbon Monitor app titled Review Digest. It lists the repository, run start time and selection criteria, then five pull requests, each with a coloured status marker, a verdict such as Significant revision suggested, Minor rework suggested or Looks good, an issue count and a one-line summary. The footer reads 5 PRs reviewed and links to Configure schedule."></p>

<p align="center"><em>The Slack digest posted after a scheduled run.</em></p>

<p align="center"><img src="docs/images/login.webp" width="720" alt="The Carbon Monitor sign-in page: a Welcome to Carbon Monitor heading above a Sign in form with Username and Password fields and a Sign in button."></p>

<p align="center"><em>The console sign-in page, shown when AUTH_REQUIRED is on.</em></p>

## Who can run this

> Reading, testing and adapting the code needs nothing special: `npm ci` and
> `npm run test:all` run anywhere with Node 22.15 or later. Running a review does
> need IBM access. Bob Shell requires the IBM office network or VPN; outside it,
> requests fail with Cloudflare errors. Claude talks to the Anthropic API and
> needs no IBM network for inference. Carbon MCP authenticates with an IBMid
> for either agent, and its token expires, so the console renews it after one
> **Sign in with IBMid**.
> On the GitHub side, it needs a token for the reviewing GitHub account (i.e.
> machine user), which must hold Triage on the target repo; see [docs/GITHUB_ACCESS.md](docs/GITHUB_ACCESS.md).

## Quick start

| Prerequisite        | Notes                                                                                                                                                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js 24 or later | Required by Bob Shell; the code itself runs on >= 22.15.0                                                                                                                                                            |
| GitHub token        | For the reviewing GitHub account (i.e. machine user), which needs the **Triage role on the target repo**, plus Pull requests and Issues write and Contents read. See [docs/GITHUB_ACCESS.md](docs/GITHUB_ACCESS.md). |
| Bob Shell CLI       | Installed and on `PATH`, when the agent is `bob` (the default)                                                                                                                                                       |
| Claude Code CLI     | Installed and on `PATH`, when the agent is `claude`: `npm install -g @anthropic-ai/claude-code`. Claude Code 2.1.259 or later (the image pins 2.1.302)                                                               |
| Carbon MCP          | Configured in Bob as a streamable-HTTP connection; Claude reads the same credentials (see below)                                                                                                                     |

```bash
git clone https://github.com/carbon-design-system/Carbon-Monitor.git
cd Carbon-Monitor
npm ci
cp .env.example .env
```

Set the two required variables in `.env`:

```bash
GITHUB_AI_AGENT_TOKEN=ghp_your_github_token_here
BOB_API_KEY=your_bob_api_key_here
```

To review with Claude instead, set the agent and its key (an API key from the
Claude Console; `BOB_API_KEY` is then not needed):

```bash
GITHUB_AI_AGENT_CLI=claude
ANTHROPIC_API_KEY=your_anthropic_api_key_here
```

Start the console and API, then review one PR from the CLI:

```bash
npm run build:client && npm run api   # console + API on http://localhost:3000
npm start -- --pr <number>            # review a single PR
```

`npm start` with no flag reviews every PR that passes the Fetch filter.

<details>
<summary>Configuration</summary>

The variables most deployments set. Every variable, with its default, is in
[docs/CONFIGURATION.md](docs/CONFIGURATION.md).

| Variable                    | Required      | Default                | Description                                                                                                                                                               |
| --------------------------- | ------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_AI_AGENT_TOKEN`     | Yes           | —                      | GitHub PAT. Needs Pull requests + Issues write and Contents read, **and Triage on the repo** — see [GitHub access](docs/GITHUB_ACCESS.md)                                 |
| `GITHUB_AI_AGENT_CLI`       | No            | `bob`                  | Worker agent: `bob` or `claude`. Another CLI needs an adapter, see [Add an agent](docs/HARNESS.md#add-an-agent)                                                           |
| `BOB_API_KEY`               | With `bob`    | —                      | Bob Shell API key. Create with Scope **Inference** in the Bob web portal — browser SSO cannot complete in a container                                                     |
| `ANTHROPIC_API_KEY`         | With `claude` | —                      | Claude Code API key from the Claude Console. Required when `GITHUB_AI_AGENT_CLI=claude`; leave blank for Bob                                                              |
| `GITHUB_AI_AGENT_OWNER`     | No            | `carbon-design-system` | Repository owner                                                                                                                                                          |
| `GITHUB_AI_AGENT_REPO`      | No            | `carbon`               | Repository name                                                                                                                                                           |
| `GITHUB_AI_AGENT_MAX_PRS`   | No            | `10`                   | Max PRs reviewed per run                                                                                                                                                  |
| `GITHUB_AI_AGENT_DAYS_BACK` | No            | `21`                   | How far back to look for PRs (days)                                                                                                                                       |
| `CLAUDE_MODEL`              | No            | `claude-sonnet-5-5`    | Claude model                                                                                                                                                              |
| `CLAUDE_EFFORT`             | No            | `high`                 | Claude reasoning effort                                                                                                                                                   |
| `CLAUDE_MAX_BUDGET_USD`     | No            | `5`                    | Per-review spend cap in USD, passed as `--max-budget-usd`. `0` disables it. Spend can pass the cap slightly                                                               |
| `CLAUDE_MAX_TURNS`          | No            | `60`                   | Per-review turn cap, passed as `--max-turns`. `0` disables it                                                                                                             |
| `CLAUDE_ALLOWED_TOOLS`      | No            | read-only set          | `Read(./**),Glob,Grep,Skill(carbon-builder),mcp__carbon-mcp`                                                                                                              |
| `CLAUDE_DISALLOWED_TOOLS`   | No            | edit and shell set     | `Bash,Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch,Agent`. Three more deny rules are always added, see [docs/CONFIGURATION.md](docs/CONFIGURATION.md#claude-code) |
| `CLAUDE_MONTHLY_BUDGET_USD` | No            | unset                  | Monthly budget in USD for scheduled reviews. Unset means not metered                                                                                                      |
| `CLAUDE_BUDGET_LOW_PCT`     | No            | `10`                   | Scheduled reviews pause below this percentage of the monthly budget                                                                                                       |

**Bob Shell.** Install with the official script,
`curl -fsSL https://bob.ibm.com/download/bobshell.sh | bash` (IBM network or
VPN), then run `bob trust /private/tmp` and `bob trust /path/to/Carbon-Monitor`
so Bob can use MCP tools in the review bundles.

**Claude Code.** Install with `npm install -g @anthropic-ai/claude-code`
(Node 22 or later; Claude Code 2.1.259 or later, the image pins 2.1.302), create an API key in the Claude Console, and put it in
`.env` as `ANTHROPIC_API_KEY`. The key is read from the environment, so there is
no login step. Claude reviews read-only: file reads, search and the Carbon tools
are allowed, and shell, edits, web access and subagents are denied.

**Carbon MCP.** Add a `carbon-mcp` entry of type `streamable-http` pointing at
`https://mcp.carbondesignsystem.com/mcp` to `~/.bob/settings/mcp.json`, then
check that `/mcp list` inside `bob` reports `carbon-mcp - Ready`. That file is
the one place the credentials live for both agents: for each Claude review the
harness copies them into the bundle's own MCP file.

**Carbon Builder skill.** `npm ci` (or `npm install`) places it in `.bob/skills/carbon-builder/`
if it is missing. Otherwise follow the
[Carbon Builder skill setup guide](https://carbondesignsystem.com/developing/carbon-mcp/onboarding-and-setup/#step-4:-adding-the-carbon-builder-skill).

The full `mcp.json` example is in [docs/CONFIGURATION.md](docs/CONFIGURATION.md);
token permissions are in [docs/GITHUB_ACCESS.md](docs/GITHUB_ACCESS.md).

</details>

## How a review works

```
POST /api/review/trigger          202 Accepted at once
  └─► reviewPRs()                 src/index.js
        ├─► GitHub: select open PRs, fetch changed files and patches + linked issue
        ├─► buildReviewBundle()   src/reviewBundle.js
        ├─► runAgent()            src/agentRunner.js, through src/agents/<agent>.js
        │     bob run --trust --accept-license [--team-id …] "<prompt>"
        │     claude -p --output-format stream-json … "<prompt>"
        │     └─► Carbon MCP: code_search · docs_search · get_charts · labs_search · code_audit
        ├─► parseReviewOutput()   src/reviewParser.js
        ├─► post one review of inline comments, then the summary (or verdict) comment, apply the AIReviewed label
        └─► Slack digest (scheduled runs only, when SLACK_WEBHOOK_URL is set)
```

Only one batch runs at a time, with up to `REVIEW_CONCURRENCY` reviews (default 2)
in flight inside it, for either agent. Two agents reviewing the same PR would post the
same findings twice, so a second trigger while one is in flight gets `409` with
the running batch's details. The guard is in-process, and the Code Engine app
is pinned to one instance, so one lock covers the deployment. A review takes
minutes, longer than Code Engine's 300-second request ceiling, so the trigger
returns `202` straight away and callers poll `GET /api/review/status`. The full
contract, including request bodies, validation and authentication, is in
[docs/API.md](docs/API.md).

## Deploy

| Target                    | How                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Local**                 | `npm run build:client && npm run api` serves the console and API on one port: `PORT`, then `API_PORT`, default `3000`.                                                                                                                                                                                                                                                                                                      |
| **Container**             | `npm run build:client`, then `podman build --platform linux/amd64 -t carbon-monitor .` and `podman run -d -p 8080:8080 --env-file .env carbon-monitor`, or `docker compose up -d` with the included `docker-compose.yml`, which keeps `/workspace` in a named volume so a restart does not force a new IBMid sign-in. The image must be Debian-based: Bob Shell's `node-pty` prebuild needs glibc, so Alpine cannot run it. |
| **IBM Cloud Code Engine** | `./deploy_ce.sh` reads credentials and the deployment target (`REGION`, `RESOURCE_GROUP`, `PROJECT`, `NAMESPACE`) from `.env`, syncs the secret, builds, pushes and deploys. The app runs at min-scale 1 and max-scale 1: the Carbon MCP refresh timer needs an instance that never scales to zero, and the rotating refresh token needs exactly one writer.                                                                |

After the first deploy, open the console and press **Sign in with IBMid** once.
The deployment topology, ordering rules and image layout are in
[docs/ARCHITECTURE.md §8](docs/ARCHITECTURE.md#8-deployment).

To deploy a **second instance** reviewing `carbon-design-system/carbon-ai-chat`
from the same image and Elasticsearch cluster, set `REVIEW_PROFILE=caic`,
`ES_INDEX_PREFIX=carbon-monitor-caic`, `APP=carbon-monitor-caic` and
`DEPLOY_ENV_FILE=.env.caic` in a separate env file, then run
`DEPLOY_ENV_FILE=.env.caic ./deploy_ce.sh` — or set `DEPLOY_ENV_FILE` in `.env`
before calling the script. The caic deployment keeps its own secret, schedule and
Bobcoins budget, and its Elasticsearch events are isolated from core's. Both
deployments share the same image and reviewing account. See
[docs/HARNESS.md §6](docs/HARNESS.md#second-repository-same-image-the-profile-pattern)
and [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for the full variable list.

`./deploy_ce.sh` passes `GITHUB_AI_AGENT_CLI` from `.env` (default `bob`) and the
`CLAUDE_*` settings through, and syncs `ANTHROPIC_API_KEY` into the Code Engine
secret beside `BOB_API_KEY`. It refuses to deploy without the key of the agent
you selected: `BOB_API_KEY` for `bob`, `ANTHROPIC_API_KEY` for `claude`. Moving a
deployment to Claude is `GITHUB_AI_AGENT_CLI=claude` plus the key, then a
redeploy. The image holds both CLIs, so it is the same image.

### Console sign-in

Sign-in is off in code but **on in `.env.example` and in the `deploy_ce.sh`
default**. With `AUTH_REQUIRED=true`, the console shows a sign-in page that
accepts `CONSOLE_USERNAME` / `CONSOLE_PASSWORD`, scripts authenticate with
`Authorization: Bearer <API_SECRET>`, and `SESSION_SIGNING_KEY` should be set so
a restart does not sign everyone out. With it off, anyone with the app's URL can
read status and trigger a review. See
[docs/ARCHITECTURE.md §5](docs/ARCHITECTURE.md#5-authentication-model).

## Operate

| Feature               | What it does                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Operator console**  | Status tiles for the agent CLI, Carbon MCP, GitHub and Elasticsearch that say what is wrong, a Reviews panel to run the latest PRs or a named list, and a live log of the current or last run.                                                                                                                                                                                         |
| **Scheduled reviews** | One daily run, configured in **Settings → Scheduled reviews**. Off on a fresh install. `npm start` also runs a single pass and exits, so an external scheduler can drive it.                                                                                                                                                                                                           |
| **Slack digest**      | Set `SLACK_WEBHOOK_URL` to a Slack incoming webhook. The digest fires after scheduled runs only; runs started from the console do not post. A partial review shows as `partial review: N of M files` on its line.                                                                                                                                                                      |
| **Kibana dashboard**  | Review metrics from Elasticsearch, when `ES_URL` is set. Setup is in [kibana/README.md](kibana/README.md).                                                                                                                                                                                                                                                                             |
| **Cost tracking**     | Bob: the Bobcoins balance and per-review spend; scheduled reviews pause themselves, and alert Slack, when the balance falls below `BOB_CREDITS_LOW_PCT` (default 10%). Claude: per-review spend in dollars and the month so far; with `CLAUDE_MONTHLY_BUDGET_USD` set, scheduled reviews pause below `CLAUDE_BUDGET_LOW_PCT` (default 10%) of it, and without it they are not metered. |

### Spend caps and budgets

Per review, the agent CLI enforces the caps, so they hold whichever agent runs:

| Cap              | IBM Bob                                            | Claude                                                            |
| ---------------- | -------------------------------------------------- | ----------------------------------------------------------------- |
| Cost per review  | `BOB_MAX_COST` in Bobcoins, passed as `--max-cost` | `CLAUDE_MAX_BUDGET_USD` (default 5), passed as `--max-budget-usd` |
| Turns per review | `BOB_MAX_TURNS`, passed as `--max-turns`           | `CLAUDE_MAX_TURNS` (default 60), passed as `--max-turns`          |
| Wall time        | the harness timeout                                | the harness timeout                                               |

Both CLIs check the cost cap between turns, so a run can pass it by one turn's cost. Leave headroom. A run stopped by a cap is recorded with its spend and reported as a cost or turn limit in the log, the ledger and telemetry.

Per month, the two agents differ:

- **Bob.** The account's Bobcoins allowance is enforced by the Bob gateway. When it is spent, reviews are refused whatever the harness does. The harness pauses scheduled reviews earlier, below `BOB_CREDITS_LOW_PCT` of the balance, and tells Slack.
- **Claude.** There is no account-side stop the harness can see. `CLAUDE_MONTHLY_BUDGET_USD` is the harness's own gate over recorded spend (Elasticsearch, with the local ledger as a fallback). Scheduled reviews pause below `CLAUDE_BUDGET_LOW_PCT` of it. The gate covers scheduled runs only, and reviews in flight are not counted yet, so spend can pass the budget by up to `REVIEW_CONCURRENCY × CLAUDE_MAX_BUDGET_USD`. Unset means not metered. For a hard account-level stop, set a monthly spend limit on the workspace that owns the API key in the Anthropic Console. Details in [docs/CONFIGURATION.md](docs/CONFIGURATION.md#the-monthly-budget-gate).

## Documentation

| Document                                                                             | Covers                                                                                               |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)                                         | Container image, Carbon MCP token refresh, authentication, Code Engine deployment, module map        |
| [docs/HARNESS.md](docs/HARNESS.md)                                                   | Harness versus task layer, every extension point, the agent adapters, the names that change          |
| [skills/carbon-monitor-adapt-harness](skills/carbon-monitor-adapt-harness/README.md) | The skill that interviews you and writes a SPEC for your own repository, job or agent                |
| [docs/GITHUB_ACCESS.md](docs/GITHUB_ACCESS.md)                                       | The reviewing GitHub account (i.e. machine user), its token permissions, and why it needs Triage     |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md)                                       | Environment variables, Bob Shell, Claude Code, Carbon MCP and Carbon Builder setup                   |
| [docs/API.md](docs/API.md)                                                           | REST endpoints and the full review trigger contract                                                  |
| [docs/REVIEW_OUTPUT.md](docs/REVIEW_OUTPUT.md)                                       | Inline, summary and Looks Good comment formats, partial reviews, recommendations, reliability checks |
| [docs/INLINE_COMMENTS.md](docs/INLINE_COMMENTS.md)                                   | How findings are mapped to diff lines                                                                |
| [docs/TOKEN_USAGE_TRACKING.md](docs/TOKEN_USAGE_TRACKING.md)                         | Token usage estimates in the summary comment                                                         |
| [docs/MCP_TOKEN_REFRESH.md](docs/MCP_TOKEN_REFRESH.md)                               | Manual Carbon MCP token refresh, the fallback to IBMid sign-in                                       |
| [kibana/README.md](kibana/README.md)                                                 | Kibana dashboard setup                                                                               |
| [CONTRIBUTING.md](CONTRIBUTING.md)                                                   | Setup, tests and pull request guidelines                                                             |
| [SECURITY.md](SECURITY.md)                                                           | Reporting a vulnerability                                                                            |

## Troubleshooting

**Bob not found in PATH.** Install it with
`curl -fsSL https://bob.ibm.com/download/bobshell.sh | bash`, then confirm with
`which bob`.

**Carbon MCP not connected.** Run `/mcp list` inside `bob`; it should show
`carbon-mcp - Ready`. If not, check `~/.bob/settings/mcp.json`, sign in with
IBMid from the console, or call `POST /api/mcp/refresh`.

**No PRs to review.** Expected when every open PR already has the `AIReviewed`
label, or none was opened within the `DAYS_BACK` window.

**A comment says "Partial review".** The PR did not fit the diff budget
(`GITHUB_AI_AGENT_MAX_INPUT_TOKENS`) or the file cap (`GITHUB_AI_AGENT_MAX_FILES`,
default 300), so the comment lists the files that were not reviewed. Raising
either limit covers more; see
[Partial reviews](docs/REVIEW_OUTPUT.md#partial-reviews). If not even one line of
any file fits, no agent runs: the PR gets a Not Reviewed comment and the
`AIReviewed` label.

**Claude: no API key.** With `GITHUB_AI_AGENT_CLI=claude` and
no `ANTHROPIC_API_KEY`, the log and `GET /api/ready` `warnings` say
`ANTHROPIC_API_KEY is not set`, and `deploy_ce.sh` stops before it deploys. The
process stays up so the console can show the problem. Set the key in `.env`.

**Claude: `/api/ready` returns 503.** The reason names what is missing, for
example `Agent CLI 'claude' is not available on PATH`. Install the CLI, or use
the image. A missing key is only a warning on a `200`, and the agent tile turns
red with `ANTHROPIC_API_KEY is not set`.

**Claude: `permission_denials` warning in the log.** The log line reads
`claude was denied N tool call(s)`. Claude tried a tool that
`CLAUDE_DISALLOWED_TOOLS` (or the always-added deny rules) forbids, or one that
`CLAUDE_ALLOWED_TOOLS` does not list. The review still ran; check the named tools
and widen the allow list only if the review needs them.

**Claude: `carbon-mcp` warning at session start.** A log line such as
`carbon-mcp is failed in the claude session` means the Carbon MCP server did not
connect, and Carbon findings fall back to model knowledge. The harness writes the
bearer into `<bundle>/claude-config/claude-mcp.json` from the credentials in
`~/.bob/settings/mcp.json`, the file the MCP refresh timer maintains. With no
bearer there, the log says `No Carbon MCP credentials found`. Sign in with IBMid
from the console, or call `POST /api/mcp/refresh`, as for Bob.

**Claude: `carbon-builder skill was not discovered` warning.** The session's
skill list lacks `carbon-builder`, so Carbon findings will not be verified by the
skill. The `skills: N` count in the session line includes the CLI's own bundled
skills (19 in a live run), so only a missing `carbon-builder` warns. Check that
the bundle holds `.claude/skills/carbon-builder/SKILL.md`, which is copied from
`.bob/skills/carbon-builder` in the repository.

**Claude: review stopped by a limit.** A run that ends with `error_max_budget_usd`
or `error_max_turns` fails as a cost or turn limit, records its spend in the
ledger, and emits `agent_limit_reached`. Raise `CLAUDE_MAX_BUDGET_USD` or
`CLAUDE_MAX_TURNS`, or set them to `0` to remove the cap.

**Claude on an arm64 Mac, in the amd64 image.** `claude --version` aborts under
qemu, so the agent tile and `/api/ready` fail when you run the amd64 container
locally. Amd64 Code Engine is not affected. Run `npm start` on the host, or build
an arm64 image, to test locally.

**Keep artifacts for debugging.** Run `GITHUB_AI_AGENT_KEEP_ARTIFACTS=true npm start`.
The bundle path is printed; it holds `agent-output.txt` (the agent's full response), `agent-events.ndjson`
(its raw event stream) and `agent-stderr.txt`. The bundle also holds the
agent's credential file (`.env` for Bob, `claude-config/claude-mcp.json` for
Claude, both mode 0600), so delete it when you are done.

## Development

### Adding review rubric checks

The review prompt in [`src/reviewPrompt.js`](src/reviewPrompt.js) (`buildReviewPrompt`) contains the full numbered rubric the agent follows. Adding a new check means appending a numbered rule to the prompt — no other files need to change.

### Changing the comment format

Summary comment rendering is in [`formatSummaryComment`](src/reviewPrompt.js), the clean-PR comment in [`formatLooksGoodComment`](src/reviewPrompt.js) and inline comment rendering in [`formatInlineComment`](src/reviewPrompt.js).

### Adjusting finding filters

`reviewParser.js` contains `filterUnverifiedCarbonFindings` and `computeRecommendation`. The recommendation logic is in `computeRecommendation`.

---

## Build with us

- **Issues:** report bugs and propose features in [GitHub issues](https://github.com/carbon-design-system/Carbon-Monitor/issues).
- **Pull requests:** welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first.
- **Security:** report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md).
- **License:** Apache-2.0. See [LICENSE](LICENSE).
