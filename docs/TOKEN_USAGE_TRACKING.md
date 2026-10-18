# Token Usage Tracking

Each review's summary comment ends with its token usage. The numbers are exact when the agent reports them and an estimate otherwise.

## Where the numbers come from

- **Exact, Bob.** Bob's `stream-json` run ends with a `result` record whose `stats` carry `input_tokens`, `output_tokens`, `total_tokens`, `cache_read_tokens` and `cache_write_tokens`. When both `input_tokens` and `output_tokens` are present, the comment shows them as they are (`source: 'bob'`). Bob Shell 2.0.0 reports no token fields at all, so reviews on it use the estimate; later releases are expected to carry them.
- **Exact, Claude.** Claude's `stream-json` run ends with a `result` record whose `usage` holds `input_tokens`, `output_tokens`, `cache_creation_input_tokens` and `cache_read_input_tokens`. The adapter's `input_tokens` is the sum of the first, the cache creation and the cache read counts, because Claude reports uncached input on its own and the model consumed all three. The total is that input plus `output_tokens`. The cache counts are also kept separately as `cache_write_tokens` and `cache_read_tokens` (`source: 'claude'`).
- **Estimate.** With no result record (`BOB_OUTPUT_FORMAT=pretty`, or a run of either agent that exited without one), `estimateTokenUsage` in [`src/reviewPrompt.js`](../src/reviewPrompt.js) counts 1 token per 4 characters of the prompt, the diff and the agent output (`source: 'estimate'`). Expect it to be off by 10-20% or more.

When a parse failure triggers the retry, the figures describe the run that produced the posted review. The spend in the ledger and the `pr_review_completed` event covers both runs, in the agent's unit (Bobcoins or dollars).

## Example output

With exact counts:

```text
---

**Token Usage:**
- Input tokens: 12,500
- Output tokens: 3,200
- Total tokens: 15,700
```

With the estimate:

```text
---

**Estimated Token Usage:**
- Input tokens: ~12,500
- Output tokens: ~3,200
- Total tokens: ~15,700

_Note: Token estimates are approximate and based on character count (1 token ≈ 4 characters)._
```

## Where else they go

- The `pr_review_completed` event carries `token_input`, `token_output`, `token_total`, `token_cache_read`, `token_cache_write` and `token_source` (the agent's id, `bob` or `claude`, or `estimate`). The comment shows exact counts for any source except `estimate`.
- Each entry in the local credits ledger carries `tokens` (`input`, `output`, `cacheRead`, `cacheWrite`, `total`), `taskId` and `toolCalls` when the agent reported them. With `ES_URL` set, `/api/credits/history` is served from Elasticsearch and drops these fields; without it, the endpoint returns the local ledger entries, which carry them. The `pr_review_completed` payload above always does.
- The log shows `Tokens: ...` for exact counts and `Estimated tokens: ~...` for the estimate, even when `GITHUB_AI_AGENT_POST_SUMMARY_COMMENT=false` skips the comment.

## Testing

```bash
node tests/tokenUsage.test.js
```

It covers the estimate, empty and missing inputs, rounding, and the comment wording for each `source`.

## Related files

- [`src/reviewPrompt.js`](../src/reviewPrompt.js): estimate and comment formatting
- [`src/index.js`](../src/index.js): `tokensFromStats` and the review flow
- [`src/agentRunner.js`](../src/agentRunner.js): the `stats` the runner resolves
- [`tests/tokenUsage.test.js`](../tests/tokenUsage.test.js)
