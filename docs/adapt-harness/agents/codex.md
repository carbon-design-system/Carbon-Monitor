# Worker agent: OpenAI Codex CLI

**Status: not exercised here.** There is no Codex adapter. Add one by following
"Add an agent" in `docs/HARNESS.md` section 4: one file in `src/agents/` and a
few lines around it. This file holds what to verify first and what each adapter
member would hold. Treat everything as a starting point: confirm each item
against the current Codex CLI documentation, then record the confirmed values in
SPEC section 5 and the tasks in section 12. `claude-code.md` shows a finished
adapter to copy from.

## Verify first

- [ ] Package name and a version to pin: `@openai/codex`
- [ ] `codex exec` flags: `--full-auto` or `--sandbox` plus `--ask-for-approval never`, `-C <dir>`, `--json`, `--output-last-message <file>`
- [ ] Config file location and the remote MCP server shape in `~/.codex/config.toml`
- [ ] Whether the CLI reads a skills folder, and the instruction file name (`AGENTS.md`)
- [ ] Where it keeps per-user state, and whether an environment variable moves it

## 1. Dockerfile

Add a block beside the Bob and Claude Code blocks. Both stay unless the SPEC
removes them; the image ships every CLI and `GITHUB_AI_AGENT_CLI` selects one.

```dockerfile
# Codex CLI, pinned. Move the pin deliberately.
ARG CODEX_VERSION=x.y.z
RUN npm install -g --registry=https://registry.npmjs.org/ --no-audit --no-fund \
      @openai/codex@${CODEX_VERSION} \
  && codex --version
```

Seed the config so the first run never prompts:

```dockerfile
RUN mkdir -p /home/app/.codex \
  && printf '%s\n' 'approval_policy = "never"' 'sandbox_mode = "workspace-write"' \
     > /home/app/.codex/config.toml \
  && chown -R app:app /home/app
```

If the binary cannot run under qemu, check the installed version and the
binary's architecture instead of running it, as the Claude block does.

## 2. The adapter, `src/agents/codex.js`

| Member                                    | Starting point                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `displayName`, `cliName`, `binary`  | `codex`, `Codex`, `Codex CLI`, `codex`                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `requiredEnv`                             | `OPENAI_API_KEY`. The registry then makes it a startup warning and a red agent tile when unset                                                                                                                                                                                                                                                                                                                                                                |
| `buildArgs({ prompt, caps, bundleDir })`  | `['exec', '--full-auto', '-C', bundleDir, '--output-last-message', bundleDir + '/agent-result.md', prompt]`. Headless: no approvals, a workspace-write sandbox, and the final message in a file                                                                                                                                                                                                                                                               |
| `streams()`, `parseEvent`                 | Without `--json`, `streams()` returns `false` and the runner takes stdout as the review text. With `--json`, return `true` and map each event onto the normalised types in HARNESS.md section 4 (`text`, `tool_use`, `tool_result`, `result` with `stats`)                                                                                                                                                                                                    |
| `env(base, { bundleDir })`                | Pass `OPENAI_API_KEY` and what the CLI needs; build it as an allowlist like `claude.js` so the harness's secrets stay out                                                                                                                                                                                                                                                                                                                                     |
| `isolated`, `seedHome(bundleDir, creds)`  | `false` until a per-review home exists, which keeps the effective `REVIEW_CONCURRENCY` at 1 and logs one line saying so. Codex keeps per-user state under the real home directory. Raising it takes a per-review directory seeded as `claude.js` does, and `isolated: true`                                                                                                                                                                                   |
| `prepareBundle`                           | See section 6                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `promptFragments`                         | Four strings in Codex's own words: no completion tool call, no file writes, the skill path, the read tool name                                                                                                                                                                                                                                                                                                                                                |
| `evidence(toolCalls)`, `skill`            | What a skill read and a Carbon MCP call look like in Codex's events, if it has either                                                                                                                                                                                                                                                                                                                                                                         |
| `costUnit`, `creditLabel`, `resultSource` | `usd`, a label and a `codex-result` source, if the stream reports a cost. If it reports only tokens, leave the cost unknown. The unit and label the adapter reports. Today the `usd` unit, the `spend` tile and the monthly budget variables are Claude's, so a second dollar-billed agent needs its own budget variables and a unit or agent filter (HARNESS.md section 4, "Console and alerts"). A run with no `stats.session_costs` is recorded as unknown |
| `credits()`                               | `{ available: false, low: false, reason: 'not-metered' }` until you build a budget gate of its own. `claude.js` computes its month-to-date figure through `src/api/spend.js`, which filters by unit or source, not by agent                                                                                                                                                                                                                                   |

## 3. Health and readiness

Nothing to write. `healthChecks.checkAgent` runs `<binary> --version` and checks
`requiredEnv`, using the adapter's `cliName` as the tile label, and readiness
probes the same binary.

## 4. deploy_ce.sh and .env.example

- The `SECRET_KEYS` default in `deploy_ce.sh`: add `OPENAI_API_KEY`. (A `SECRET_KEYS` in `.env` replaces the whole list, so it must repeat every key.) Remove `BOB_API_KEY`, `BOB_TEAM_ID` and `BOB_INSTANCE_ID` only if the SPEC drops Bob.
- `deploy_ce.sh`: add a `die` guard for `OPENAI_API_KEY` when `GITHUB_AI_AGENT_CLI` is `codex`, as the Claude one does, and an `--env` line for each setting the adapter reads.
- `.env.example`: add a block with `OPENAI_API_KEY=` and a one-line comment, plus any `CODEX_*` settings, with their defaults in `src/constants.js`.

## 5. MCP configuration

The adapter writes the server entry from `mcpConnection.getCredentials()`, the
way `claude.js` does for its file. For Codex the entry belongs in
`config.toml`, in a per-review directory if one exists, or merged into
`~/.codex/config.toml` otherwise:

```toml
[mcp_servers.carbon-mcp]
url = "https://mcp.carbondesignsystem.com/mcp"
http_headers = { "Authorization" = "Bearer <token>", "X-MCP-Session" = "<session id>" }
```

Confirm the header key name for remote servers in the current config reference;
it has changed between releases.

## 6. Workspace instructions and skills

In `prepareBundle`, write the rules as `<bundleDir>/AGENTS.md` and, if the CLI
reads a skills folder, copy the skill there with `copySkill`; otherwise inline
the skill's instructions into `AGENTS.md`.

## 7. Cost

No balance API. With `--json`, the event stream ends with token usage; map it to
`stats` in `parseEvent` so the ledger and the comment carry exact tokens, and
record spend only if a cost is reported. Leave the agent not metered, or build a
budget gate with its own variables; Claude's are not shared (HARNESS.md section
4, "Console and alerts").

## 8. Verify in the built image

```bash
npm run build:client && podman build --platform linux/amd64 -t harness-test .
podman run --rm --entrypoint codex harness-test --version
podman run --rm -e OPENAI_API_KEY --entrypoint codex harness-test exec --full-auto "Reply with the single word OK"
```

## Console icon

The spend panel shows the worker agent's mark, and today its `usd` branch is
hard-coded to Claude's. `client/src/components/BobcoinsPanel.jsx` imports the
marks for Bob and Claude. For Codex, import `../assets/agents/openai.svg` and add a
branch keyed on the agent id, with alt text naming Codex. Add an entry for the
agent's unit to `LOW_CREDIT_ACTION` in `src/slackNotifier.js`, and the agent's
name to `HelpGuide.jsx` and `AboutAi.jsx`. Marks for every mapped agent are in
`client/src/assets/agents/`; each stays subject to its owner's brand guidelines.
