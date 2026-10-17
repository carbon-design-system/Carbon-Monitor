# Worker agent: Claude Code

**Status: not exercised here.** `src/agentRunner.js` has a `claude` case that
was never run in production, and it uses `--dangerously-skip-permissions` with
`stream-json` output, which the snippets below replace. Treat everything as a
starting point: confirm each item against the current Claude Code documentation,
then record the confirmed values in SPEC section 5 and the tasks in section 12.

## Verify first

- [ ] Package name and a version to pin: `@anthropic-ai/claude-code`
- [ ] Headless flags: `-p`, `--output-format json`, `--permission-mode`, `--allowedTools`, `--max-turns`, `--mcp-config`
- [ ] The JSON result's fields, especially `result` and `total_cost_usd`
- [ ] MCP server shape for a streamable-HTTP server with headers
- [ ] Where project skills load from (`.claude/skills/`) and the instruction file name (`CLAUDE.md`)

## 1. Dockerfile

Delete the three `ARG BOB_*` lines and the whole `---- Bob Shell ----` `RUN`
block. In the `mkdir -p /home/app/.bob ...` block, delete the three `printf`
lines and the `cp -R ... carbon-builder` line, keeping `/workspace` creation and
the `chown`. Insert in place of the Bob block:

```dockerfile
# Claude Code, pinned. Move the pin deliberately.
ARG CLAUDE_CODE_VERSION=x.y.z
RUN npm install -g --registry=https://registry.npmjs.org/ --no-audit --no-fund \
      @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
  && claude --version
```

Keep the Debian base, Node 22, the `curl ca-certificates git` install, the
non-root `app` user and `/workspace`. If the job uses a skill, keep the skill
copy but target `.claude/skills/` (section 6).

## 2. src/agentRunner.js

`'claude'` is already in `validAgents`. Replace the `case 'claude'` block:

```js
case 'claude':
  // Headless: one prompt, JSON result, bounded turns, no interactive permission
  // prompts. The MCP file is written by mcpConnection into the workspace.
  command = 'claude';
  args = [
    '-p', prompt,
    '--output-format', 'json',
    '--permission-mode', 'acceptEdits',
    '--max-turns', String(process.env.CLAUDE_MAX_TURNS || 40),
    '--mcp-config', `${cwd}/.claude/mcp.json`,
  ];
  break;
```

Delete the `env.CLAUDE_MCP_CONFIG = ...` line near the top of `runAgent`; the
flag above replaces it. Where `runAgent` resolves, parse `stdout` as JSON and
return `parsed.result` as the agent text, keeping `parsed.total_cost_usd` for
the ledger (section 7).

## 3. src/api/healthChecks.js

Replace `checkBob` with a `checkClaude` of the same shape:

```js
async function checkClaude() {
  const timeoutMs = Number(process.env.AGENT_CHECK_TIMEOUT_MS || 20_000);
  const { code, stdout, stderr, failure } = await run(
    'claude',
    ['--version'],
    timeoutMs
  );
  if (failure === 'timeout')
    return {
      id: 'agent',
      label: 'Claude Code',
      status: WARNING,
      detail: `Did not respond within ${Math.round(timeoutMs / 1000)}s`,
      hint: null,
    };
  if (code !== 0)
    return {
      id: 'agent',
      label: 'Claude Code',
      status: FAILED,
      detail: failure === 'missing' ? 'Not found on PATH' : 'Failed to run',
      hint: stderr.trim() || 'The image did not install Claude Code.',
    };
  const version = stdout.trim().split('\n')[0] || 'unknown';
  if (!process.env.ANTHROPIC_API_KEY)
    return {
      id: 'agent',
      label: 'Claude Code',
      status: FAILED,
      detail: `v${version} — not authenticated`,
      hint: 'ANTHROPIC_API_KEY is not set.',
    };
  return {
    id: 'agent',
    label: 'Claude Code',
    status: OK,
    detail: `v${version} — API key configured`,
    hint: null,
  };
}
```

Update the `Promise.all` list and the console tile that renders `id: 'bob'`.

## 4. deploy_ce.sh and .env.example

- `SECRET_KEYS` in `.env`: add `ANTHROPIC_API_KEY`; remove `BOB_API_KEY`, `BOB_TEAM_ID`, `BOB_INSTANCE_ID`.
- The preflight `verify_bob_source` function and its call go.
- `--env GITHUB_AI_AGENT_CLI=bob` becomes `claude` (or the renamed variable from SPEC section 6).
- `.env.example`: the `BOB_GATEWAY_BASE_URL`, `BOB_CREDITS_*` and
  `BOB_CHECK_TIMEOUT_MS` entries go with the Bobcoins tile (section 7).
- `.env.example`: replace the Bob block with
  ```
  # Claude Code authenticates with an Anthropic API key.
  ANTHROPIC_API_KEY=
  # Turn cap per run; the run fails rather than loops when it is hit.
  # CLAUDE_MAX_TURNS=40
  # Monthly budget in US dollars for the spend ratio and the auto-pause (section 7).
  AGENT_MONTHLY_BUDGET_USD=
  # Health-check budget for `claude --version`; replaces BOB_CHECK_TIMEOUT_MS.
  # AGENT_CHECK_TIMEOUT_MS=20000
  ```

## 5. MCP configuration

`mcpConnection.js` currently writes `~/.bob/settings/mcp.json`. Write this file
into each workspace instead, at `<cwd>/.claude/mcp.json`, from the same token
state:

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

The OAuth bootstrap and refresh timer in `mcpConnection.js` stay as they are;
only the writer's target changes. Bob's `ALWAYS_ALLOW` list in the same module
has no place in this file: pass the same four tool names to the runner with
`--allowedTools`, in the name form the Claude Code documentation gives for MCP
tools (see "Verify first").

## 6. Workspace instructions and skills

In `src/reviewBundle.js`, write the rules file as `<cwd>/CLAUDE.md` instead of
`.bob/rules/01-output.md`, and copy any skill to `<cwd>/.claude/skills/<name>/`.

## 7. Cost

There is no balance API. Read `total_cost_usd` from each run's JSON result and
record it through `creditLedger.record`. Replace the Bobcoins balance tile with
spend to date against a `AGENT_MONTHLY_BUDGET_USD` you set in `.env`, and point
the scheduler's auto-pause at that ratio instead of the gateway balance.

## 8. Verify in the built image

```bash
npm run build:client && podman build --platform linux/amd64 -t harness-test .
podman run --rm --entrypoint claude harness-test --version
podman run --rm -e ANTHROPIC_API_KEY --entrypoint claude harness-test -p "Reply with the single word OK" --output-format json
```

The second command must print a JSON object whose `result` is `OK`.

## Console icon

The Bobcoins panel shows the worker agent's mark: `import bobMark from '../assets/bob.svg'` in `client/src/components/BobcoinsPanel.jsx`, rendered with alt text naming Bob. Swap the import to `../assets/agents/claude.svg` and update the alt text. Marks for every mapped agent are in `client/src/assets/agents/`; each stays subject to its owner's brand guidelines.
