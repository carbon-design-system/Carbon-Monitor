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

| Variable                               | Required | Default                | Description                                                                                                                                                                 |
| -------------------------------------- | -------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_AI_AGENT_TOKEN`                | Yes      | —                      | GitHub PAT. Needs Pull requests + Issues write and Contents read, **and Triage on the repo** — see [GitHub access](GITHUB_ACCESS.md)                                        |
| `BOB_API_KEY`                          | Yes      | —                      | Bob Shell API key. Create with Scope **Inference** in the Bob web portal — browser SSO cannot complete in a container                                                       |
| `BOB_TEAM_ID`                          | No       | —                      | Only for a `general`-type Bob key; sending it with an Inference key breaks the run                                                                                          |
| `GITHUB_AI_AGENT_OWNER`                | No       | `carbon-design-system` | Repository owner                                                                                                                                                            |
| `GITHUB_AI_AGENT_REPO`                 | No       | `carbon`               | Repository name                                                                                                                                                             |
| `GITHUB_AI_AGENT_CLI`                  | No       | `bob`                  | Worker agent. `bob` is the tested path; Claude Code, Codex, Gemini CLI and Copilot CLI are mapped in `docs/adapt-harness/agents/`                                           |
| `GITHUB_AI_AGENT_PR_NUMBER`            | No       | —                      | Review a specific PR by number; bypasses auto-selection. Can also be set via `--pr <number>` CLI flag. `DAYS_BACK` and `MAX_PRS` filters do not apply.                      |
| `GITHUB_AI_AGENT_MAX_PRS`              | No       | `10`                   | Max PRs reviewed per run                                                                                                                                                    |
| `GITHUB_AI_AGENT_DAYS_BACK`            | No       | `21`                   | How far back to look for PRs (days)                                                                                                                                         |
| `GITHUB_AI_AGENT_MAX_INPUT_TOKENS`     | No       | `140000`               | Total input token budget. Three slices at the default: 12,000 prompt overhead + 5,000 issue context + 123,000 diff = 140,000 tokens. Effective diff budget = 492,000 chars. |
| `GITHUB_AI_AGENT_REVIEW_LABEL`         | No       | `AIReviewed`           | Label added after review                                                                                                                                                    |
| `GITHUB_AI_AGENT_POST_INLINE_COMMENTS` | No       | `true`                 | Post inline diff comments                                                                                                                                                   |
| `GITHUB_AI_AGENT_POST_SUMMARY_COMMENT` | No       | `true`                 | Post summary issue comment                                                                                                                                                  |
| `GITHUB_AI_AGENT_KEEP_ARTIFACTS`       | No       | `false`                | Keep temp bundle directory for debugging                                                                                                                                    |

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

If `.bob/skills/carbon-builder` doesn't exist yet, install it by following the [Carbon Builder skill setup guide](https://carbondesignsystem.com/developing/carbon-mcp/onboarding-and-setup/#step-4:-adding-the-carbon-builder-skill). If it's already there, you're good to go.
