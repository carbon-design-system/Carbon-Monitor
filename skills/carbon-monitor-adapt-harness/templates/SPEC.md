# SPEC: <short name of the adapted system>

|              |                                                      |
| ------------ | ---------------------------------------------------- |
| Status       | draft                                                |
| Source       | Carbon-Monitor at commit `<sha>`                     |
| Branch       | PR review for another repo / New job on the harness  |
| Worker agent | bob / claude-code / codex / gemini-cli / copilot-cli |
| Written      | <date>                                               |

<!-- Every section is required. Write "none" rather than leaving one out.
     Facts come from docs/HARNESS.md, docs/ARCHITECTURE.md and the interview.
     Anything not settled goes in section 13, never in a guess. -->

## 1. Intent

One paragraph: what the adapted system does each run, for whom, on what
schedule, against which external system, and what a person sees when it is done.

## 2. Interview record

| #   | Question | Answer | Default used |
| --- | -------- | ------ | ------------ |
| 1   |          |        | yes / no     |

## 3. Keep / change map

Every row of the tables in `docs/HARNESS.md` sections 2 and 3 appears here
with a decision. Decisions: **keep** (untouched), **configure** (env only),
**modify** (edit in place), **replace** (new module, same slot), **remove**,
**add** (new slot the harness does not have).

| Area                    | File / function                            | Decision | What changes |
| ----------------------- | ------------------------------------------ | -------- | ------------ |
| Harness · deployment    | `Dockerfile`, `deploy_ce.sh`               | keep     |              |
| Harness · scheduler     | `src/api/scheduleManager.js`               | keep     |              |
| Task · work-item source | `src/githubClient.js` `fetchReviewablePRs` |          |              |

## 4. External system contract

**Read side.** What one work item is. How items are listed and filtered.
The "done" marker that stops an item being processed twice, and where it lives.

**Write side.** What is written back, where, and how a retry stays idempotent.

**Authentication.** Variable names, the role or scopes the account needs, how a
new deployer obtains them. Mirror `docs/GITHUB_ACCESS.md` in depth.

**Limits.** Rate limits, payload size caps, and what the run does when it hits them.

## 5. Agent run contract

- Workspace: the files placed in the per-item working directory and their format.
- Prompt: outline of the instructions, including any rules file and skills.
- Output: the exact structure the agent must emit (markers, JSON shape) and how
  it is validated. State what happens on a parse failure and whether there is a retry.
- Limits: timeout, retries, token budget.
- Ground truth: MCP servers the agent may call, with auth method and tool names.
- Success and failure: what each means for one item and for the run.

## 6. Generalisation

Every review-specific name that changes, old to new. Routes, console labels,
environment variable prefix, event types, index name and payload fields, Slack
wording, labels or markers in the external system. "none" on branch one when
nothing is renamed.

| Kind       | Today                 | New |
| ---------- | --------------------- | --- |
| API route  | `/api/review/trigger` |     |
| Env prefix | `GITHUB_AI_AGENT_*`   |     |
| Event type | `pr_review_completed` |     |

## 7. Configuration

New, renamed and removed environment variables with defaults, the matching
`.env.example` entries, the `SECRET_KEYS` value for the Code Engine secret, and
any `deploy_ce.sh` flag that changes.

## 8. Telemetry and reporting

- Events: the event types emitted per run and per item, with payload fields and
  types (these become the index mapping in `scripts/init-index.js`).
- Dashboard: the Kibana panels that matter and the fields each uses.
- Slack: the digest layout, one line per item and the run footer.
- Console: what each status tile checks and what the run panel shows.

## 9. Deployment

Dockerfile changes (agent install, skills, seeded state), deploy script changes,
the scale constraint (stay at min 1 / max 1 unless the design removes the single
writer), Elasticsearch and Kibana bootstrap, and the first-run steps a human
performs once.

## 10. Acceptance criteria

Numbered, testable, in given / when / then form.

- **AC-1** Given ..., when ..., then ...

## 11. Verification plan

Which test files are adapted or added and what each proves. The no-`.env` CI run.
A dry run against a scratch target. What to check in Kibana and Slack after the
first scheduled run. Anything that can only be verified in the cloud.

## 12. Tasks

Ordered. Each task names its files and the acceptance criteria it satisfies, and
is small enough to finish and verify in one sitting.

1. ...

## 13. Open questions

What the interview could not settle, and who decides.
