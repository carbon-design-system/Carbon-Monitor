# Carbon Monitor

Automated PR review agent for the `carbon-design-system/carbon` monorepo. Carbon Monitor fetches open, unreviewed pull requests, runs them through Bob (IBM's AI CLI agent), and posts structured review comments directly on the PR — including inline comments on specific diff lines and a summary comment with a final recommendation.

Carbon-specific claims (component props, tokens, icons, accessibility patterns) are verified at review time using the Carbon MCP server before they appear in any posted finding.

---

## How It Works

1. **Fetch** — Queries GitHub for open PRs and excludes: drafts, PRs older than 21 days (configurable), PRs already labelled `AIReviewed`, and bot-authored PRs (Dependabot, Renovate, etc.). Up to 5 PRs are reviewed per run (configurable).

2. **Bundle** — For each PR, builds a temporary workspace under `/private/tmp` containing:
   - `PR_REVIEW_REQUEST.md` — PR description, changed files list, and full unified diff in one file
   - `pr.json` / `files.json` / `diff.patch` — raw metadata
   - `.bob/rules/01-output.md` — agent behavioural rules injected into Bob's context
   - `.bob/skills/carbon-builder/` — Carbon Builder skill copied from the local workspace so Bob can load it inside the bundle directory

   **Linked issue context:** If the PR body contains a `Closes #N`, `Fixes #N`, or `Resolves #N` reference, Carbon Monitor fetches that issue (and its parent issue, if one exists) and includes it in the bundle as a `## Linked Issue Context` section.

   The agent prompt instructs Bob to read this section before cataloguing the diff. It is treated as the acceptance criteria and intent for the change, giving the agent the *why* behind the PR and not just the *what* — so it can distinguish an intentional API removal from an accidental one, verify the implementation matches the stated requirements, and avoid flagging changes the issue explicitly calls for.

   The issue content is capped at 5,000 tokens and truncated with a notice if it exceeds that. If no linked issue is found or fetching fails, the section is silently omitted and the review continues from the diff alone.

3. **Review** — Runs Bob in advanced mode (`bob -p <prompt> --yolo --chat-mode advanced --allowed-mcp-server-names carbon-mcp`) against the bundle directory. Bob works through a structured protocol:
   - **Step 1** — Reads `PR_REVIEW_REQUEST.md` and writes a visible catalogue of every suspicious item per file, classified as Category 1 (Carbon API — requires MCP) or Category 2 (generic — diff-visible).
   - **Step 2** — Resolves every pending catalogue item. Category 1 items are verified using the Carbon Builder skill and Carbon MCP tools (`code_search`, `docs_search`, `get_charts`). Category 2 items are resolved from the diff alone.
   - **Step 3** — Compiles the confirmed findings list with severity (`blocking`, `major`, `minor`, `nit`).
   - **Step 4** — Outputs a structured JSON block between `BEGIN_REVIEW_JSON` / `END_REVIEW_JSON` markers.

4. **Parse** — `reviewParser.js` extracts the JSON, validates it, detects truncation or collapsed-thinking runs, and computes a recommendation (`consider-revising`, `suggested-improvements`, or `looks-good`) from the finding severities.

5. **Post** — Findings that map to a line in the diff are posted as inline GitHub review comments. Remaining findings and the overall summary are posted as a PR issue comment. The `AIReviewed` label is added to the PR.

6. **Cleanup** — The temporary bundle directory is deleted (or kept if `GITHUB_AI_AGENT_KEEP_ARTIFACTS=true`).

---

## Architecture

```
Carbon-Monitor/
├── src/
│   ├── index.js           # Orchestrator — fetches PRs, coordinates all steps
│   ├── githubClient.js    # GitHub API wrapper (fetch PRs/diffs/files, post comments, add labels)
│   ├── reviewBundle.js    # Builds the temp workspace Bob runs inside
│   ├── agentRunner.js     # Spawns the Bob process, captures output
│   ├── reviewParser.js    # Parses Bob's JSON output, filters findings, computes recommendation
│   ├── reviewPrompt.js    # Builds the review prompt; formats summary and inline comments
│   ├── diffMapper.js      # Maps finding file+line to a GitHub diff position for inline comments
│   └── api/
│       ├── server.js      # REST API server (in development — see API Server section)
│       └── tokenManager.js # Carbon MCP token refresh logic
├── tests/
│   ├── test-agent.js
│   ├── test-parser.js
│   ├── test-diff-mapper.js
│   └── test-truncation-edge-cases.js
├── docs/
│   ├── AGENTIC_CARBON_PR_REVIEW_PORT_SPEC.md
│   ├── CARBON_PORT_COMPARISON.md
│   └── TOKEN_USAGE_TRACKING.md
├── .env.example
├── QUICKSTART.md
└── package.json
```

---

## Prerequisites

1. **Node.js** >= 18.0.0
2. **GitHub token** with `repo` and `write:discussion` scopes
3. **Bob Shell CLI** installed and on `PATH`
4. **Carbon MCP** configured globally in Bob as a streamable-HTTP connection (see setup below)

---

## Installation

```bash
git clone https://github.com/carbon-design-system/Carbon-Monitor.git
cd Carbon-Monitor
npm install
```

---

## Configuration

### 1. Environment variables

```bash
cp .env.example .env
```

Edit `.env`:

```bash
# Required
GITHUB_AI_AGENT_TOKEN=ghp_your_github_token_here
BOBSHELL_API_KEY=your_bob_api_key_here

# Defaults shown — override as needed
GITHUB_AI_AGENT_OWNER=carbon-design-system
GITHUB_AI_AGENT_REPO=carbon
GITHUB_AI_AGENT_CLI=bob
GITHUB_AI_AGENT_MAX_PRS=5
GITHUB_AI_AGENT_DAYS_BACK=21
GITHUB_AI_AGENT_MAX_INPUT_TOKENS=140000
GITHUB_AI_AGENT_REVIEW_LABEL=AIReviewed
GITHUB_AI_AGENT_POST_INLINE_COMMENTS=true
GITHUB_AI_AGENT_POST_SUMMARY_COMMENT=true
GITHUB_AI_AGENT_KEEP_ARTIFACTS=false
```

Full variable reference:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GITHUB_AI_AGENT_TOKEN` | ✅ | — | GitHub personal access token |
| `BOBSHELL_API_KEY` | ✅ | — | Bob Shell API key |
| `GITHUB_AI_AGENT_OWNER` | ❌ | `carbon-design-system` | Repository owner |
| `GITHUB_AI_AGENT_REPO` | ❌ | `carbon` | Repository name |
| `GITHUB_AI_AGENT_CLI` | ❌ | `bob` | Agent to use — only `bob` is supported |
| `GITHUB_AI_AGENT_PR_NUMBER` | ❌ | — | Review a specific PR by number; bypasses auto-selection. Can also be set via `--pr <number>` CLI flag. `DAYS_BACK` and `MAX_PRS` filters do not apply. |
| `GITHUB_AI_AGENT_MAX_PRS` | ❌ | `5` | Max PRs reviewed per run |
| `GITHUB_AI_AGENT_DAYS_BACK` | ❌ | `21` | How far back to look for PRs (days) |
| `GITHUB_AI_AGENT_MAX_INPUT_TOKENS` | ❌ | `140000` | Total input token budget. Three slices at the default: 12,000 prompt overhead + 5,000 issue context + 123,000 diff = 140,000 tokens. Effective diff budget = 492,000 chars. |
| `GITHUB_AI_AGENT_REVIEW_LABEL` | ❌ | `AIReviewed` | Label added after review |
| `GITHUB_AI_AGENT_POST_INLINE_COMMENTS` | ❌ | `true` | Post inline diff comments |
| `GITHUB_AI_AGENT_POST_SUMMARY_COMMENT` | ❌ | `true` | Post summary issue comment |
| `GITHUB_AI_AGENT_KEEP_ARTIFACTS` | ❌ | `false` | Keep temp bundle directory for debugging |

### 2. Bob Shell

Install Bob Shell and trust the directories it needs for MCP tool access:

```bash
npm install -g bobshell
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

> **Note:** IBM JWT tokens expire. The API server (see below) is being built to automate token refresh so the MCP connection stays valid when running in the cloud.

### 4. Carbon Builder skill

If `.bob/skills/carbon-builder` doesn't exist yet, install it by following the [Carbon Builder skill setup guide](https://carbondesignsystem.com/developing/carbon-mcp/onboarding-and-setup/#step-4:-adding-the-carbon-builder-skill). If it's already there, you're good to go.

---

## Running

### One-off review run

```bash
npm start
# or
node src/index.js
```

### Review a specific PR

```bash
# Primary form
node src/index.js --pr 12345

# Via npm start (note the -- separator — required by npm)
npm start -- --pr 12345

# Via env var
GITHUB_AI_AGENT_PR_NUMBER=12345 npm start
```

> `DAYS_BACK` and `MAX_PRS` filters are not applied when a specific PR is targeted. The PR is reviewed regardless of age, label, or draft status.

### Tests

```bash
npm test                # agent integration test
npm run test:parser     # reviewParser unit tests
npm run test:diff       # diffMapper unit tests
npm run test:all        # parser + diffMapper
```

### API server (in development)

```bash
npm run api
```

Starts a lightweight HTTP server on port 3000 (configurable via `API_PORT`). Intended for cloud deployments where the process runs continuously and needs a way to receive token refreshes without a restart.

Endpoints (all except `/api/health` require `Authorization: Bearer <API_SECRET>`):

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Health check — no auth required |
| `GET` | `/api/config` | Current configuration (sanitised) |
| `GET` | `/api/mcp/status` | Carbon MCP connection status |
| `POST` | `/api/mcp/refresh` | Push a new IBM JWT token into Bob's MCP config |
| `POST` | `/api/review/trigger` | Manually trigger a review run |

Configure the API server in `.env`:

```bash
API_PORT=3000
API_SECRET=your_secure_api_secret_here
API_ENABLE_AUTH=true
```

---

## Output Format

Each reviewed PR receives two types of comments:

### Inline comments (on specific diff lines)

```
**Missing aria-label on time picker select**

> [blocking] Should be resolved before this ships.

<cds-time-picker-select> added in this diff has no aria-label attribute.
Interactive select elements inside a composite component must have an
accessible label. Add aria-label="Time zone" (or equivalent) to the element.

*✓ Verified with Carbon Builder + MCP*
```

### Summary comment (PR issue comment)

```
[AI agent review — Carbon grounded] · **Consider Revising**

Reviewed by: bob · Commit: a1b2c3d
Carbon verification: Carbon-specific claims require Carbon Builder and Carbon MCP verification.

## Recommendation

1 blocking finding: "Missing aria-label on time picker select"

There are issues in this PR that should be addressed before merging. ...

## Findings

| Area       | Category | Severity | Finding                                  | File                    |
|------------|----------|----------|------------------------------------------|-------------------------|
| General    | Cat 2    | blocking | Missing aria-label on time picker select | src/components/...      |
| Carbon API | Cat 1    | minor    | menu-alignment on wrong element          | src/components/...      |

## Summary

This PR updates the time picker Figma Code Connect mappings. 1 blocking finding: ...

Review artifacts:
- PR: #12345
- Commit: a1b2c3d
- Agent: bob
- Inline comments: 1
- Summary findings: 1

---
**Estimated Token Usage:**
- Input tokens: ~8,400
- Output tokens: ~2,100
- Total tokens: ~10,500
```

### Recommendation values

| Value | Meaning |
|-------|---------|
| `Consider Revising` | One or more `blocking` findings, or two or more `major` findings |
| `Suggested Improvements` | Any `major` or `minor` finding, or review reliability was uncertain |
| `Looks Good` | `nit`-level findings only, or no findings |

### Finding severities

| Severity | Meaning |
|----------|---------|
| `blocking` | Breaks user-facing behaviour or violates an accessibility requirement |
| `major` | Likely to cause a visible rendering difference or runtime error |
| `minor` | Maintainability risk or subtle behaviour difference — not immediately breaking |
| `nit` | Convention / hygiene — no functional consequence |

---

## Review Reliability

The parser checks for two signals in the agent's output before the JSON block:

- **Catalogue present** — at least one `[file:line] — ... — pending`, `NO-FINDINGS`, or `SKIP` line must appear. If absent, the agent skipped Step 1 and the review is flagged as unreliable (`catalogueWarning` is set in the comment).
- **Step 2 visible** — pending catalogue items must be resolved with `confirmed finding` or `discarded: [reason]` lines in the visible response. If pending items appear but no resolutions do, the run is treated the same as a missing catalogue.

An unreliable run still posts a comment but sets the recommendation to `Suggested Improvements` and includes a prominent warning note.

---

## Deployment

Carbon Monitor is designed to run as a scheduled job in the cloud. The intended setup is:

1. Deploy the Node process to a cloud environment.
2. Run `npm start` on a schedule (cron or a scheduler service) — e.g. daily at 03:00.
3. Use the API server (`npm run api`) alongside it to accept token refresh requests without restarting the process.

The CI/CD safety check in `index.js` skips execution when `TRAVIS_BRANCH` is set to anything other than `main`, preventing accidental reviews from feature branch CI runs.

### Docker

```bash
# Build and run
docker-compose up -d

# Or without Compose
docker build -t carbon-monitor .
docker run -d --name carbon-monitor --env-file .env carbon-monitor

# Logs
docker-compose logs -f
# or
docker logs -f carbon-monitor
```

---

## Troubleshooting

### Bob not found in PATH
```bash
npm install -g bobshell
which bob
```

### Carbon MCP not connected
```bash
bob
```

```
/mcp list
# Should show: carbon-mcp - Ready
# If not ready, check ~/.bob/settings/mcp.json and verify your JWT token is valid
```

### IBM JWT token expired
The Carbon MCP connection uses an IBM JWT that expires periodically. While running on IBM network/VPN:
1. Obtain a fresh token
2. Update `~/.bob/settings/mcp.json` with the new token, or call `POST /api/mcp/refresh` if the API server is running

### Bob requires IBM network
Bob Shell requires IBM office network or VPN access. If you're seeing Cloudflare errors, connect to IBM VPN and retry.

### No PRs to review
This is expected when all open PRs already have the `AIReviewed` label, or no PRs were opened within the `DAYS_BACK` window.

### Keep artifacts for debugging
```bash
GITHUB_AI_AGENT_KEEP_ARTIFACTS=true npm start
```
The bundle directory path is printed to the console. It contains `agent-output.txt` (Bob's full response) and `agent-stderr.txt`.

---

## Development

### Adding review rubric checks

The review prompt in [`src/reviewPrompt.js`](src/reviewPrompt.js) (`buildReviewPrompt`) contains the full 15-check rubric Bob follows. Adding a new check means appending a numbered rule to the prompt — no other files need to change.

### Changing the comment format

Summary comment rendering is in [`formatSummaryComment`](src/reviewPrompt.js) and inline comment rendering in [`formatInlineComment`](src/reviewPrompt.js).

### Adjusting finding filters

`reviewParser.js` contains `filterUnverifiedCarbonFindings` and `computeRecommendation`. The recommendation logic is in `computeRecommendation` starting at line 681.

---

## License

Apache-2.0
