# Worker agent: GitHub Copilot CLI

**Status: not exercised here, and this CLI changes often.** There is no
`copilot` case in `src/agentRunner.js`; adding it is part of the SPEC. Confirm
every item against the current Copilot CLI documentation before writing the
SPEC, and record the confirmed values in section 5.

## Verify first

- [ ] Package name and a version to pin: `@github/copilot`
- [ ] Headless flags: `-p`, `--allow-all-tools`, any output-format flag
- [ ] Which token variable it reads and what Copilot entitlement the account needs
- [ ] MCP config location (`~/.copilot/mcp-config.json`) and the HTTP server shape
- [ ] Instruction file name (`AGENTS.md`) and whether a skills folder is read

## 1. Dockerfile

Delete the three `ARG BOB_*` lines and the whole `---- Bob Shell ----` `RUN`
block. In the `mkdir -p /home/app/.bob ...` block, delete the three `printf`
lines and the `cp -R ... carbon-builder` line. Insert in place of the Bob block:

```dockerfile
# Copilot CLI, pinned. Move the pin deliberately.
ARG COPILOT_CLI_VERSION=x.y.z
RUN npm install -g --registry=https://registry.npmjs.org/ --no-audit --no-fund \
      @github/copilot@${COPILOT_CLI_VERSION} \
  && copilot --version
```

## 2. src/agentRunner.js

Add `'copilot'` to `validAgents` and a new case:

```js
case 'copilot':
  // Headless: one prompt, all tools pre-approved.
  command = 'copilot';
  args = ['-p', prompt, '--allow-all-tools'];
  break;
```

Return `stdout` as the agent text unless the CLI offers a structured output flag.

## 3. src/api/healthChecks.js

Replace `checkBob` with `checkCopilot`: run `copilot --version`, then require
the token variable you confirmed. Use the `checkClaude` shape in
`claude-code.md` with the label `Copilot CLI` and `id: 'agent'`.

## 4. deploy_ce.sh and .env.example

- `SECRET_KEYS` in `.env`: add the confirmed token variable; remove `BOB_API_KEY`, `BOB_TEAM_ID`, `BOB_INSTANCE_ID`. If it is the same GitHub account that writes results, it may already be `GITHUB_AI_AGENT_TOKEN`.
- The preflight `verify_bob_source` function and its call go.
- `--env GITHUB_AI_AGENT_CLI=bob` becomes `copilot` (or the renamed variable from SPEC section 6).
- `.env.example`: replace the Bob block with the confirmed token variable and a one-line comment, and add `AGENT_MONTHLY_RUN_BUDGET=` if section 7 counts runs. Drop the `BOB_GATEWAY_BASE_URL`, `BOB_CREDITS_*` and `BOB_CHECK_TIMEOUT_MS` entries with the Bobcoins tile.

## 5. MCP configuration

`mcpConnection.js` writes the server entry into `~/.copilot/mcp-config.json`:

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

In `src/reviewBundle.js`, write the rules as `<cwd>/AGENTS.md` instead of
`.bob/rules/01-output.md`. If the CLI reads a skills folder, copy the skill
there; otherwise inline the skill's instructions into `AGENTS.md`.

## 7. Cost

Usage is metered as premium requests on the GitHub side with no per-run API.
Remove the Bobcoins tile and the balance-based auto-pause, or count runs against
a `AGENT_MONTHLY_RUN_BUDGET` you set in `.env`.

## 8. Verify in the built image

```bash
npm run build:client && podman build --platform linux/amd64 -t harness-test .
podman run --rm --entrypoint copilot harness-test --version
```

## Console icon

The Bobcoins panel shows the worker agent's mark: `import bobMark from '../assets/bob.svg'` in `client/src/components/BobcoinsPanel.jsx`, rendered with alt text naming Bob. Swap the import to `../assets/agents/copilot.svg` and update the alt text. Marks for every mapped agent are in `client/src/assets/agents/`; each stays subject to its owner's brand guidelines.
