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

GitHub uses a **position-based** system for inline comments, not line numbers:

```
Position 1: diff --git a/file.js b/file.js
Position 2: index 1234567..abcdefg 100644
Position 3: --- a/file.js
Position 4: +++ b/file.js
Position 5: @@ -10,7 +10,8 @@
Position 6:  unchanged line
Position 7: -removed line
Position 8: +added line
Position 9:  unchanged line
```

The mapper:

1. Parses the diff to build a line-to-position map
2. Looks up the finding's line number in the map
3. Returns the position for GitHub's API
4. Falls back to nearby lines (±5) if exact match not found

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
🤖 Bob Review Comment

**Missing aria-label**

Severity: major

Icon button needs aria-label for accessibility. Add aria-label prop with descriptive text.

✓ Verified with carbon-builder
```

Example with carbon-mcp (fallback):

```
🤖 Bob Review Comment

**Missing aria-label**

Severity: major

Icon button needs aria-label for accessibility. Add aria-label prop with descriptive text.

✓ Verified with carbon-mcp
```

### Summary Comment

```markdown
[AI agent review — Carbon grounded]

Reviewed by: bob
Carbon verification policy: Carbon-specific claims verified via Carbon Builder skill (preferred) or Carbon MCP (fallback).

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
- Agent: bob
- Inline comments: 2
- Summary findings: 1
```

## Future Enhancements

Potential improvements:

- Support for multi-line comments (start_line, end_line)
- Suggestion blocks with code fixes
- Batch comment posting for better performance
- Retry logic for failed inline comments
