# Configuration

Environment variables and the Bob Shell, Claude Code, Carbon MCP and Carbon Builder setup a review needs. The GitHub token's permissions are in [GITHUB_ACCESS.md](GITHUB_ACCESS.md).

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
# Instead of BOB_API_KEY, when GITHUB_AI_AGENT_CLI=claude
# ANTHROPIC_API_KEY=your_anthropic_api_key_here

# Defaults shown — override as needed
GITHUB_AI_AGENT_OWNER=carbon-design-system
GITHUB_AI_AGENT_REPO=carbon
GITHUB_AI_AGENT_CLI=bob
GITHUB_AI_AGENT_MAX_PRS=10
GITHUB_AI_AGENT_DAYS_BACK=21
GITHUB_AI_AGENT_MAX_INPUT_TOKENS=140000
GITHUB_AI_AGENT_REVIEW_LABEL=AIReviewed
GITHUB_AI_AGENT_POST_INLINE_COMMENTS=true
GITHUB_AI_AGENT_POST_SUMMARY_COMMENT=true
GITHUB_AI_AGENT_KEEP_ARTIFACTS=false
```

Full variable reference:

| Variable                               | Required      | Default                   | Description                                                                                                                                                                                                                                                                                                          |
| -------------------------------------- | ------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_AI_AGENT_TOKEN`                | Yes           | —                         | GitHub PAT. Needs Pull requests + Issues write and Contents read, **and Triage on the repo** — see [GitHub access](GITHUB_ACCESS.md)                                                                                                                                                                                 |
| `BOB_API_KEY`                          | With `bob`    | —                         | Bob Shell API key. Create with Scope **Inference** in the Bob web portal — browser SSO cannot complete in a container                                                                                                                                                                                                |
| `BOB_TEAM_ID`                          | No            | —                         | Only for a `general`-type Bob key; sending it with an Inference key breaks the run                                                                                                                                                                                                                                   |
| `BOB_OUTPUT_FORMAT`                    | No            | `stream-json`             | `stream-json` gives exact cost, token counts and tool calls from Bob's result record. `pretty` restores the legacy text path as a kill switch (cost falls back to the balance delta, tokens to the estimate)                                                                                                         |
| `BOB_MAX_COST`                         | No            | —                         | Per-review spend cap in Bobcoins. Blank or `0` omits the flag. A run that hits it fails with an `agent_limit_reached` event                                                                                                                                                                                          |
| `BOB_MAX_TURNS`                        | No            | —                         | Per-review turn cap. Blank or `0` leaves Bob's default (100)                                                                                                                                                                                                                                                         |
| `BOB_DISABLE_TOOL_GROUPS`              | No            | —                         | Comma-separated Bob tool groups the reviewer may not use. `edit,execute,subagent,mode` makes it read-only                                                                                                                                                                                                            |
| `ANTHROPIC_API_KEY`                    | With `claude` | —                         | API key from the Claude Console, for the Claude Code CLI. Leave blank when the agent is `bob`. `deploy_ce.sh` stores it in the Code Engine secret                                                                                                                                                                    |
| `CLAUDE_MODEL`                         | No            | `claude-sonnet-5-5`       | Claude model                                                                                                                                                                                                                                                                                                         |
| `CLAUDE_EFFORT`                        | No            | `high`                    | Claude reasoning effort                                                                                                                                                                                                                                                                                              |
| `CLAUDE_MAX_BUDGET_USD`                | No            | `5`                       | Per-review spend cap in USD, passed as `--max-budget-usd`. `0` omits the flag. Spend can pass the cap slightly. A run that hits it fails with an `agent_limit_reached` event                                                                                                                                         |
| `CLAUDE_MAX_TURNS`                     | No            | `60`                      | Per-review turn cap, passed as `--max-turns`. `0` omits the flag                                                                                                                                                                                                                                                     |
| `CLAUDE_ALLOWED_TOOLS`                 | No            | read-only set             | Tools Claude may use, as a comma-separated list of Claude Code permission rules. Default: `Read(./**),Glob,Grep,Skill(carbon-builder),mcp__carbon-mcp`                                                                                                                                                               |
| `CLAUDE_DISALLOWED_TOOLS`              | No            | edit and shell set        | Tools Claude may not use. Default: `Bash,Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch,Agent`. Three more rules are always added, see [Claude Code](#claude-code)                                                                                                                                             |
| `CLAUDE_MONTHLY_BUDGET_USD`            | No            | unset                     | Monthly budget in USD for scheduled reviews. Blank or `0` means not metered. See [the budget gate](#the-monthly-budget-gate)                                                                                                                                                                                         |
| `CLAUDE_BUDGET_LOW_PCT`                | No            | `10`                      | Scheduled reviews pause below this percentage of the monthly budget                                                                                                                                                                                                                                                  |
| `GITHUB_AI_AGENT_OWNER`                | No            | `carbon-design-system`    | Repository owner                                                                                                                                                                                                                                                                                                     |
| `GITHUB_AI_AGENT_REPO`                 | No            | `carbon`                  | Repository name                                                                                                                                                                                                                                                                                                      |
| `GITHUB_AI_AGENT_CLI`                  | No            | `bob`                     | Worker agent: `bob` (IBM Bob through the Bob Shell CLI) or `claude` (Claude through the Claude Code CLI). Another CLI needs an adapter, see [HARNESS.md](HARNESS.md#add-an-agent)                                                                                                                                    |
| `GITHUB_AI_AGENT_PR_NUMBER`            | No            | —                         | Review a specific PR by number; bypasses auto-selection. Can also be set via `--pr <number>` CLI flag. `DAYS_BACK` and `MAX_PRS` filters do not apply.                                                                                                                                                               |
| `GITHUB_AI_AGENT_MAX_PRS`              | No            | `10`                      | Max PRs reviewed per run                                                                                                                                                                                                                                                                                             |
| `GITHUB_AI_AGENT_DAYS_BACK`            | No            | `21`                      | How far back to look for PRs (days)                                                                                                                                                                                                                                                                                  |
| `GITHUB_AI_AGENT_MAX_INPUT_TOKENS`     | No            | `140000`                  | Total input token budget. Three slices at the default: 12,000 prompt overhead + 5,000 issue context + 123,000 diff = 140,000 tokens. Effective diff budget = 492,000 chars.                                                                                                                                          |
| `GITHUB_AI_AGENT_REVIEW_LABEL`         | No            | `AIReviewed`              | Label added after review                                                                                                                                                                                                                                                                                             |
| `GITHUB_AI_AGENT_POST_INLINE_COMMENTS` | No            | `true`                    | Post inline diff comments                                                                                                                                                                                                                                                                                            |
| `GITHUB_AI_AGENT_POST_SUMMARY_COMMENT` | No            | `true`                    | Post summary issue comment                                                                                                                                                                                                                                                                                           |
| `GITHUB_AI_AGENT_KEEP_ARTIFACTS`       | No            | `false`                   | Keep temp bundle directory for debugging                                                                                                                                                                                                                                                                             |
| `AUTH_REQUIRED`                        | No            | `true` when deployed      | Require sign-in for the console and API. `deploy_ce.sh` defaults it to `true`; a local run without it is open. Common spellings of true/false are accepted and anything else is reported at startup and treated as off                                                                                               |
| `API_SECRET`                           | With auth     | —                         | Bearer token for CI and curl (`Authorization: Bearer <API_SECRET>`). Also the fallback session signing key. `API_ENABLE_AUTH=false` turns the bearer path off                                                                                                                                                        |
| `CORS_ORIGIN`                          | No            | `*`                       | Value of `Access-Control-Allow-Origin`. Only matters for local development against a separate Vite dev server; the console is served same-origin                                                                                                                                                                     |
| `SESSION_SIGNING_KEY`                  | No            | `API_SECRET`, else random | HMAC key for session cookies. Without a stable key every restart signs all operators out                                                                                                                                                                                                                             |
| `SLACK_WEBHOOK_URL`                    | No            | —                         | Slack incoming webhook for the run digest. Blank disables Slack with no error                                                                                                                                                                                                                                        |
| `REVIEW_CONCURRENCY`                   | No            | `2`                       | Number of reviews in flight inside one batch; `1` restores sequential reviews. Each agent process is budgeted 4 GB (Bob's documented need), so 2 pairs with `MEMORY=8G`; at the default 1 vCPU / 4 GB a large PR may OOM one review. Applies to `bob` and `claude`; each review has its own HOME or config directory |

The input budget derives from Bob's 200,000-token window: 200,000, less 40,000
reserved for MCP tool calls and 20,000 for agent output, gives the 140,000
default. Within it, prompt overhead is 12,000 tokens (the review prompt measured
about 41,000 characters, roughly 10,300 tokens, plus a variability buffer), issue
context is 5,000 (real linked issues run near 470), and the diff gets the
remaining 123,000 at 4 characters per token. The issue slice is reserved even
when no issue is linked. Re-measure the prompt overhead if the prompt grows. The
same budget applies whichever agent runs.

`CARBON_MONITOR_SKIP_DOTENV=1` makes `src/loadEnv.js` skip `.env`. It matters for child
processes that run `src/index.js` or `src/api/server.js` as the main module, because
`loadEnv` only runs when `require.main === module`; an in-process `require` never loads
`.env`. The unit tests set it on the children they spawn, so a developer's `.env` cannot
override the environment a test builds. Leave it unset otherwise; `.env` is loaded with
`override: true`.

### 2. Agent CLIs

One CLI reviews; `GITHUB_AI_AGENT_CLI` picks it. The container image holds both.
The Carbon MCP and Carbon Builder steps below apply to either.

#### Bob Shell

Install Bob Shell with the official script (IBM network or VPN), then trust
the directories it needs for MCP tool access:

```bash
curl -fsSL https://bob.ibm.com/download/bobshell.sh | bash
bob --version

bob trust /private/tmp
bob trust /path/to/Carbon-Monitor
```

#### Claude Code

Install Claude Code 2.1.259 or later (the image pins 2.1.302; the adapter always sends `--permission-prompts none`, which older releases lack), with Node 22 or later, and put an API key from the Claude Console in
`.env`. Non-interactive runs use that key; a subscription login is not used.

```bash
npm install -g @anthropic-ai/claude-code
claude --version

GITHUB_AI_AGENT_CLI=claude
ANTHROPIC_API_KEY=your_anthropic_api_key_here
```

The image pins version 2.1.302 and sets `DISABLE_AUTOUPDATER=1`, so a running
container never changes version. `BOB_CHECK_TIMEOUT_MS` is the time limit for
`--version` in the agent tile for either CLI.

**What Claude is allowed to do.** It runs in print mode with
`--permission-mode dontAsk`, so it never prompts: anything not allowed is
refused. The review is read-only. `CLAUDE_ALLOWED_TOOLS` lists what is allowed
(file reads inside the bundle, `Glob`, `Grep`, the Carbon Builder skill and the
Carbon MCP tools) and `CLAUDE_DISALLOWED_TOOLS` what is not (shell, edits,
writes, web access, subagents). Whatever those two variables hold, the harness
adds three deny rules after them:

| Always denied              | Why                                              |
| -------------------------- | ------------------------------------------------ |
| `Read(./claude-config/**)` | The MCP bearer in the bundle's `claude-mcp.json` |
| `Read(~/**)`               | The same bearer in `~/.bob/settings/mcp.json`    |
| `Read(//proc/**)`          | The process environment                          |

The bundle's `.claude/settings.json` also sets
`permissions.blockReadsOutsideWorkingDirectories`, so file tools refuse paths
outside the bundle. A run that attempted a refused tool ends with
`permission_denials` in its result record, and the log shows
`claude was denied N tool call(s)` with the tool names.

**What Claude can see of the environment.** The child process gets an allowlist,
not the harness's environment: `PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_ALL`, `TERM`,
`USER`, `LOGNAME`, `SHELL`, the proxy and CA variables (`HTTP_PROXY`,
`HTTPS_PROXY`, `NO_PROXY`, `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, upper and lower
case), and anything starting `ANTHROPIC_` or `CLAUDE_`. The harness then sets
`CLAUDE_CONFIG_DIR=<bundle>/claude-config` and `DISABLE_AUTOUPDATER=1`. The
GitHub token, the Elasticsearch, Slack and console secrets never reach it. Bob
still receives the harness's full environment, as before.

**What a Claude bundle holds.** Besides `PR_REVIEW_REQUEST.md`, `pr.json`,
`files.json` and `diff.patch`:

```
CLAUDE.md                         the output rules (Bob gets the same text in .bob/rules/01-output.md)
.claude/settings.json             blockReadsOutsideWorkingDirectories
.claude/skills/carbon-builder/    the Carbon Builder skill
claude-config/claude-mcp.json     carbon-mcp URL and headers, mode 0600
```

The CLI creates its own `.claude.json`, `policy-limits.json`, `projects/` and `sessions/` in `claude-config/` on first run; nothing is seeded.

There is no `.env` in a Claude bundle. `claude-mcp.json` is built from
`mcpConnection.getCredentials()`, which reads the `carbon-mcp` entry of
`~/.bob/settings/mcp.json`, the file the refresh timer keeps current (see
[Carbon MCP](#3-carbon-mcp-streamable-http)). It is passed with `--mcp-config` and
`--strict-mcp-config`, so Claude uses no other MCP server. With no bearer there,
the file lists no servers and the log says
`No Carbon MCP credentials found; the Claude review runs without Carbon MCP`.

##### The monthly budget gate

Claude has no balance API, so `CLAUDE_MONTHLY_BUDGET_USD` is how the scheduled
gate gets one. Unset (or `0`), Claude is not metered: the console panel reads "Not
metered" and no scheduled run is paused or skipped for cost. When set:

- Month-to-date spend comes from Elasticsearch: the sum of the `coinsSpent`
  payload over `pr_review_completed` and `agent_limit_reached` events for the
  agent since the first of the month (UTC). A run stopped at its cost cap spent
  money but never completed, which is why the second event type counts.
- The local credit ledger is the fallback when Elasticsearch is not configured
  or answers nothing. When both answer, the larger figure is used, because a
  gate should over-estimate rather than under.
- The scheduler pauses the schedule before a batch when the remainder is below
  `CLAUDE_BUDGET_LOW_PCT` percent, and posts the Slack alert. Each review in a
  scheduled batch checks again before it starts. A manual or `--pr` run skips
  the check.
- Reviews in flight are not counted. Spend can therefore pass the budget by up
  to `REVIEW_CONCURRENCY` x `CLAUDE_MAX_BUDGET_USD`. A run that failed without
  reaching a limit stop is in the ledger only, and the ledger is on the
  container's disk, so a restart forgets it.

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

> **Note:** IBM JWT tokens expire. The API server renews them automatically after one **Sign in with IBMid** from the console; see [ARCHITECTURE.md §4](ARCHITECTURE.md#4-keeping-the-carbon-mcp-connection-alive).

### 4. Carbon Builder skill

If `.bob/skills/carbon-builder` doesn't exist yet, install it by following the [Carbon Builder skill setup guide](https://carbondesignsystem.com/developing/carbon-mcp/onboarding-and-setup/#step-4:-adding-the-carbon-builder-skill). If it's already there, you're good to go. `npm ci` (or `npm install`) runs `scripts/install-carbon-builder-skill.js`, which prints one line saying whether it installed the skill or why it skipped, and never fails the install.

The container image refreshes the skill from `carbon-mcp` at build time and falls back to the copy vendored in this repo when the fetch fails; `skill-source.txt` in the skill directory records which one won. These build args control the refresh:

| Build arg             | Default                           | Effect                                                                                                                                                           |
| --------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CARBON_SKILL_REPO`   | `carbon-design-system/carbon-mcp` | Repository the skill is fetched from                                                                                                                             |
| `CARBON_SKILL_REF`    | `main`                            | Branch, tag or 40-hex commit SHA. A SHA is fetched as that commit; anything else is tried as a tag, then as a branch                                             |
| `CARBON_SKILL_PATH`   | `public/skills/carbon-builder`    | Skill directory inside the repository                                                                                                                            |
| `CARBON_SKILL_SHA256` | empty                             | SHA-256 of the downloaded tarball, verified with `sha256sum -c`. GitHub does not guarantee byte-stable tarballs for branches and tags, so pair it with a SHA ref |
| `CARBON_SKILL_STRICT` | `false`                           | `true` fails the build on a failed fetch or a checksum mismatch instead of falling back to the vendored copy                                                     |

```bash
podman build --platform linux/amd64 \
  --build-arg CARBON_SKILL_REF=<40-hex-sha> \
  --build-arg CARBON_SKILL_SHA256=<tarball-sha256> \
  --build-arg CARBON_SKILL_STRICT=true -t carbon-monitor .
```

### 5. Sign-in throttle and proxies

`TRUSTED_PROXY_HOPS` (default `1`) is how many proxies sit between the client and the app. The sign-in throttle keys on the `X-Forwarded-For` entry that many from the end, on the first entry when the header is shorter than that, and on the socket address only when the header is absent. Verify the value on the deployed instance: the first failed sign-in after startup logs how many entries the header had and which one was used.

### 6. Startup configuration check

At startup the API server (and the CLI, `npm start`) logs one `[config]` line per missing required variable: `GITHUB_AI_AGENT_TOKEN` always; the agent's key (`BOB_API_KEY` when the agent is `bob`, `ANTHROPIC_API_KEY` when it is `claude`); and, for the server with `AUTH_REQUIRED=true`, `CONSOLE_USERNAME`, `CONSOLE_PASSWORD` and (unless `API_ENABLE_AUTH=false`) `API_SECRET`. Nothing exits; the same problems appear under `warnings` in `GET /api/ready`.
