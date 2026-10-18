# Worker agent: Gemini CLI

**Status: not exercised here.** There is no Gemini adapter. Add one by following
"Add an agent" in `docs/HARNESS.md` section 4: one file in `src/agents/` and a
few lines around it. This file holds what to verify first and what each adapter
member would hold. Confirm each item against the current Gemini CLI
documentation, then record the confirmed values in SPEC section 5 and the tasks
in section 12. `claude-code.md` shows a finished adapter to copy from.

## Verify first

- [ ] Package name and a version to pin: `@google/gemini-cli`
- [ ] Headless flags: `-p`, `--yolo`, `--output-format json`
- [ ] Settings file location and the streamable-HTTP MCP shape (`httpUrl`, `headers`)
- [ ] Instruction file name (`GEMINI.md`) and whether a skills folder is read
- [ ] Where it keeps per-user state, and whether an environment variable moves it

## 1. Dockerfile

Add a block beside the Bob and Claude Code blocks. Both stay unless the SPEC
removes them; the image ships every CLI and `GITHUB_AI_AGENT_CLI` selects one.

```dockerfile
# Gemini CLI, pinned. Move the pin deliberately.
ARG GEMINI_CLI_VERSION=x.y.z
RUN npm install -g --registry=https://registry.npmjs.org/ --no-audit --no-fund \
      @google/gemini-cli@${GEMINI_CLI_VERSION} \
  && gemini --version
```

If the binary cannot run under qemu, check the installed version and the
binary's architecture instead of running it, as the Claude block does.

## 2. The adapter, `src/agents/gemini.js`

| Member                                    | Starting point                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`, `displayName`, `cliName`, `binary`  | `gemini`, `Gemini`, `Gemini CLI`, `gemini`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `requiredEnv`                             | `GEMINI_API_KEY`. The registry then makes it a startup warning and a red agent tile when unset                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `buildArgs({ prompt, caps, bundleDir })`  | `['-p', prompt, '--yolo', '--output-format', 'json']`. Headless: one prompt, auto-approved tools, a JSON result                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `streams()`, `parseEvent`                 | A single JSON result rather than a stream: return `false` and take the response text from stdout, or, if the CLI offers a streaming JSON format, return `true` and map its events onto the normalised types in HARNESS.md section 4                                                                                                                                                                                                                                                                                                              |
| `env(base, { bundleDir })`                | Pass `GEMINI_API_KEY` and what the CLI needs; build it as an allowlist like `claude.js` so the harness's secrets stay out                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `isolated`, `seedHome(bundleDir, creds)`  | `false` until a per-review settings directory exists, which keeps the effective `REVIEW_CONCURRENCY` at 1 and logs one line saying so. Gemini CLI keeps per-user state under the real home directory                                                                                                                                                                                                                                                                                                                                             |
| `prepareBundle`                           | See section 6                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `promptFragments`                         | Four strings in Gemini's own words: no completion tool call, no file writes, the skill path, the read tool name                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `evidence(toolCalls)`, `skill`            | What a skill read and a Carbon MCP call look like in Gemini's output, if it has either                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `costUnit`, `creditLabel`, `resultSource` | `usd`, a label and a `gemini-result` source, if the result reports a cost. Token statistics map into `stats` and are labelled with the agent id; a run with no `stats` keeps the character estimate for tokens. The unit and label the adapter reports. Today the `usd` unit, the `spend` tile and the monthly budget variables are Claude's, so a second dollar-billed agent needs its own budget variables and a unit or agent filter (HARNESS.md section 4, "Console and alerts"). A run with no `stats.session_costs` is recorded as unknown |
| `credits()`                               | `{ available: false, low: false, reason: 'not-metered' }` until you build a budget gate of its own. `claude.js` computes its month-to-date figure through `src/api/spend.js`, which filters by unit or source, not by agent                                                                                                                                                                                                                                                                                                                      |

## 3. Health and readiness

Nothing to write. `healthChecks.checkAgent` runs `<binary> --version` and checks
`requiredEnv`, using the adapter's `cliName` as the tile label, and readiness
probes the same binary.

## 4. deploy_ce.sh and .env.example

- The `SECRET_KEYS` default in `deploy_ce.sh`: add `GEMINI_API_KEY`. (A `SECRET_KEYS` in `.env` replaces the whole list, so it must repeat every key.) Remove `BOB_API_KEY`, `BOB_TEAM_ID` and `BOB_INSTANCE_ID` only if the SPEC drops Bob.
- `deploy_ce.sh`: add a `die` guard for `GEMINI_API_KEY` when `GITHUB_AI_AGENT_CLI` is `gemini`, as the Claude one does, and an `--env` line for each setting the adapter reads.
- `.env.example`: add a block with `GEMINI_API_KEY=` and a one-line comment, plus any `GEMINI_*` settings, with their defaults in `src/constants.js`.

## 5. MCP configuration

The adapter writes the server entry from `mcpConnection.getCredentials()`, the
way `claude.js` does for its file. For Gemini the entry is in
`~/.gemini/settings.json`, or in a per-review settings directory if one exists:

```json
{
  "mcpServers": {
    "carbon-mcp": {
      "httpUrl": "https://mcp.carbondesignsystem.com/mcp",
      "headers": {
        "Authorization": "Bearer <token>",
        "X-MCP-Session": "<session id>"
      }
    }
  }
}
```

Merge into an existing file rather than overwriting it; the CLI keeps other
settings there.

## 6. Workspace instructions and skills

In `prepareBundle`, write the rules as `<bundleDir>/GEMINI.md` and, if the CLI
reads a skills folder, copy the skill there with `copySkill`; otherwise inline
the skill's instructions into `GEMINI.md`.

## 7. Cost

No balance API. Map the token statistics from the JSON result into `stats` in
`parseEvent` so the ledger and the comment carry them, and record spend only if a
cost is reported. Leave the agent not metered, or build a budget gate with its
own variables; Claude's are not shared (HARNESS.md section 4, "Console and
alerts").

## 8. Verify in the built image

```bash
npm run build:client && podman build --platform linux/amd64 -t harness-test .
podman run --rm --entrypoint gemini harness-test --version
podman run --rm -e GEMINI_API_KEY --entrypoint gemini harness-test -p "Reply with the single word OK" --output-format json
```

## Console icon

The spend panel shows the worker agent's mark, and today its `usd` branch is
hard-coded to Claude's. `client/src/components/BobcoinsPanel.jsx` imports the
marks for Bob and Claude. For Gemini, import `../assets/agents/gemini.svg` and add a
branch keyed on the agent id, with alt text naming Gemini. Add an entry for the
agent's unit to `LOW_CREDIT_ACTION` in `src/slackNotifier.js`, and the agent's
name to `HelpGuide.jsx` and `AboutAi.jsx`. Marks for every mapped agent are in
`client/src/assets/agents/`; each stays subject to its owner's brand guidelines.
