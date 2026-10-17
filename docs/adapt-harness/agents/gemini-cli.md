# Worker agent: Gemini CLI

**Status: not exercised here.** There is no `gemini` case in
`src/agentRunner.js`; adding it is part of the SPEC. Confirm each item against
the current Gemini CLI documentation, then record the confirmed values in SPEC
section 5 and the tasks in section 12.

## Verify first

- [ ] Package name and a version to pin: `@google/gemini-cli`
- [ ] Headless flags: `-p`, `--yolo`, `--output-format json`
- [ ] Settings file location and the streamable-HTTP MCP shape (`httpUrl`, `headers`)
- [ ] Instruction file name (`GEMINI.md`) and whether a skills folder is read

## 1. Dockerfile

Delete the three `ARG BOB_*` lines and the whole `---- Bob Shell ----` `RUN`
block. In the `mkdir -p /home/app/.bob ...` block, delete the three `printf`
lines and the `cp -R ... carbon-builder` line. Insert in place of the Bob block:

```dockerfile
# Gemini CLI, pinned. Move the pin deliberately.
ARG GEMINI_CLI_VERSION=x.y.z
RUN npm install -g --registry=https://registry.npmjs.org/ --no-audit --no-fund \
      @google/gemini-cli@${GEMINI_CLI_VERSION} \
  && gemini --version
```

## 2. src/agentRunner.js

Add `'gemini'` to `validAgents` and a new case:

```js
case 'gemini':
  // Headless: one prompt, auto-approved tools, JSON result.
  command = 'gemini';
  args = ['-p', prompt, '--yolo', '--output-format', 'json'];
  break;
```

Where `runAgent` resolves, parse `stdout` as JSON and return the response text
field; keep the token statistics for the ledger.

## 3. src/api/healthChecks.js

Replace `checkBob` with `checkGemini`: run `gemini --version`, then require
`GEMINI_API_KEY`. Use the `checkClaude` shape in `claude-code.md` with the
label `Gemini CLI` and `id: 'agent'`.

## 4. deploy_ce.sh and .env.example

- `SECRET_KEYS` in `.env`: add `GEMINI_API_KEY`; remove `BOB_API_KEY`, `BOB_TEAM_ID`, `BOB_INSTANCE_ID`.
- The preflight `verify_bob_source` function and its call go.
- `--env GITHUB_AI_AGENT_CLI=bob` becomes `gemini` (or the renamed variable from SPEC section 6).
- `.env.example`: replace the Bob block with `GEMINI_API_KEY=` and a one-line comment, and add `AGENT_MONTHLY_BUDGET_USD=` for the budget in section 7. Drop the `BOB_GATEWAY_BASE_URL`, `BOB_CREDITS_*` and `BOB_CHECK_TIMEOUT_MS` entries with the Bobcoins tile.

## 5. MCP configuration

`mcpConnection.js` writes the server entry into `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "carbon-mcp": {
      "httpUrl": "https://mcp.carbondesignsystem.com/mcp",
      "headers": { "Authorization": "Bearer <token>", "X-MCP-Session": "<session id>" }
    }
  }
}
```

Merge into the existing file rather than overwriting it; the CLI keeps other
settings there.

## 6. Workspace instructions and skills

In `src/reviewBundle.js`, write the rules as `<cwd>/GEMINI.md` instead of
`.bob/rules/01-output.md`. If the CLI reads a skills folder, copy the skill
there; otherwise inline the skill's instructions into `GEMINI.md`.

## 7. Cost

No balance API. Record the token statistics from the JSON result per run through
`creditLedger.record` and show spend against a `AGENT_MONTHLY_BUDGET_USD` budget
instead of the Bobcoins balance.

## 8. Verify in the built image

```bash
npm run build:client && podman build --platform linux/amd64 -t harness-test .
podman run --rm --entrypoint gemini harness-test --version
podman run --rm -e GEMINI_API_KEY --entrypoint gemini harness-test -p "Reply with the single word OK" --output-format json
```

## Console icon

The Bobcoins panel shows the worker agent's mark: `import bobMark from '../assets/bob.svg'` in `client/src/components/BobcoinsPanel.jsx`, rendered with alt text naming Bob. Swap the import to `../assets/agents/gemini.svg` and update the alt text. Marks for every mapped agent are in `client/src/assets/agents/`; each stays subject to its owner's brand guidelines.
