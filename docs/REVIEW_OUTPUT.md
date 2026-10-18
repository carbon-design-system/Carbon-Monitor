# Review output

What Carbon Monitor posts on a pull request, how it picks a recommendation, and how it decides whether a review can be trusted.

## Output Format

Each reviewed PR receives two types of comments:

### Inline comments (on specific diff lines)

```
**Missing aria-label on time picker select**

> [blocking] Should be resolved before this ships.

<cds-time-picker-select> added in this diff has no aria-label attribute.
Interactive select elements inside a composite component must have an
accessible label. Add aria-label="Time zone" (or equivalent) to the element.

*✓ Verified with Carbon Builder + MCP*
```

### Summary comment (PR issue comment)

```
[AI agent review — Carbon grounded] · **Consider Revising**

Reviewed by: bob · Commit: a1b2c3d
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
<summary>Details</summary>

## Additional Findings

(findings that could not be placed on a diff line, if any)

Review artifacts:
- PR: #12345
- Commit: a1b2c3d
- Agent: bob
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

The token section shows exact counts from Bob's result record. When a run has no result record, it is titled **Estimated Token Usage:**, the numbers carry a `~`, and a note says they come from character count (see [TOKEN_USAGE_TRACKING.md](TOKEN_USAGE_TRACKING.md)).

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

The visible catalogue shows what the agent wrote, not what it did. With Bob's `stream-json` output the harness also reads the tool calls in the event stream:

- A `use_skill` call for `carbon-builder`, or a read of a file under `.bob/skills/carbon-builder/`, counts as skill evidence. A `carbon-builder` finding with no such evidence is dropped. Runs without an event stream fall back to matching the transcript text.
- Calls to the Carbon MCP tools (`docs_search`, `code_search`, and the rest) are counted. The log prints them (`Carbon MCP calls: docs_search=2 ...`) and the `pr_review_completed` event carries `tool_calls` and `mcp_tool_calls`.

The raw events are kept in `agent-events.ndjson` in the review bundle (see `GITHUB_AI_AGENT_KEEP_ARTIFACTS`).
