# Worker agent: IBM Bob Shell

**Status: verified.** This is the path the repository runs in production. Every
item below is read from the code. Keeping Bob means the SPEC marks each row
**keep**; the snippets are here so a SPEC can quote what already exists.

## Where each concern lives

| Concern | File | Detail |
|---------|------|--------|
| Invocation | `src/agentRunner.js`, `case 'bob'` | `bob run --trust --accept-license [--team-id <id>] "<prompt>"`; cwd is the per-item workspace; stdin ignored; 10-minute timeout |
| Authentication | `.env.example`, `SECRET_KEYS` in `.env` | `BOB_API_KEY` (Inference scope). `BOB_TEAM_ID` only for a general-type key. `BOB_INSTANCE_ID` when the key spans instances |
| MCP configuration | `src/api/mcpConnection.js` `writeBobMcpHeaders` | rewrites `~/.bob/settings/mcp.json` with the server URL, `Authorization` and `X-MCP-Session` headers on every refresh |
| Cost | `src/api/bobCredits.js`, `src/api/creditLedger.js` | balance from the Bob gateway admin API; spend recorded per item. `BOB_GATEWAY_BASE_URL` for a non-us-east instance |
| Install | `Dockerfile`, the `---- Bob Shell ----` block | pinned tarball from IBM Cloud Object Storage, SHA-256 checked, installed with `npm install -g` |
| Seeded state | `Dockerfile`, the `mkdir -p /home/app/.bob` block | licence consent in `~/.bob/settings.json`, `/workspace` in `~/.bob/trustedFolders.json`, an empty `~/.bob/settings/mcp.json` |
| Skills and rules | `src/reviewBundle.js` | copies `.bob/skills/carbon-builder` into each workspace and writes `.bob/rules/01-output.md`; Bob reads both from the workspace |
| Health check | `src/api/healthChecks.js` `checkBob` | `bob --version` under `BOB_CHECK_TIMEOUT_MS`, then checks `BOB_API_KEY` is set |
| Network | README, "Who can run this" | IBM office network or VPN |

## Verify in the built image

```bash
npm run build:client && podman build --platform linux/amd64 -t harness-test .
podman run --rm --entrypoint bob harness-test --version
```

## Console icon

The Bobcoins panel shows the worker agent's mark: `import bobMark from '../assets/bob.svg'` in `client/src/components/BobcoinsPanel.jsx`, rendered with alt text naming Bob. Swap the import to `../assets/agents/bob.svg` and update the alt text. Marks for every mapped agent are in `client/src/assets/agents/`; each stays subject to its owner's brand guidelines.
