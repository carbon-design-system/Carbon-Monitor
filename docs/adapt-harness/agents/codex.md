# Worker agent: OpenAI Codex CLI

**Status: not exercised here.** `src/agentRunner.js` has a `codex` case that
was never run in production. Treat everything as a starting point: confirm each
item against the current Codex CLI documentation, then record the confirmed
values in SPEC section 5 and the tasks in section 12.

## Verify first

- [ ] Package name and a version to pin: `@openai/codex`
- [ ] `codex exec` flags: `--full-auto` or `--sandbox` plus `--ask-for-approval never`, `-C <dir>`, `--json`, `--output-last-message <file>`
- [ ] Config file location and the remote MCP server shape in `~/.codex/config.toml`
- [ ] Whether the CLI reads a skills folder, and the instruction file name (`AGENTS.md`)

## 1. Dockerfile

Delete the three `ARG BOB_*` lines and the whole `---- Bob Shell ----` `RUN`
block. In the `mkdir -p /home/app/.bob ...` block, delete the three `printf`
lines and the `cp -R ... carbon-builder` line. Insert in place of the Bob block:

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

## 2. src/agentRunner.js

`'codex'` is already in `validAgents`. Replace the `case 'codex'` block:

```js
case 'codex':
  // Headless: no approvals, workspace-write sandbox, final message to a file so
  // the agent text is read without parsing the event stream.
  command = 'codex';
  args = [
    'exec',
    '--full-auto',
    '-C', cwd,
    '--output-last-message', `${cwd}/agent-result.md`,
    prompt,
  ];
  break;
```

Delete the `env.CODEX_MCP_CONFIG = ...` line near the top of `runAgent`; it is
not a Codex variable. Use the object `runAgent` resolves (`text`, `toolCalls`,
`stats`): read `<cwd>/agent-result.md` into `text` and leave `stats` as `null`,
which keeps the character estimate for tokens. Bobcoins tracking is Bob-only,
so the cost for this agent is `null` with source `unknown`.

## 3. src/api/healthChecks.js

Replace `checkBob` with `checkCodex`: run `codex --version`, then require
`OPENAI_API_KEY`. Use the `checkClaude` shape in `claude-code.md` with the
label `Codex CLI` and `id: 'agent'`.

## 4. deploy_ce.sh and .env.example

- `SECRET_KEYS` in `.env`: add `OPENAI_API_KEY`; remove `BOB_API_KEY`, `BOB_TEAM_ID`, `BOB_INSTANCE_ID`.
- The preflight `verify_bob_source` function and its call go.
- `--env GITHUB_AI_AGENT_CLI=bob` becomes `codex` (or the renamed variable from SPEC section 6).
- `.env.example`: replace the Bob block with `OPENAI_API_KEY=` and a one-line comment, and add `AGENT_MONTHLY_BUDGET_USD=` for the budget in section 7. Drop the `BOB_GATEWAY_BASE_URL`, `BOB_CREDITS_*` and `BOB_CHECK_TIMEOUT_MS` entries with the Bobcoins tile.

`REVIEW_CONCURRENCY` stays at 1 for this agent: the harness gives only Bob a
private `HOME` per review, and Codex keeps per-user state under the real home directory. Raising it takes a per-review home like
`seedBobHome`, with the agent's own state seeded into it.

## 5. MCP configuration

`mcpConnection.js` writes the server entry into `~/.codex/config.toml` instead
of `~/.bob/settings/mcp.json`:

```toml
[mcp_servers.carbon-mcp]
url = "https://mcp.carbondesignsystem.com/mcp"
http_headers = { "Authorization" = "Bearer <token>", "X-MCP-Session" = "<session id>" }
```

Confirm the header key name for remote servers in the current config reference;
it has changed between releases.

## 6. Workspace instructions and skills

In `src/reviewBundle.js`, write the rules as `<cwd>/AGENTS.md` instead of
`.bob/rules/01-output.md`. If the CLI reads a skills folder, copy the skill
there; otherwise inline the skill's instructions into `AGENTS.md`.

## 7. Cost

No balance API. With `--json`, the event stream ends with token usage; record
it per run through `creditLedger.record` and show spend against a
`AGENT_MONTHLY_BUDGET_USD` budget instead of the Bobcoins balance.

## 8. Verify in the built image

```bash
npm run build:client && podman build --platform linux/amd64 -t harness-test .
podman run --rm --entrypoint codex harness-test --version
podman run --rm -e OPENAI_API_KEY --entrypoint codex harness-test exec --full-auto "Reply with the single word OK"
```

## Console icon

The Bobcoins panel shows the worker agent's mark: `import bobMark from '../assets/bob.svg'` in `client/src/components/BobcoinsPanel.jsx`, rendered with alt text naming Bob. Swap the import to `../assets/agents/openai.svg` and update the alt text. Marks for every mapped agent are in `client/src/assets/agents/`; each stays subject to its owner's brand guidelines.
