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
Carbon verification: Carbon-specific claims require Carbon Builder and Carbon MCP verification.

## Recommendation

1 blocking finding: "Missing aria-label on time picker select"

There are issues in this PR that should be addressed before merging. ...

## Findings

| Area       | Category | Severity | Finding                                  | File                    |
|------------|----------|----------|------------------------------------------|-------------------------|
| General    | Cat 2    | blocking | Missing aria-label on time picker select | src/components/...      |
| Carbon API | Cat 1    | minor    | menu-alignment on wrong element          | src/components/...      |

## Summary

This PR updates the time picker Figma Code Connect mappings. 1 blocking finding: ...

Review artifacts:
- PR: #12345
- Commit: a1b2c3d
- Agent: bob
- Inline comments: 1
- Summary findings: 1

---
**Estimated Token Usage:**
- Input tokens: ~8,400
- Output tokens: ~2,100
- Total tokens: ~10,500
```

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
