# Configuration

Environment variables and the Bob Shell, Carbon MCP and Carbon Builder setup a review needs. The GitHub token's permissions are in [GITHUB_ACCESS.md](GITHUB_ACCESS.md).

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
GITHUB_AI_AGENT_MAX_PRS=10
GITHUB_AI_AGENT_DAYS_BACK=21
GITHUB_AI_AGENT_MAX_INPUT_TOKENS=140000
GITHUB_AI_AGENT_REVIEW_LABEL=AIReviewed
GITHUB_AI_AGENT_POST_INLINE_COMMENTS=true
GITHUB_AI_AGENT_POST_SUMMARY_COMMENT=true
GITHUB_AI_AGENT_KEEP_ARTIFACTS=false
```

Full variable reference:

| Variable                               | Required  | Default                   | Description                                                                                                                                                                                                                                                         |
| -------------------------------------- | --------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_AI_AGENT_TOKEN`                | Yes       | —                         | GitHub PAT. Needs Pull requests + Issues write and Contents read, **and Triage on the repo** — see [GitHub access](GITHUB_ACCESS.md)                                                                                                                                |
| `BOB_API_KEY`                          | Yes       | —                         | Bob Shell API key. Create with Scope **Inference** in the Bob web portal — browser SSO cannot complete in a container                                                                                                                                               |
| `BOB_TEAM_ID`                          | No        | —                         | Only for a `general`-type Bob key; sending it with an Inference key breaks the run                                                                                                                                                                                  |
| `BOB_OUTPUT_FORMAT`                    | No        | `stream-json`             | `stream-json` gives exact cost, token counts and tool calls from Bob's result record. `pretty` restores the legacy text path as a kill switch (cost falls back to the balance delta, tokens to the estimate)                                                        |
| `BOB_MAX_COST`                         | No        | —                         | Per-review spend cap in Bobcoins. Blank or `0` omits the flag. A run that hits it fails with an `agent_limit_reached` event                                                                                                                                         |
| `BOB_MAX_TURNS`                        | No        | —                         | Per-review turn cap. Blank or `0` leaves Bob's default (100)                                                                                                                                                                                                        |
| `BOB_DISABLE_TOOL_GROUPS`              | No        | —                         | Comma-separated Bob tool groups the reviewer may not use. `edit,execute,subagent,mode` makes it read-only                                                                                                                                                           |
| `GITHUB_AI_AGENT_OWNER`                | No        | `carbon-design-system`    | Repository owner                                                                                                                                                                                                                                                    |
| `GITHUB_AI_AGENT_REPO`                 | No        | `carbon`                  | Repository name                                                                                                                                                                                                                                                     |
| `GITHUB_AI_AGENT_CLI`                  | No        | `bob`                     | Worker agent. `bob` is the tested path; Claude Code, Codex, Gemini CLI and Copilot CLI are mapped in `docs/adapt-harness/agents/`                                                                                                                                   |
| `GITHUB_AI_AGENT_PR_NUMBER`            | No        | —                         | Review a specific PR by number; bypasses auto-selection. Can also be set via `--pr <number>` CLI flag. `DAYS_BACK` and `MAX_PRS` filters do not apply.                                                                                                              |
| `GITHUB_AI_AGENT_MAX_PRS`              | No        | `10`                      | Max PRs reviewed per run                                                                                                                                                                                                                                            |
| `GITHUB_AI_AGENT_DAYS_BACK`            | No        | `21`                      | How far back to look for PRs (days)                                                                                                                                                                                                                                 |
| `GITHUB_AI_AGENT_MAX_INPUT_TOKENS`     | No        | `140000`                  | Total input token budget. Three slices at the default: 12,000 prompt overhead + 5,000 issue context + 123,000 diff = 140,000 tokens. Effective diff budget = 492,000 chars.                                                                                         |
| `GITHUB_AI_AGENT_REVIEW_LABEL`         | No        | `AIReviewed`              | Label added after review                                                                                                                                                                                                                                            |
| `GITHUB_AI_AGENT_POST_INLINE_COMMENTS` | No        | `true`                    | Post inline diff comments                                                                                                                                                                                                                                           |
| `GITHUB_AI_AGENT_POST_SUMMARY_COMMENT` | No        | `true`                    | Post summary issue comment                                                                                                                                                                                                                                          |
| `GITHUB_AI_AGENT_KEEP_ARTIFACTS`       | No        | `false`                   | Keep temp bundle directory for debugging                                                                                                                                                                                                                            |
| `AUTH_REQUIRED`                        | No        | `true` when deployed      | Require sign-in for the console and API. `deploy_ce.sh` defaults it to `true`; a local run without it is open. Common spellings of true/false are accepted and anything else is reported at startup and treated as off                                              |
| `API_SECRET`                           | With auth | —                         | Bearer token for CI and curl (`Authorization: Bearer <API_SECRET>`). Also the fallback session signing key. `API_ENABLE_AUTH=false` turns the bearer path off                                                                                                       |
| `CORS_ORIGIN`                          | No        | `*`                       | Value of `Access-Control-Allow-Origin`. Only matters for local development against a separate Vite dev server; the console is served same-origin                                                                                                                    |
| `SESSION_SIGNING_KEY`                  | No        | `API_SECRET`, else random | HMAC key for session cookies. Without a stable key every restart signs all operators out                                                                                                                                                                            |
| `SLACK_WEBHOOK_URL`                    | No        | —                         | Slack incoming webhook for the run digest. Blank disables Slack with no error                                                                                                                                                                                       |
| `REVIEW_CONCURRENCY`                   | No        | `2`                       | Number of reviews in flight inside one batch; `1` restores sequential reviews. Each Bob process wants 4 GB, so 2 pairs with `MEMORY=8G`; at the default 1 vCPU / 4 GB a large PR may OOM one review. Only Bob runs concurrently; any other agent runs one at a time |

The input budget derives from Bob's 200,000-token window: 200,000, less 40,000
reserved for MCP tool calls and 20,000 for agent output, gives the 140,000
default. Within it, prompt overhead is 12,000 tokens (the review prompt measured
about 41,000 characters, roughly 10,300 tokens, plus a variability buffer), issue
context is 5,000 (real linked issues run near 470), and the diff gets the
remaining 123,000 at 4 characters per token. The issue slice is reserved even
when no issue is linked. Re-measure the prompt overhead if the prompt grows.

`CARBON_MONITOR_SKIP_DOTENV=1` makes `src/loadEnv.js` skip `.env`. It matters for child
processes that run `src/index.js` or `src/api/server.js` as the main module, because
`loadEnv` only runs when `require.main === module`; an in-process `require` never loads
`.env`. The unit tests set it on the children they spawn, so a developer's `.env` cannot
override the environment a test builds. Leave it unset otherwise; `.env` is loaded with
`override: true`.

### 2. Bob Shell

Install Bob Shell with the official script (IBM network or VPN), then trust
the directories it needs for MCP tool access:

```bash
curl -fsSL https://bob.ibm.com/download/bobshell.sh | bash
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

At startup the API server (and the CLI, `npm start`) logs one `[config]` line per missing required variable: `GITHUB_AI_AGENT_TOKEN` always; `BOB_API_KEY` when the agent is `bob`; and, for the server with `AUTH_REQUIRED=true`, `CONSOLE_USERNAME`, `CONSOLE_PASSWORD` and (unless `API_ENABLE_AUTH=false`) `API_SECRET`. Nothing exits; the same problems appear under `warnings` in `GET /api/ready`.
