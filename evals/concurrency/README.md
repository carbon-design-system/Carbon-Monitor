# Concurrency evals

Scratch scripts for `REVIEW_CONCURRENCY`. They are disposable. The scenarios
that matter are promoted to `tests/concurrency.test.js`: four PRs at two
workers, a failing sibling, the low-balance skip, a moving balance, five PRs
with a second trigger answered by `409`, the bearer refresh, and the tagged log.
The mock GitHub server and the sandbox they share live in
`tests/fixtures/concurrencyHarness.js`; the fake Bob and fake Claude are in
`tests/fixtures/bin/`.

Everything is offline: no `.env`, no network beyond 127.0.0.1, no Bobcoins.

```bash
for f in evals/concurrency/0*.js; do node "$f"; done
```

| Script                          | Shows                                                     |
| ------------------------------- | --------------------------------------------------------- |
| `01-four-prs-two-workers.js`    | Two in flight, queue 2, 1, 0, one comment and label each  |
| `02-sequential-at-one.js`       | `REVIEW_CONCURRENCY=1` from the environment is sequential |
| `03-cost-limit-sibling.js`      | A cost-limit failure leaves the sibling review intact     |
| `04-timeout-kills-one.js`       | A 1 s timeout kills only the slow child                   |
| `05-retry-under-concurrency.js` | A retry parses while the sibling runs, sharing one HOME   |
| `06-non-bob-agent.js`           | A non-Bob agent runs one at a time, with one log line     |
