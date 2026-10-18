# carbon-monitor-adapt-harness

A skill that turns Carbon Monitor into your own scheduled agent. Hand it to your
coding agent inside a clone of this repository. The agent reads the harness map
in stages, asks you at most ten questions about your use case, and writes a
SPEC you can implement from. It writes one Markdown file and changes no code.

Two paths, chosen at the first question:

| Path                                  | Fits when                                                                                                                                            | Typical SPEC                                                     |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **PR reviews for another repository** | You want this reviewer on your own repo, maybe with a different rubric or MCP server                                                                 | Mostly configuration; a short implementation                     |
| **A different job on the harness**    | You want the schedule, cloud deployment, cost tracking, telemetry and Slack digest, but the agent should do something else against some other system | A real adaptation: the task layer is replaced, the harness stays |

Both paths ask which agent runs the job. Bob (the default) and Claude are built
in, so choosing either is configuration: `GITHUB_AI_AGENT_CLI` and its key.
`docs/adapt-harness/agents/` describes both as built, and what an adapter for
Codex, Gemini CLI or Copilot CLI would need, with the Dockerfile and
configuration snippets an implementer uses.

## Install

These steps are for a person at a terminal, not for an agent to run. The skill
works with any agent that reads the Agent Skills format. From a clone of this
repository, pick your agent:

```bash
npx skills add https://github.com/carbon-design-system/Carbon-Monitor/tree/main/skills/carbon-monitor-adapt-harness -a bob
npx skills add https://github.com/carbon-design-system/Carbon-Monitor/tree/main/skills/carbon-monitor-adapt-harness -a claude-code
npx skills add https://github.com/carbon-design-system/Carbon-Monitor/tree/main/skills/carbon-monitor-adapt-harness -a cursor
npx skills add https://github.com/carbon-design-system/Carbon-Monitor/tree/main/skills/carbon-monitor-adapt-harness -a codex
npx skills add https://github.com/carbon-design-system/Carbon-Monitor/tree/main/skills/carbon-monitor-adapt-harness -a github-copilot
npx skills add https://github.com/carbon-design-system/Carbon-Monitor/tree/main/skills/carbon-monitor-adapt-harness -a gemini-cli
```

No skill support? Say "Read `skills/carbon-monitor-adapt-harness/SKILL.md` and
use it as your instructions" instead. Any agent that can read a file can run it.

## Run

Open your agent in the clone and say:

> Adapt this harness to my use case.

In Claude Code, `/carbon-monitor-adapt-harness` does the same. The agent reads
one section of the harness map, asks the branch question, then the interview.
Answer "default" to accept a default. Expect ten to twenty minutes.

## How it keeps context small

The skill does not front-load the repository. Step 1 reads one section of
`docs/HARNESS.md`. The interview loads only its own question file. While
writing the SPEC, [reading-map.md](reading-map.md) names the single section or
block each SPEC section needs, and the worker-agent file is opened only when
the chosen agent is not Bob or Claude and only at the sections that use it. Source files
are not read end to end; a function name is confirmed by search.

## What you get

`specs/<name>/SPEC.md` in your clone, following [templates/SPEC.md](templates/SPEC.md):
intent, the interview record, a keep-or-change decision for every extension
point, the external-system and agent-run contracts, every renamed thing,
configuration, telemetry, deployment, acceptance criteria, a verification plan,
ordered tasks, and the open questions. Two finished examples are in
[docs/adapt-harness/examples](../../docs/adapt-harness/examples/).

## Then

Start a fresh session and say "Implement `specs/<name>/SPEC.md`, one task at a
time, verifying each against its acceptance criteria." Keep the SPEC updated as
decisions change; it is the contract between you and the implementing agent.

## Files

| File                     | Purpose                                             |
| ------------------------ | --------------------------------------------------- |
| `SKILL.md`               | The staged procedure the agent follows              |
| `reading-map.md`         | What to read at each step and for each SPEC section |
| `interview/pr-review.md` | Questions and defaults for the first path           |
| `interview/new-job.md`   | Questions and defaults for the second path          |
| `templates/SPEC.md`      | The SPEC skeleton                                   |
