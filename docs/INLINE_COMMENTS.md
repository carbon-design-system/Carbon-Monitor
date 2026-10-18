# Inline Review Comments Implementation

## Overview

The Carbon PR Review bot now supports **inline review comments** that appear directly on specific lines of code in the GitHub PR diff view, in addition to the summary comment.

## How It Works

### 1. Diff Position Mapping

The [`diffMapper.js`](../src/diffMapper.js) module parses the unified diff format to map finding locations to GitHub's diff position system:

```javascript
const { splitFindings } = require('./diffMapper');

const { inlineFindings, summaryFindings } = splitFindings(
  review.findings,
  diff,
  files
);
```

### 2. Finding Classification

Each finding is classified as either:

- **Inline-able**: Can be mapped to a specific position in the diff
  - File exists in changed files list
  - Line number exists in the diff (or within 5 lines)
  - Posted as inline review comment on the exact code line

- **Summary-only**: Cannot be mapped to diff
  - File not in changed files
  - Line number outside diff range
  - Included in the summary comment instead

### 3. Posting Strategy

According to the spec (lines 328-336), the bot follows this strategy:

1. **Post inline comments** for mappable findings
2. **Post summary comment** with:
   - Agent's overall summary
   - Findings that couldn't be mapped inline
   - Review metadata
3. **Add AIReviewed label** only after successful posting

### 4. Fallback Handling

If inline comment posting fails:

- Failed findings are moved to summary comment
- Review continues without blocking
- User still gets all findings, just in summary format

## Implementation Details

### Diff Position Calculation

GitHub's review comment API takes a **position**, not a line number: the
number of lines below the first `@@` hunk header of that file in the unified
diff. The header itself is not counted, a later hunk header in the same file
is, and the count resets at the next `diff --git` line.

```
            diff --git a/file.js b/file.js      (not counted)
            index 1234567..abcdefg 100644       (not counted)
            --- a/file.js                       (not counted)
            +++ b/file.js                       (not counted)
            @@ -10,7 +10,8 @@                   (not counted)
Position 1:  unchanged line                     new-file line 10
Position 2: -removed line
Position 3: +added line                         new-file line 11
Position 4:  unchanged line                     new-file line 12
Position 5: @@ -40,3 +41,4 @@                   (a later header counts)
Position 6:  unchanged line                     new-file line 41
```

The mapper:

1. Parses the diff into a map from new-file line number to position, per file
2. Looks up the finding's line number in that map
3. Falls back to treating the reported line as a `PR_REVIEW_REQUEST.md` line
   number and converting it through the hunk offsets
4. Returns the position for GitHub's API, or routes the finding to the summary

Until Oct 18, 2026 the first header was counted too, so every inline comment
landed one line below the finding and a finding on the last line of a file's
diff was rejected with a 422 ("position could not be resolved").

### Comment Format

Inline comments use the [`formatInlineComment()`](../src/reviewPrompt.js) function:

```markdown
**Finding Title**

Severity: major

Detailed explanation of the issue and how to fix it.

_✓ Verified with carbon-builder_
```

Or if using carbon-mcp fallback:

```markdown
**Finding Title**

Severity: major

Detailed explanation of the issue and how to fix it.

_✓ Verified with carbon-mcp_
```

### API Integration

Uses GitHub's review API via [`githubClient.js`](../src/githubClient.js):

```javascript
await client.postReviewComments({
  owner: OWNER,
  repo: REPO,
  pullNumber: pr.number,
  commitId: pr.head.sha,
  comments: [
    {
      path: 'src/file.js',
      position: 15,
      body: 'Comment text',
    },
  ],
});
```

## Spec Compliance

This implementation complies with the spec requirements:

✅ **Lines 328-336**: Review comment strategy implemented

- Inline comments for specific findings ✓
- Summary comment for whole review ✓
- AIReviewed label after success ✓
- Fallback to summary if mapping fails ✓

✅ **Lines 336**: "If inline mapping fails, include those findings in the summary comment instead of dropping them"

- Implemented in [`index.js`](../src/index.js)

## Testing

Run the diff mapper tests:

```bash
npm run test:diff
```

Expected output:

```
✅ All tests passed!
Inline findings: 2
Summary findings: 2
```

## Configuration

The feature respects the `shouldPostInlineComments` flag from the agent's JSON output:

```json
{
  "summaryMarkdown": "...",
  "findings": [...],
  "shouldPostInlineComments": true
}
```

Set to `false` to disable inline comments and post all findings in summary.

## Example Output

### Inline Comment (on code line)

Example with carbon-builder:

```
**Missing aria-label**

> **[major]** Worth addressing before merge.

Icon button needs aria-label for accessibility. Add aria-label prop with descriptive text.

*✓ Verified with Carbon Builder + MCP*
```

Example with carbon-mcp (fallback):

```
**Missing aria-label**

> **[major]** Worth addressing before merge.

Icon button needs aria-label for accessibility. Add aria-label prop with descriptive text.

*✓ Verified with Carbon MCP*
```

An inline comment does not name the agent. The summary comment does.

### Summary Comment

```markdown
[AI agent review — Carbon grounded] · **Consider Revising**

Reviewed by: IBM Bob · Commit: abc1234
Carbon verification: Carbon-specific claims verified using Carbon Builder skill (primary authority) and Carbon MCP (fallback).

## Review Summary

Found 3 issues: 1 major, 2 minor. All Carbon-specific claims verified.

## Additional Findings

The following findings could not be mapped to specific lines in the diff:

### 1. Unused import

**File:** `src/utils.js` (Line 100)
**Severity:** minor

Import statement is not used in this file.

---

Review artifacts:

- PR: #123
- Commit: abc1234
- Agent: IBM Bob
- Inline comments: 2
- Summary findings: 1
```

## Future Enhancements

Potential improvements:

- Support for multi-line comments (start_line, end_line)
- Suggestion blocks with code fixes
- Batch comment posting for better performance
- Retry logic for failed inline comments
