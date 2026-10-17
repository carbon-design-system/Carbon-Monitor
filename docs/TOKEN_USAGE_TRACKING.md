# Token Usage Tracking

The Carbon PR Review Agent now includes token usage estimation at the end of each PR review.

## Overview

After completing a PR review, the agent calculates an approximate token count based on:

- **Input tokens**: The review prompt + PR diff content
- **Output tokens**: The agent's response (review findings and summary)
- **Total tokens**: Sum of input and output tokens

## How It Works

### Estimation Method

The token estimation uses a simple heuristic:

- **1 token ≈ 4 characters** (for English text)

This is a conservative estimate. Actual tokenization varies by model and language, but this provides a reasonable approximation for cost estimation purposes.

### Implementation

The token usage is calculated in [`src/reviewPrompt.js`](../src/reviewPrompt.js):

```javascript
function estimateTokenUsage({ prompt, diff, agentOutput }) {
  const CHARS_PER_TOKEN = 4;

  const inputChars = (prompt?.length || 0) + (diff?.length || 0);
  const outputChars = agentOutput?.length || 0;

  const inputTokens = Math.ceil(inputChars / CHARS_PER_TOKEN);
  const outputTokens = Math.ceil(outputChars / CHARS_PER_TOKEN);
  const totalTokens = inputTokens + outputTokens;

  return { input: inputTokens, output: outputTokens, total: totalTokens };
}
```

## Example Output

At the end of each PR review comment, you'll see:

```markdown
---

**Estimated Token Usage:**

- Input tokens: ~12,500
- Output tokens: ~3,200
- Total tokens: ~15,700

_Note: Token estimates are approximate and based on character count (1 token ≈ 4 characters)._
```

## Use Cases

### Cost Estimation

Use the token estimates to:

- Track API costs across multiple PR reviews
- Budget for large-scale PR review operations
- Compare efficiency across different agents (bob, claude, codex)

### Performance Monitoring

Monitor token usage trends to:

- Identify unusually large PRs that may need manual review
- Optimize review prompts for efficiency
- Track agent verbosity over time

### Capacity Planning

Use historical token data to:

- Estimate costs for reviewing a backlog of PRs
- Plan API quota allocation
- Determine optimal batch sizes for PR reviews

## Accuracy

The token estimates are **approximate** and may differ from actual token counts by:

- ±10-20% for typical code and English text
- More variance for non-English text or special characters
- Different models tokenize differently (GPT-4, Claude, etc.)

For precise token counts, consult your LLM provider's API response headers or tokenization tools.

## Testing

Run the token usage tests:

```bash
node tests/tokenUsage.test.js
```

This validates:

- Correct calculation for typical PR reviews
- Handling of empty/missing inputs
- Proper rounding of fractional tokens

## Configuration

Token usage tracking is always enabled and cannot be disabled. However, you can:

1. **Skip posting the summary comment** (which includes token usage):

   ```bash
   export GITHUB_AI_AGENT_POST_SUMMARY_COMMENT=false
   ```

2. **View token estimates in logs** even if comments aren't posted:
   ```
   📊 Calculating token usage...
   ✅ Estimated tokens: ~15,700 (input: ~12,500, output: ~3,200)
   ```

## Future Enhancements

Potential improvements:

- Integration with actual tokenizer libraries (tiktoken, etc.)
- Per-model token estimation (GPT-4 vs Claude vs Codex)
- Token usage analytics dashboard
- Cost estimation based on provider pricing
- Token budget limits per PR

## Related Files

- [`src/reviewPrompt.js`](../src/reviewPrompt.js) - Token estimation logic
- [`src/index.js`](../src/index.js) - Integration into review flow
- [`tests/tokenUsage.test.js`](../tests/tokenUsage.test.js) - Test suite
