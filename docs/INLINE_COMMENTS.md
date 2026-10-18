# Inline Review Comments Implementation

## Overview

The Carbon PR Review bot now supports **inline review comments** that appear directly on specific lines of code in the GitHub PR diff view, in addition to the summary comment. They are posted as one GitHub review.

## How It Works

### 1. Diff Position Mapping

The [`diffMapper.js`](../src/diffMapper.js) module parses the unified diff format to map finding locations to GitHub's diff position system:

```javascript
const { splitFindings } = require('./diffMapper');

const { inlineFindings, summaryFindings } = splitFindings(
  nonNitFindings, // review.findings without the nits
  bundle.diff, // the diff the agent was given
  files
);
```

The diff is not GitHub's `.diff` download, which fails above 300 files. [`reviewCoverage.js`](../src/reviewCoverage.js) assembles it from the `patch` of each file in `pulls.listFiles` (70 files a page, up to GitHub's 3,000), for the files that fit the review (see [Partial reviews](REVIEW_OUTPUT.md#partial-reviews)). A file that is not in the diff has no position, so a finding on it goes to the summary. Files appear in review order, source before tests, and the offsets the agent reports are counted in that order, so the mapper must read the same `bundle.diff` that went into `PR_REVIEW_REQUEST.md`.

### 2. Finding Classification

Each finding is classified as either:

- **Inline-able**: Can be mapped to a specific position in the diff
  - File exists in changed files list
  - Line number exists in the diff (or within 5 lines)
  - Posted as inline review comment on the exact code line

- **Never inline**: `nit` findings. `src/index.js` takes them out before `splitFindings`. They are listed, title and location only, in a collapsed block in the summary comment (or the Looks Good comment)

- **Summary-only**: Cannot be mapped to diff
  - File not in changed files
  - Line number outside diff range
  - Included in the summary comment instead

### 3. Posting Strategy

According to the spec (lines 328-336), the bot follows this strategy:

1. **Post one review** (`pulls.createReview`, event `COMMENT`) with every mappable finding of `minor` severity or above as an inline comment. The review body is one line, because GitHub requires a body on a `COMMENT` review. A PR with no such finding gets no review, which includes every `Looks Good` PR
2. **Post summary comment** (a clean PR gets the short Looks Good comment instead) with:
   - Agent's overall summary
   - Findings that couldn't be mapped inline
   - Review metadata
3. **Add AIReviewed label** only after successful posting

### 4. Fallback Handling

One review is one event and one notification. If it fails:

- GitHub answers 422 when any comment's position does not resolve, and does not say which. In practice GitHub creates nothing on a 422, and the fallback relies on that. The bot logs `Grouped review rejected (422: ...) — posting inline comments one by one` and posts each comment with `pulls.createReviewComment`, which notifies the author once per comment
- Any other error (a 5xx, a network failure) is not retried, because the review may have been created and a retry would post it twice. All the inline findings go to the summary comment
- Findings whose comment failed are moved to summary comment
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

Each file's `diff --git`, mode and `---`/`+++` lines are rebuilt from the file's name and status, because `patch` starts at the first `@@`. They are not counted, so positions are the same as in GitHub's own diff. A renamed file gets `a/<old name>` and `b/<new name>` and no `rename from`, `rename to` or `similarity` line; the mapper keys on the `b/` path. A `patch` that already starts with `diff --git` (test PRs made by `scripts/create-test-pr.js`) is used as it is.

Until Oct 18, 2026 the first header was counted too, so every inline comment
landed one line below the finding and a finding on the last line of a file's
diff was rejected with a 422 ("position could not be resolved").

### Comment Format

Inline comments use the [`formatInlineComment()`](../src/reviewPrompt.js) function: the finding's title in bold, a quoted line with its severity and guidance, the explanation, and, for a Carbon-specific finding, a line saying which source verified it. See [Example Output](#example-output) below.

### API Integration

Uses GitHub's review API via [`githubClient.js`](../src/githubClient.js). `postReviewComments` makes one `octokit.rest.pulls.createReview({ owner, repo, pull_number, commit_id, event: 'COMMENT', body, comments })` call and returns `{ id, comments: [{ path, position }] }`, or `null` when nothing was posted:

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

### Summary and Looks Good comments

The summary comment, the short Looks Good comment and the partial-review note are shown in [REVIEW_OUTPUT.md](REVIEW_OUTPUT.md).

## Future Enhancements

Potential improvements:

- Support for multi-line comments (start_line, end_line)
- Suggestion blocks with code fixes
- Retry logic for failed inline comments
