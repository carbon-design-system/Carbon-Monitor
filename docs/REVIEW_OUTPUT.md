# Review output

What Carbon Monitor posts on a pull request, how it picks a recommendation, and how it decides whether a review can be trusted.

## Output Format

Carbon Monitor posts three kinds of comment: a review of inline comments, a summary comment and a short Looks Good comment. A PR with findings above `nit` gets a review of inline comments (for the findings that map to a diff line) plus a summary comment. A PR with nits only, or no findings, gets the Looks Good comment alone and no review. Nits are never posted inline; they appear only in a collapsed list. A PR where no file fits the diff budget gets a short Not Reviewed comment instead (see [Partial reviews](#partial-reviews)).

### Inline comments (on specific diff lines)

All inline comments arrive in one GitHub review (event `COMMENT`, never an approval or a change request), so the PR author gets one notification. The review has no body of its own; the summary comment follows as a separate PR comment. If GitHub rejects the review with a 422, it does not say which comment was bad, so the comments are posted one by one instead; any other error is not retried, because the review may already exist, and those findings go to the summary comment.

```
**Missing aria-label on time picker select**

> [blocking] Should be resolved before this ships.

<cds-time-picker-select> added in this diff has no aria-label attribute.
Interactive select elements inside a composite component must have an
accessible label. Add aria-label="Time zone" (or equivalent) to the element.

*✓ Verified with Carbon Builder + MCP*
```

### Summary comment (PR issue comment)

The first line of the summary comment carries the header label, which identifies
the deployment that posted it. The label differs by profile:

| Profile | Header label                           |
| ------- | -------------------------------------- |
| `core`  | `[AI agent review — Carbon grounded]`  |
| `caic`  | `[AI agent review - CAIC]`             |

The `core` header uses an em dash (U+2014); the `caic` header uses a hyphen-minus.
The "Carbon verification:" line appears in `core` reviews always; in `caic` reviews
it appears only when the review has at least one Category 1 (Carbon API) finding.

```
[AI agent review — Carbon grounded] · **Consider Revising**

Reviewed by: IBM Bob · Commit: a1b2c3d
Carbon verification: Carbon-specific claims verified using Carbon Builder skill (primary authority) and Carbon MCP (fallback).

## Recommendation

1 blocking finding: "Missing aria-label on time picker select"

There are issues in this PR that should be addressed before merging. ...

<details>
<summary>Findings (2)</summary>

**Category** — how each finding was established:

- **Cat 1** — a Carbon-specific claim (does this component accept this prop, attribute or variant?), verified against the Carbon Builder skill or Carbon MCP.
- **Cat 2** — generic correctness, accessibility or duplication, established from the diff alone.

| Area | Category | Severity | Finding | File |
|------|----------|----------|---------|------|
| General | Cat 2 | blocking | Missing aria-label on time picker select | src/components/... |
| Carbon API | Cat 1 | minor | menu-alignment on wrong element | src/components/... |

</details>

## Summary

This PR updates the time picker Figma Code Connect mappings. 1 blocking finding: ...

<details>
<summary>1 optional nit</summary>

- Rename the story — `src/components/TimePicker/TimePicker.stories.js:40`

</details>

<details>
<summary>Details</summary>

## Additional Findings

(findings that could not be placed on a diff line, if any)

Review artifacts:
- PR: #12345
- Commit: a1b2c3d
- Agent: IBM Bob
- Inline comments: 1
- Summary findings: 1

---

**Token Usage:**
- Input tokens: 8,400
- Output tokens: 2,100
- Total tokens: 10,500

</details>

---

*An AI agent generated this review. Human review is advised before acting on any findings.*
```

The nit list shows only when the review has nits. It gives each nit's title and `file:line`, not its body. Nits are not counted in the review artifacts.

The agent is named by its display name, `IBM Bob` or `Claude`, on the `Reviewed by:` line and the `Agent:` line.

The token section shows exact counts from the agent's result record. When a run has no result record, it is titled **Estimated Token Usage:**, the numbers carry a `~`, and a note says they come from character count (see [TOKEN_USAGE_TRACKING.md](TOKEN_USAGE_TRACKING.md)).

### Looks Good comment (PR issue comment)

A PR whose findings are all nits, or that has none, gets this comment in place of the summary comment above. It has no inline comments, recommendation section, findings table, review artifacts or token usage.

```
[AI agent review — Carbon grounded] · **Looks Good** · Reviewed by: Claude · Commit: a1b2c3d

This PR renames two stories and updates their snapshots.

<details>
<summary>2 optional nits</summary>

- Rename the story — `src/b.stories.js:40`
- Prefer a token over a literal — `src/a.scss:12`

</details>
```

Without nits the comment is the first two paragraphs only. One nit reads `1 optional nit`, and a nit with no line number shows `file` alone. A nits-only review whose reliability is in doubt gets the full summary comment instead, with the reliability note and the nit list, and no inline comments.

### Partial reviews

No PR is skipped for its size. The agent gets whole files, source before tests and docs, until the diff budget is spent (`GITHUB_AI_AGENT_MAX_INPUT_TOKENS`) or `GITHUB_AI_AGENT_MAX_FILES` files are in. When some files are left out, the comment says so, after the Recommendation section in the full comment and after the summary in the Looks Good comment:

```
> ⚠️ **Partial review:** this pull request is larger than the review budget, so not every file could be reviewed.
> 120 of 450 changed files were reviewed (410 KB of 2.1 MB of diff). Findings cover the reviewed files only;
> the full set is in the [Files changed](https://github.com/o/r/pull/N/files) tab.

<details>
<summary>Files not reviewed (330)</summary>

**Over the diff size budget (300)**
- `path`

**No diff from GitHub, binary, mode change or too large (5)**
- `path`

**Over the 300-file cap (25)**
- `path`

**Beyond GitHub's 3,000-file listing (12)**, names unavailable

</details>
```

A group with no files is left out. At most 200 names are listed in all; a group cut short ends with `- and N more`, because GitHub rejects a comment over 65,536 characters. GitHub lists at most 3,000 files for a PR, so any beyond that are counted but cannot be named. The agent sees the same list under `## Files Not Reviewed` in its request file, with the same 200-name limit, and is told not to report a missing test or story for those files.

When no whole file fits, the agent gets the start of the first source file, cut at the last hunk that fits, or inside the first hunk at the last line that fits. A marker at the cut names what is shown, for example `4 of 5 hunks` or `120 of 900 lines`, and positions before the cut stay valid. That marker appears only then.

When not even one line of any file fits, no agent runs. The PR gets a short `Not Reviewed` comment with the partial note, which says nothing could be reviewed, and the `AIReviewed` label, so the PR is not picked again on every run. The `pr_review_completed` event records `runs: 0` and the coverage fields, and the Slack digest lists the PR as skipped. With `GITHUB_AI_AGENT_POST_SUMMARY_COMMENT=false` only the label is added.

A file with no `patch` is listed as `no diff from GitHub` unless it is a pure rename, which counts as reviewed with nothing to show. A budget that is not a number means no budget, and a file cap that is not a positive number means no cap.

A scheduled run's Slack digest shows `3 issues found · partial review: 120 of 450 files` on the PR's second line. The `pr_review_completed` event carries `payload.coverage` with `files_total`, `files_reviewed`, `files_omitted`, `diff_chars_total`, `diff_chars_reviewed` and `partial`, and its console line adds `coverage=120/450` when the review is partial.

### Recommendation values

| Value                    | Meaning                                                             |
| ------------------------ | ------------------------------------------------------------------- |
| `Consider Revising`      | One or more `blocking` findings, or two or more `major` findings    |
| `Suggested Improvements` | Any `major` or `minor` finding, or review reliability was uncertain |
| `Looks Good`             | `nit`-level findings only, or no findings                           |

### Finding severities

| Severity   | Meaning                                                                        |
| ---------- | ------------------------------------------------------------------------------ |
| `blocking` | Breaks user-facing behaviour or violates an accessibility requirement          |
| `major`    | Likely to cause a visible rendering difference or runtime error                |
| `minor`    | Maintainability risk or subtle behaviour difference — not immediately breaking |
| `nit`      | Convention / hygiene — no functional consequence                               |

---

## Review Reliability

The parser checks for two signals in the agent's output before the JSON block:

- **Catalogue present** — at least one `[file:line] — ... — pending`, `NO-FINDINGS`, or `SKIP` line must appear. If absent, the agent skipped Step 1 and the review is flagged as unreliable (`catalogueWarning` is set in the comment).
- **Step 2 visible** — pending catalogue items must be resolved with `confirmed finding` or `discarded: [reason]` lines in the visible response. If pending items appear but no resolutions do, the run is treated the same as a missing catalogue.

An unreliable run still posts a comment but sets the recommendation to `Suggested Improvements` and includes a prominent warning note.

### Observed tool calls

The visible catalogue shows what the agent wrote, not what it did. With either agent's `stream-json` output the harness also reads the tool calls in the event stream:

- Skill evidence is a call that loads `carbon-builder`: for Bob a `use_skill` call, or a read of a file under `.bob/skills/carbon-builder/`; for Claude a `Skill` call naming `carbon-builder`, or a `Read` of a file under `.claude/skills/carbon-builder/`. A `carbon-builder` finding with no such evidence is dropped. Runs without an event stream fall back to matching the transcript text.
- Calls to the Carbon MCP tools (`docs_search`, `code_search`, and the rest) are counted, whether the agent calls them through `use_mcp_tool` (Bob) or as `mcp__carbon-mcp__<tool>` (Claude). The log prints them (`Carbon MCP calls: docs_search=2 ...`) and the `pr_review_completed` event carries `tool_calls` and `mcp_tool_calls`.

The raw events are kept in `agent-events.ndjson` in the review bundle (see `GITHUB_AI_AGENT_KEEP_ARTIFACTS`).
