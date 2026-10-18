# Interview: a different job on the harness

Ask at most these ten questions, one at a time, in this order. Offer the default
with each question and accept "default" as an answer. Skip any question the user
has already answered. Record every answer, and whether the default was used, in
SPEC section 2. The answers map directly onto the task-layer extension points in
`docs/HARNESS.md`; write the SPEC against those names.

1. **The job.** In one sentence: each run, the agent does what, for whom, and
   what does a person see when it is done? (No default; required.)
2. **The external system.** Which system holds the work: name, the API or MCP
   server used to list items, how the credential is supplied (the name of the
   configuration variable that will hold it, and whether it expires), and any
   rate limit. GitHub is one answer; so is Jira, ServiceNow, Box, a database,
   or a feed. (No default.)
3. **One unit of work and its done marker.** What is one item: a ticket, a
   document, a record, a file? How does the run know an item was already
   processed: a label, a field, a tag, a comment, or a record in Elasticsearch?
   This becomes the de-duplication key. (Default: a marker written to the
   external system, like the `AIReviewed` label.)
4. **Workspace.** What the agent needs in front of it for one item: the data
   files, a rules file, reference material, skills. Any size cap. (Default: one
   request file in Markdown plus the raw item as JSON, like `PR_REVIEW_REQUEST.md`
   and `pr.json`.)
5. **Output.** What the agent must produce for one item, in what structure, and
   how it is validated. (Default: a JSON block between `BEGIN_*_JSON` and
   `END_*_JSON` markers, parsed like `src/reviewParser.js`.)
6. **Write-back.** Where results go: the same system, Slack only, Elasticsearch
   only, somewhere else. How a retry stays idempotent, and what happens to an
   item that half-succeeds. (Default: write to the external system, then set the
   done marker, in that order.)
7. **Ground truth.** Should the agent verify claims against an MCP server before
   acting? Which one, with what authentication, and which tools? (Default: none.)
8. **Worker agent.** Bob, Claude, or another CLI? `bob` and `claude` are
   supported as built, so either is configuration. Another CLI needs an adapter
   per `docs/HARNESS.md` section 4. Note the answer; the matching file under
   `docs/adapt-harness/agents/` is read when the SPEC reaches the sections that
   need it. (Default: Bob.)
9. **Schedule, volume and cost.** How often, how many items per run, the cost
   ceiling per run or per month, and what the run does when the budget is low.
   (Defaults: daily, 10 items, pause the schedule below 10 percent of budget as
   the harness does now.)
10. **Reporting.** What the Slack digest says per item and per run, which Kibana
    panels matter, and who may open the console. (Defaults: one line per item
    with outcome and summary, a run footer, the existing panel set renamed,
    sign-in on.)

Branch two always produces a non-empty section 6 (generalisation). Expect
**replace** on the work-item source, the workspace builder, the prompt, the
parser and the write-back, **modify** on the orchestrator, the event payloads,
the Slack digest and the console labels, and **keep** on the harness.
