# Carbon Monitor: instructions for coding agents

Carbon Monitor reviews pull requests in `carbon-design-system/carbon` with an AI
CLI agent, IBM Bob through the Bob Shell CLI (the default) or Claude through the
Claude Code CLI, verifies Carbon claims through the Carbon MCP server, and posts
the results on GitHub. It is also a harness for running any agent on a schedule in
IBM Cloud Code Engine with cost tracking, Elasticsearch telemetry and a Slack
digest. `docs/HARNESS.md` draws the line between the two.

## Commands

```bash
npm ci                           # install from the committed package-lock.json (CI, image)
npm install                      # only to add or bump a dependency; commit the lockfile change
npm run build:client             # Vite build of the console into dist/client
npm run api                      # console + API on http://localhost:3000
npm start -- --pr <number>       # one review from the CLI
npm run test:all                 # the unit suite; npm test runs the same
```

`npm run test:live` runs `tests/test-agent.js`, which performs a REAL review and
posts comments to GitHub. Never run it, `deploy_ce.sh`, or
`scripts/create-*-test-pr.js` unless the user asks for that specific action.

## Layout

- `src/` is CommonJS. `src/api/` is the server and its services; `src/observability/` is telemetry; `src/agents/` is one adapter per agent (`bob.js`, `claude.js`) behind the registry in `index.js`; the rest is the review task layer.
- `client/` is the Carbon React console, built with Vite. Carbon components only; every image has alt text; every input has a label.
- `tests/` are plain Node scripts, each exiting non-zero on failure. Add new ones to `test:all` in `package.json`.
- `evals/` holds disposable offline evals; `tests/fixtures/` holds the fake Bob and the mock GitHub server they share with `tests/`.
- `scripts/` holds Elasticsearch and Kibana setup and scratch-target helpers.
- `docs/` is the source of truth for behaviour. When code and docs disagree, say so rather than silently fixing one.

## Rules

- `.env` holds secrets. Never read, print or commit it. `.env.example` documents every variable; keep it current when you add one.
- Every deployment-specific value (region, project, namespace, URLs, contact addresses) comes from `.env`. Never hard-code one.
- Keep the harness and task layer split described in `docs/HARNESS.md`. A change to the harness needs a reason in the PR.
- Four invariants stay unless a SPEC says why not: one batch at a time, N reviews inside it (`REVIEW_CONCURRENCY`, both supported agents), one instance that never scales to zero, the done marker set after write-back. In a scheduled batch the budget check (`adapter.credits()`) runs before every review, also at N=1 (for Bob, one cached `getBalance` call between reviews).
- Comments in code are short and say why, not what. No comment blocks, no trailers.
- Node 22.15 or later to work on the code; the image and CI run Node 24, which Bob Shell requires. The image is Debian, not Alpine, because of `node-pty`.
- Do not commit. The maintainer commits.

## Documentation map

| Document                         | Covers                                                                                                    |
| -------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `README.md`                      | Overview, quick start, deploy, operate                                                                    |
| `docs/HARNESS.md`                | Harness versus task layer, every extension point, the agent slot, reviews in flight, the scale-out design |
| `docs/ARCHITECTURE.md`           | Image, MCP token refresh, authentication, Code Engine topology, module map                                |
| `docs/GITHUB_ACCESS.md`          | The reviewing GitHub account (i.e. machine user) and its token permissions                                |
| `docs/CONFIGURATION.md`          | Environment variables and Bob, Claude Code, Carbon MCP and skill setup                                    |
| `docs/API.md`                    | REST endpoints and the review trigger contract                                                            |
| `docs/REVIEW_OUTPUT.md`          | Comment formats, recommendations, reliability checks                                                      |
| `docs/INLINE_COMMENTS.md`        | How findings map to diff lines                                                                            |
| `docs/TOKEN_USAGE_TRACKING.md`   | Token usage estimates in the summary comment                                                              |
| `docs/MCP_TOKEN_REFRESH.md`      | Manual Carbon MCP token refresh, the fallback to IBMid sign-in                                            |
| `kibana/README.md`               | Dashboard setup                                                                                           |
| `CONTRIBUTING.md`, `SECURITY.md` | Contributing and vulnerability reporting                                                                  |

## Adapting the harness

To point this at another repository, run a different job on it, or swap the
worker agent, use the `carbon-monitor-adapt-harness` skill in `skills/carbon-monitor-adapt-harness/`, with per-agent notes and example SPECs under `docs/adapt-harness/`. It
interviews the user and writes `specs/<name>/SPEC.md`; implementation happens
from that SPEC in a later session. `bob` and `claude` are built in and switch
with `GITHUB_AI_AGENT_CLI`; another CLI needs an adapter in `src/agents/`
(`docs/HARNESS.md` section 4, "Add an agent").
