# Reading map

What to load, when, and how much. Read a section by locating its heading and
stopping at the next heading of the same level. Confirm a function name with a
search for the name, not by reading its file. Each item on this map is read at the step that lists it, not before.

## By step

| Step        | Read                                                        | Size           |
| ----------- | ----------------------------------------------------------- | -------------- |
| 1 Orient    | `docs/HARNESS.md` §1                                        | about 40 lines |
| 2 Branch    | nothing                                                     |                |
| 3 Interview | `interview/pr-review.md` or `interview/new-job.md`          | about 40 lines |
| 4 Write     | this file, then `templates/SPEC.md`, then per section below |                |

## By SPEC section

| SPEC section               | Branch A reads                                                                                                                                                                                                                    | Branch B reads                                                                                                                                                                                                                |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 Intent                   | interview answers                                                                                                                                                                                                                 | interview answers                                                                                                                                                                                                             |
| 2 Interview record         | interview answers                                                                                                                                                                                                                 | interview answers                                                                                                                                                                                                             |
| 3 Keep / change map        | `docs/HARNESS.md` §2 and §3                                                                                                                                                                                                       | `docs/HARNESS.md` §2 and §3                                                                                                                                                                                                   |
| 4 External system contract | `docs/GITHUB_ACCESS.md`                                                                                                                                                                                                           | `docs/GITHUB_ACCESS.md` as the model of depth; the user's answers for the new system                                                                                                                                          |
| 5 Agent run contract       | `docs/HARNESS.md` §4; `docs/ARCHITECTURE.md` §4.1 and §4.2 only when the ground truth is a different MCP server; the worker-agent file (below) only when the agent is not Bob                                                     | `docs/HARNESS.md` §4; `docs/ARCHITECTURE.md` §6 for the run pipeline; §4.1 and §4.2 only when the ground truth is an MCP server; the worker-agent file when the agent is not Bob                                              |
| 6 Generalisation           | nothing; write "none" unless a rename came up. A non-Bob agent always renames the Bob surfaces (its env variables, the Bobcoins tile and panel, the `bobcoins_*` payload fields): the worker-agent file §4, §7 and "Console icon" | `docs/HARNESS.md` §5; the seven panel titles by `grep title: scripts/rebuild-dashboard.js`                                                                                                                                    |
| 7 Configuration            | `.env.example`, the sections the answers touch, `SECRET_KEYS` in the deployment block among them                                                                                                                                  | `.env.example`, which for B is most of the file (the console sign-in block can be skipped), `SECRET_KEYS` in the deployment block among them                                                                                  |
| 8 Telemetry and reporting  | nothing unless the answers change events; a non-Bob agent changes the `bobcoins_*` payload fields (the worker-agent file §7)                                                                                                      | the `INDEX_MAPPING` constant in `scripts/init-index.js`, root properties and the `payload` block (about 45 lines); the event-type list in `docs/HARNESS.md` §3; the exported names of `src/api/healthChecks.js` for the tiles |
| 9 Deployment               | `docs/ARCHITECTURE.md` §8; §4.3 for why the scale stays at one                                                                                                                                                                    | `docs/ARCHITECTURE.md` §8; §4.3 only when an MCP server is in play                                                                                                                                                            |
| 10 Acceptance criteria     | the answers and sections 3 to 9                                                                                                                                                                                                   | same                                                                                                                                                                                                                          |
| 11 Verification plan       | the test-fixture row of `docs/HARNESS.md` §3                                                                                                                                                                                      | same                                                                                                                                                                                                                          |
| 12 Tasks                   | sections 3 to 11                                                                                                                                                                                                                  | same                                                                                                                                                                                                                          |
| 13 Open questions          | the worker-agent file's "verify first" list when the agent is not Bob                                                                                                                                                             | same                                                                                                                                                                                                                          |

## Worker-agent files

`docs/adapt-harness/agents/<agent>.md`, one per agent: `bob` (the tested path),
`claude-code`, `codex`, `gemini-cli`, `copilot-cli`. Read only the one the user
chose, and only at sections 5, 7, 9, 12 and 13. Each is self-contained, and
the four non-Bob files share one layout, so read it by part:

| SPEC section                              | Agent-file part                                                 |
| ----------------------------------------- | --------------------------------------------------------------- |
| 5 Agent run contract                      | §2 runner, §5 MCP configuration, §6 workspace, §7 cost          |
| 6 and 8, for the Bob surfaces that rename | §4, §7, "Console icon"                                          |
| 7 Configuration                           | §4 deploy script and `.env.example`; §7 for the budget variable |
| 9 Deployment                              | §1 Dockerfile, §8 verify in the built image                     |
| 12 Tasks                                  | every numbered part, in order                                   |
| 13 Open questions                         | "Verify first"                                                  |

## Examples

Two finished SPECs in `docs/adapt-harness/examples/`, one per branch. Read one
only if the user asks what a finished SPEC looks like, or if a section's shape
is unclear after the template; read the matching section, not the whole file.

## Not needed

Source files end to end. `README.md`. `docs/API.md`, `docs/REVIEW_OUTPUT.md`,
`docs/CONFIGURATION.md`, `kibana/README.md`. If a decision seems to need one
of these, the question belongs in SPEC section 13.
