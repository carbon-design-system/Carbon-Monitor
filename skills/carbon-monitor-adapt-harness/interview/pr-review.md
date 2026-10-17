# Interview: PR reviews for another repository

Ask at most these ten questions, one at a time, in this order. Offer the default
with each question and accept "default" as an answer. Skip any question the user
has already answered. Record every answer, and whether the default was used, in
SPEC section 2.

1. **Target repository.** Which `owner/repo`? Is it a monorepo where reviews
   should be limited to certain paths? (No default; required.)
2. **Reviewing GitHub account.** Which account (i.e. machine user) posts the
   reviews, and does it hold the Triage role on that repository? Point to
   `docs/GITHUB_ACCESS.md`. (Default: a dedicated reviewing GitHub account with
   Triage.)
3. **Selection rules.** Maximum PRs per run, how many days back, labels that
   exclude a PR, and the label that marks a PR reviewed. Bot accounts are
   skipped by account type already. (Defaults: 10, 21 days, the existing skip
   labels, `AIReviewed`.)
4. **Rubric.** Keep the Carbon review rubric in `src/reviewPrompt.js`, trim it,
   or replace it with rules for a different library or domain? If replaced, what
   must every finding be checked against? (Default: keep.)
5. **Ground truth.** Carbon MCP, a different MCP server, or none? For a different
   server: URL, authentication method, and the tool names the agent may call.
   (Default: Carbon MCP.)
6. **Worker agent.** Bob, or another CLI? Note the answer; the matching file
   under `docs/adapt-harness/agents/` is read when the SPEC reaches the
   sections that need it. (Default: Bob.)
7. **Schedule and digest.** Daily run time and time zone, and whether a Slack
   digest is wanted. (Defaults: schedule off until an operator enables it in the
   console; Slack on when a webhook is configured.)
8. **Console access.** Sign-in on or off, and who operates the console.
   (Default: on; the sign-in credentials are configuration, see
   `.env.example`.)
9. **Telemetry.** Keep Elasticsearch and the Kibana dashboard? (Default: keep
   when Elasticsearch is configured; otherwise off, which the code already
   supports.)
10. **Comment wording.** Anything in the posted comments that must change:
    language, disclaimer, the review header. (Default: keep.)

Branch one is expected to produce a SPEC where most decisions are **configure**
and the only **modify** rows are the rubric, the MCP endpoint and, for a non-Bob
agent, the agent slot.
