# Worker agent: GitHub Copilot CLI

**Status: not exercised here, and this CLI changes often.** There is no Copilot
adapter. Add one by following "Add an agent" in `docs/HARNESS.md` section 4: one
file in `src/agents/` and a few lines around it. This file holds what to verify
first and what each adapter member would hold. Confirm every item against the
current Copilot CLI documentation before writing the SPEC, and record the
confirmed values in section 5. `claude-code.md` shows a finished adapter to copy
from.

## Verify first

- [ ] Package name and a version to pin: `@github/copilot`
- [ ] Headless flags: `-p`, `--allow-all-tools`, any output-format flag
- [ ] Which token variable it reads and what Copilot entitlement the account needs
- [ ] MCP config location (`~/.copilot/mcp-config.json`) and the HTTP server shape
- [ ] Instruction file name (`AGENTS.md`) and whether a skills folder is read
- [ ] Where it keeps per-user state, and whether an environment variable moves it

## 1. Dockerfile

Add a block beside the Bob and Claude Code blocks. Both stay unless the SPEC
removes them; the image ships every CLI and `GITHUB_AI_AGENT_CLI` selects one.

```dockerfile
# Copilot CLI, pinned. Move the pin deliberately.
ARG COPILOT_CLI_VERSION=x.y.z
RUN npm install -g --registry=https://registry.npmjs.org/ --no-audit --no-fund \
      @github/copilot@${COPILOT_CLI_VERSION} \
  && copilot --version
```

If the binary cannot run under qemu, check the installed version and the
binary's architecture instead of running it, as the Claude block does.

## 2. The adapter, `src/agents/copilot.js`

| Member                                    | Starting point                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `displayName`, `cliName`, `binary`  | `copilot`, `Copilot`, `Copilot CLI`, `copilot`                                                                                                                                                                                                                                                                      |
| `requiredEnv`                             | The token variable you confirmed. The registry then makes it a startup warning and a red agent tile when unset                                                                                                                                                                                                      |
| `buildArgs({ prompt, caps, bundleDir })`  | `['-p', prompt, '--allow-all-tools']`. Headless: one prompt, all tools pre-approved                                                                                                                                                                                                                                 |
| `streams()`, `parseEvent`                 | Without a structured output flag, return `false`: the runner takes stdout as the review text. Otherwise return `true` and map its events onto the normalised types in HARNESS.md section 4                                                                                                                          |
| `env(base, { bundleDir })`                | Pass the token variable and what the CLI needs; build it as an allowlist like `claude.js` so the harness's secrets stay out                                                                                                                                                                                         |
| `isolated`, `seedHome(bundleDir, creds)`  | `false` until a per-review config directory exists, which keeps the effective `REVIEW_CONCURRENCY` at 1 and logs one line saying so                                                                                                                                                                                 |
| `prepareBundle`                           | See section 6                                                                                                                                                                                                                                                                                                       |
| `promptFragments`                         | Four strings in Copilot's own words: no completion tool call, no file writes, the skill path, the read tool name                                                                                                                                                                                                    |
| `evidence(toolCalls)`, `skill`            | What a skill read and a Carbon MCP call look like in Copilot's output, if it has either                                                                                                                                                                                                                             |
| `costUnit`, `creditLabel`, `resultSource` | Usage is premium requests on the GitHub side with no per-run API, so there is no dollar figure. Pick a unit and label for what you count (see section 7); a run with no cost is recorded as unknown. The Slack remedy and the spend panel need an entry for a new unit (HARNESS.md section 4, "Console and alerts") |
| `credits()`                               | `{ available: false, low: false, reason: 'not-metered' }`, or a count against a budget you set, with variables of its own                                                                                                                                                                                           |

## 3. Health and readiness

Nothing to write. `healthChecks.checkAgent` runs `<binary> --version` and checks
`requiredEnv`, using the adapter's `cliName` as the tile label, and readiness
probes the same binary.

## 4. deploy_ce.sh and .env.example

- The `SECRET_KEYS` default in `deploy_ce.sh`: add the confirmed token variable. (A `SECRET_KEYS` in `.env` replaces the whole list, so it must repeat every key.) Remove `BOB_API_KEY`, `BOB_TEAM_ID` and `BOB_INSTANCE_ID` only if the SPEC drops Bob. If it is the same GitHub account that writes results, it may already be `GITHUB_AI_AGENT_TOKEN`.
- `deploy_ce.sh`: add a `die` guard for the token variable when `GITHUB_AI_AGENT_CLI` is `copilot`, as the Claude one does, and an `--env` line for each setting the adapter reads.
- `.env.example`: add a block with the confirmed token variable and a one-line comment, plus `COPILOT_MONTHLY_RUN_BUDGET=` if section 7 counts runs, with defaults in `src/constants.js`.

## 5. MCP configuration

The adapter writes the server entry from `mcpConnection.getCredentials()`, the
way `claude.js` does for its file. For Copilot the entry is in
`~/.copilot/mcp-config.json`, or in a per-review directory if one exists:

```json
{
  "mcpServers": {
    "carbon-mcp": {
      "type": "http",
      "url": "https://mcp.carbondesignsystem.com/mcp",
      "headers": {
        "Authorization": "Bearer <token>",
        "X-MCP-Session": "<session id>"
      }
    }
  }
}
```

## 6. Workspace instructions and skills

In `prepareBundle`, write the rules as `<bundleDir>/AGENTS.md` and, if the CLI
reads a skills folder, copy the skill there with `copySkill`; otherwise inline
the skill's instructions into `AGENTS.md`.

## 7. Cost

Usage is metered as premium requests on the GitHub side with no per-run API.
Either leave the agent not metered, or count runs against a budget you set in
`.env` with variables of its own. `credits()` would read the count from the
ledger or Elasticsearch; `src/api/spend.js` does that for Claude's dollars and
filters by unit or source, not by agent.

## 8. Verify in the built image

```bash
npm run build:client && podman build --platform linux/amd64 -t harness-test .
podman run --rm --entrypoint copilot harness-test --version
```

## Console icon

The spend panel shows the worker agent's mark, and today its `usd` branch is
hard-coded to Claude's. `client/src/components/BobcoinsPanel.jsx` imports the
marks for Bob and Claude. For Copilot, import `../assets/agents/copilot.svg` and add a
branch keyed on the agent id, with alt text naming Copilot. Add an entry for the
agent's unit to `LOW_CREDIT_ACTION` in `src/slackNotifier.js`, and the agent's
name to `HelpGuide.jsx` and `AboutAi.jsx`. Marks for every mapped agent are in
`client/src/assets/agents/`; each stays subject to its owner's brand guidelines.
