# Carbon Monitor — Kibana Dashboard

This directory contains the tooling to set up the **Carbon Monitor — PR Review Metrics** dashboard in Kibana.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| Elasticsearch 8.x | Local (`localhost:9200`) or IBM Cloud cluster |
| Kibana 8.x | Must match your ES version. Local: `localhost:5601` |
| Node.js 18+ | For running the setup scripts |
| Carbon Monitor running | At least one successful `npm start` so events exist in ES |

All four ES environment variables must be set in your `.env` before running anything:

```env
ES_URL=https://localhost:9200       # or your IBM Cloud cluster URL
ES_USERNAME=elastic
ES_PASSWORD=your_password_here
ES_CA_CERT_PATH=                    # leave blank for IBM Cloud; set for self-signed certs
```

---

## Quick setup (3 commands)

```bash
# 1. Confirm ES has data and the connection works
node scripts/test-es-connection.js

# 2. Force Kibana to discover all payload.* field mappings
node scripts/refresh-kibana-dataview.js

# 3. Build (or rebuild) all 9 dashboard panels from scratch
node scripts/rebuild-dashboard.js
```

Then open the URL printed by step 3.

---

## What each script does

### `scripts/test-es-connection.js`

Verifies end-to-end connectivity before touching Kibana.

1. Prints which `ES_URL` / `ES_USERNAME` are loaded
2. Pings the Elasticsearch cluster
3. Writes a `diagnostic_ping` test document to `carbon-monitor-events-YYYY.MM`
4. Reads it back to confirm round-trip success
5. Counts all documents in `carbon-monitor-events-*`
6. Shows the 3 most recent real events

Run this first whenever the dashboard stops updating — it will tell you exactly where the chain breaks.

### `scripts/refresh-kibana-dataview.js`

Forces Kibana to re-scan ES mappings for the `carbon-monitor-index-pattern` data view that the 9 Lens panels reference.

You need this after:
- First-ever run (fields aren't known until documents exist)
- Adding new fields to the `payload.*` object in `eventService.js`
- After any index mapping change

### `scripts/rebuild-dashboard.js`

Deletes and recreates all 9 Lens visualisations and the dashboard object via the Kibana Saved Objects API. Use this to:
- Set up the dashboard for the first time
- Reset the dashboard after accidental edits in the Kibana UI
- Apply changes made to the panel definitions in the script

> **Note:** This script uses `overwrite=true` so it is safe to run multiple times.

---

## Dashboard panels

| Panel | Metric category | ES fields used |
|---|---|---|
| PRs Reviewed per Day | Review throughput | `event_type=pr_review_completed` count, 1d bucket |
| PRs Reviewed per Week | Review throughput | `event_type=pr_review_completed` count, 1w bucket |
| Total PRs This Run | Review throughput | `payload.prs_reviewed` sum from `run_completed` |
| Recommendation Distribution | Recommendation distribution | `payload.recommendation` terms |
| Findings per PR — Severity | Finding quality | `payload.findings_blocking/major/minor/nit` sum |
| Carbon API Verification | Carbon API verification | `payload.cat1_findings` vs `payload.cat2_findings` sum |
| Agent Reliability | Agent reliability | `payload.catalogue_present` filtered count |
| Token Cost | Token cost | `payload.token_input` / `payload.token_output` avg |
| Run Health | Run health | `event_type` terms across all events |

---

## Index pattern

All events are written to monthly time-partitioned indices:

```
carbon-monitor-events-YYYY.MM
```

The Kibana data view `carbon-monitor-events-*` covers all months.

> **Kibana note:** There are two data views with the same title in Kibana — one created manually (id `f07cfb33-…`) and one imported with the dashboard (id `carbon-monitor-index-pattern`). The 9 Lens panels all reference `carbon-monitor-index-pattern`. Use `scripts/refresh-kibana-dataview.js` which targets the correct ID automatically.

---

## Troubleshooting

**Dashboard panels show "No results"**

1. Check the time picker — panels default to the last 30 days. Make sure the range covers when your reviews ran.
2. Run `node scripts/test-es-connection.js` — if the count is 0, no events have been written yet.
3. Run `node scripts/refresh-kibana-dataview.js` — if `payload.*` fields show as 0, Kibana doesn't know the field types yet.

**`aggValueCount requires the "field" argument` error**

The Lens objects are stale (written before the Kibana 8.15 fix). Run:
```bash
node scripts/rebuild-dashboard.js
```

**`Cannot read properties of undefined (reading 'layers')` on the donut chart**

Same cause as above — run `rebuild-dashboard.js`.

**ES connection refused / TLS error**

- Local cluster with self-signed cert: the client automatically sets `rejectUnauthorized: false` for `https://localhost` URLs — no extra config needed.
- IBM Cloud cluster: leave `ES_CA_CERT_PATH` blank (public cert). Only set it if you're on a private cluster with a custom CA.

**`[esClient] Circuit breaker OPEN`**

ES returned an error and the circuit breaker tripped. It will auto-reset after 150 seconds and retry. Check `ES_URL`, `ES_USERNAME`, `ES_PASSWORD` in your `.env`.

---

## Adding new panels

1. Edit `scripts/rebuild-dashboard.js` — add a new `create('lens', 'lens-010', …)` call in `buildLensObjects()` and add the panel entry to the `panels` array in `buildDashboard()`.
2. Run `node scripts/rebuild-dashboard.js`.
3. If you added new fields to `eventService.js`, run `node scripts/refresh-kibana-dataview.js` first.
