# Carbon Monitor — Quick Start

Get Carbon Monitor running in 5 minutes.

## Prerequisites

- Node.js >= 18.0.0
- GitHub personal access token (repo + write:discussion scopes)
- Bob Shell CLI (IBM network or VPN required)
- Access to the Carbon MCP streamable-HTTP endpoint

## Step 1: Install Dependencies

```bash
cd Carbon-Monitor
npm install
```

## Step 2: Configure Environment

```bash
cp .env.example .env
```

Required variables:

```bash
GITHUB_AI_AGENT_TOKEN=ghp_your_github_token_here
GITHUB_AI_AGENT_CLI=bob
BOBSHELL_API_KEY=your_bob_api_key_here
```

## Step 3: Install Bob Shell

```bash
npm install -g bobshell
bob --version
```

Trust the directories Bob needs for MCP tool access:

```bash
bob trust /private/tmp
bob trust /path/to/Carbon-Monitor
```

## Step 4: Configure Carbon MCP

Carbon Monitor uses Carbon MCP over streamable HTTP. Create `~/.bob/settings/mcp.json`:

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

## Step 5: Test the Setup

```bash
npm test
```

## Step 6: Run

```bash
npm start
```

Carbon Monitor will:
1. Fetch open PRs without the `AIReviewed` label
2. For each PR, build a temporary review workspace and run Bob
3. Post inline comments on specific diff lines and a summary comment on the PR
4. Add the `AIReviewed` label
5. Clean up the temporary workspace

---

## Docker Deployment

```bash
# Build and run
docker-compose up -d

# View logs
docker-compose logs -f

# Stop
docker-compose down
```

Or without Compose:

```bash
docker build -t carbon-monitor .
docker run -d --name carbon-monitor --env-file .env carbon-monitor
docker logs -f carbon-monitor
```

---

## Troubleshooting

### "Bob not found in PATH"
```bash
npm install -g bobshell
which bob
```

### "Carbon MCP not connected"
Open Bob shell and run `/mcp list`. If carbon-mcp is not showing as Ready, check `~/.bob/settings/mcp.json` and confirm your IBM JWT token and session ID are current. See `docs/TOKEN_REFRESH.md` for the full refresh process.

### "Bob Shell Cloudflare blocking"
Bob requires IBM office network or VPN. Connect to IBM VPN and retry.

### "No PRs to review"
All open PRs already have the `AIReviewed` label, or no PRs were opened within the `DAYS_BACK` window (default: 21 days). This is expected behaviour.

### Keep artifacts for debugging
```bash
GITHUB_AI_AGENT_KEEP_ARTIFACTS=true npm start
```
The bundle directory is printed to the console and contains `agent-output.txt` and `agent-stderr.txt`.

---

## Configuration Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GITHUB_AI_AGENT_TOKEN` | ✅ | — | GitHub personal access token |
| `BOBSHELL_API_KEY` | ✅ | — | Bob Shell API key |
| `GITHUB_AI_AGENT_OWNER` | ❌ | `carbon-design-system` | Repository owner |
| `GITHUB_AI_AGENT_REPO` | ❌ | `carbon` | Repository name |
| `GITHUB_AI_AGENT_CLI` | ❌ | `bob` | Agent to use — only `bob` is supported |
| `GITHUB_AI_AGENT_MAX_PRS` | ❌ | `5` | Max PRs reviewed per run |
| `GITHUB_AI_AGENT_DAYS_BACK` | ❌ | `21` | How far back to look for PRs (days) |
| `GITHUB_AI_AGENT_MAX_INPUT_TOKENS` | ❌ | `140000` | Total input token budget (prompt + diff). Effective diff budget = (value − 12,000 prompt overhead) × 4 chars/token ≈ 512k chars at the default. |
| `GITHUB_AI_AGENT_REVIEW_LABEL` | ❌ | `AIReviewed` | Label added after review |
| `GITHUB_AI_AGENT_POST_INLINE_COMMENTS` | ❌ | `true` | Post inline diff comments |
| `GITHUB_AI_AGENT_POST_SUMMARY_COMMENT` | ❌ | `true` | Post summary issue comment |
| `GITHUB_AI_AGENT_KEEP_ARTIFACTS` | ❌ | `false` | Keep temp bundle for debugging |
| `API_PORT` | ❌ | `3000` | API server port (`npm run api` only) |
| `API_SECRET` | ❌ | — | API server bearer token |
| `API_ENABLE_AUTH` | ❌ | `true` | Enable API server authentication |

---

## Scheduling (Cron)

```bash
crontab -e

# Run daily at 03:00
0 3 * * * cd /path/to/Carbon-Monitor && npm start >> /var/log/carbon-monitor.log 2>&1
```

---

## Full Documentation

See [`README.md`](README.md) for the complete architecture reference, output format details, and development guide.
