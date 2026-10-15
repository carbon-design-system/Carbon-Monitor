# Carbon Monitor — Kibana Dashboard

This directory contains the tooling to set up the **Carbon Monitor — PR Review Metrics** dashboard in Kibana.

---

## Architecture

| Component | Location | Notes |
|---|---|---|
| Elasticsearch | IBM Cloud (remote) | Credentials in `.env` — `ES_URL`, `ES_USERNAME`, `ES_PASSWORD`, `ES_CA_CERT_PATH` |
| Kibana | Local Docker container | Must be pointed at the IBM Cloud ES cluster (see setup below) |
| Carbon Monitor app | Local / Code Engine | Writes events to IBM Cloud ES via `esClient.js` |

**Important:** Kibana and Elasticsearch are on _different hosts_. Kibana runs locally in Docker but queries the IBM Cloud ES cluster. Both must be configured to talk to the same cluster, or the dashboard will show "No results" even when data exists in ES.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| Docker | Kibana runs as a local Docker container |
| Node.js 18+ | For running the setup scripts |
| IBM Cloud ES credentials | `ES_URL`, `ES_USERNAME`, `ES_PASSWORD`, `ES_CA_CERT_PATH` in `.env` |
| At least one successful review run | So `carbon-monitor-events-*` indices exist in ES |

All four ES environment variables must be set in `.env` before running anything:

```env
ES_URL=https://<your-cluster>.databases.appdomain.cloud:32220
ES_USERNAME=ibm_cloud_<your-username>
ES_PASSWORD=<your-password>
ES_CA_CERT_PATH=./src/config/<your-cert>.crt
```

Set `KIBANA_URL` in `.env` if Kibana is not at `http://localhost:5601`.

> **Note:** Do **not** set `ES_API_KEY` when using the Kibana scripts. API keys authenticate direct ES access only — the Kibana API always requires `ES_USERNAME` / `ES_PASSWORD`. If `ES_API_KEY` is present in your environment, the Kibana scripts ignore it.

---

## First-time setup (Kibana pointing at IBM Cloud ES)

When starting fresh, or after a new team member clones the repo, Kibana's Docker container must be reconfigured to point at IBM Cloud ES. Run these five commands in order:

```bash
# 1. Copy the IBM Cloud CA cert into the Kibana container
docker cp src/config/<your-cert>.crt <kibana-container>:/usr/share/kibana/data/ibmcloud_ca.crt

# 2. Rewrite Kibana's config to point at IBM Cloud ES
#    (runs from Carbon-Monitor/ — reads .env automatically)
node -e "
require('dotenv').config();
const cfg = \`server.host: 0.0.0.0
server.shutdownTimeout: 5s
monitoring.ui.container.elasticsearch.enabled: true

elasticsearch.hosts: ['\${process.env.ES_URL}']
elasticsearch.username: '\${process.env.ES_USERNAME}'
elasticsearch.password: '\${process.env.ES_PASSWORD}'
elasticsearch.ssl.certificateAuthorities: [/usr/share/kibana/data/ibmcloud_ca.crt]
elasticsearch.ssl.verificationMode: certificate
\`;
process.stdout.write(cfg);
" | docker exec -i <kibana-container> tee /usr/share/kibana/config/kibana.yml

# 3. Restart Kibana so the new config takes effect
docker restart <kibana-container>

# 4. Wait ~10 s for Kibana to finish starting, then create the data view
node scripts/init-kibana.js

# 5. Build all dashboard panels and register runtime fields
node scripts/rebuild-dashboard.js
```

After step 5, open the URL printed in the terminal.

> **Why is step 4 separate?** The `rebuild-dashboard.js` script registers runtime fields against a data view that must already exist. `init-kibana.js` creates that data view with the exact ID (`carbon-monitor-index-pattern`) that all Lens panels reference.

---

## Day-to-day setup (3 commands)

After the first-time setup above, use these three commands whenever you need to reset or refresh the dashboard:

```bash
# 1. Confirm ES has data and the connection works
node scripts/test-es-connection.js

# 2. Force Kibana to discover all payload.* field mappings
node scripts/refresh-kibana-dataview.js

# 3. Build (or rebuild) all 7 dashboard panels from scratch
node scripts/rebuild-dashboard.js
```

Then open the URL printed by step 3.

---

## What each script does

### `scripts/test-es-connection.js`

Verifies end-to-end connectivity to the **IBM Cloud ES** cluster before touching Kibana.

1. Prints which `ES_URL` / `ES_USERNAME` are loaded
2. Pings the cluster
3. Writes a `diagnostic_ping` test document to `carbon-monitor-events-YYYY.MM`
4. Reads it back to confirm round-trip success
5. Counts all documents in `carbon-monitor-events-*`
6. Shows the 3 most recent real events

Run this first whenever the dashboard stops updating — it tells you exactly where the chain breaks.

### `scripts/refresh-kibana-dataview.js`

Forces Kibana to re-scan ES mappings for the `carbon-monitor-index-pattern` data view that the 7 Lens panels reference.

You need this after:
- First-ever run (fields aren't known until documents exist)
- Adding new fields to the `payload.*` object in `eventService.js`
- After any index mapping change

### `scripts/rebuild-dashboard.js`

Deletes and recreates all 7 Lens visualisations, registers runtime fields, and recreates the dashboard object via the Kibana Saved Objects API. Use this to:
- Set up the dashboard for the first time (after data view exists)
- Reset the dashboard after accidental edits in the Kibana UI
- Apply changes made to the panel definitions in the script

> **Note:** This script uses `overwrite=true` so it is safe to run multiple times.

---

## Dashboard panels

| Panel | Metric category | ES fields used |
|---|---|---|
| PRs Reviewed per Day | Review throughput | `event_type=pr_review_completed` count, 1d bucket |
| AI Recommendation Summary | Recommendation distribution | `payload.recommendation` terms (pure keyword — no `.keyword` suffix) |
| Findings per PR — Severity | Finding quality | `payload.findings_blocking/major/minor/nit` sum |
| Carbon API Verification | Carbon API verification | `payload.cat1_findings` vs `payload.cat2_findings` sum |
| Input & Output Tokens per Review | Token cost | `payload.token_input` / `payload.token_output` avg |
| Total Token Usage per Review | Token cost | `payload.token_total` avg |
| Run Health — Event Breakdown | Run health | `event_type` terms across all events (pure keyword — no `.keyword` suffix) |

---

## Index pattern & field mapping notes

All events are written to monthly time-partitioned indices:

```
carbon-monitor-events-YYYY.MM
```

The Kibana data view `carbon-monitor-events-*` covers all months.

**Field types in the August 2026+ indices:**
- `event_type` — `keyword` (no `.keyword` sub-field)
- `payload.recommendation` — `keyword` (no `.keyword` sub-field)
- All `payload.*` numeric fields — `long` or `float`

If you ever modify a panel manually in the Kibana UI and it stops working, run `node scripts/rebuild-dashboard.js` to reset it from the script's source of truth.

---

## Troubleshooting

**Dashboard panels show "No results" / "Field was not found"**

The most common cause is Kibana pointing at the wrong Elasticsearch cluster. Verify:

1. `docker exec <kibana-container> grep elasticsearch.hosts /usr/share/kibana/config/kibana.yml`  
   — must show the IBM Cloud URL, not `localhost` or a Docker-internal IP like `10.89.0.2`.
2. If it shows the wrong URL, re-run the [first-time setup](#first-time-setup-kibana-pointing-at-ibm-cloud-es) steps above.

**"Field payload.recommendation.keyword was not found"**

The `payload.recommendation` field is mapped as a pure `keyword` — it has no `.keyword` sub-field. The panel must reference `payload.recommendation` directly. Run `node scripts/rebuild-dashboard.js` to apply the correct definition.

**"No results" in Run Health panel only**

Same cause — `event_type` is a pure `keyword` field in the current indices. If the panel references `event_type.keyword`, run `node scripts/rebuild-dashboard.js`.

**Dashboard panels show "No results" even after rebuild**

1. Check the Kibana time picker — confirm it covers when your reviews ran (e.g. "Last 7 days").
2. Run `node scripts/test-es-connection.js` — STEP 5 shows the 3 most recent events. If none appear, no events were written to ES.
3. Run `node scripts/refresh-kibana-dataview.js` — if `payload.*` fields show as 0, the data view needs a field refresh.

**401 Unauthorized when running Kibana scripts**

The scripts authenticate with `ES_USERNAME` and `ES_PASSWORD` from `.env`. They do **not** use `ES_API_KEY` — that variable is for direct ES access only, and Kibana will reject it. If you see 401:
- Confirm `ES_USERNAME` and `ES_PASSWORD` are set correctly in `.env`
- Confirm Kibana is connected to the same ES cluster those credentials belong to

**`[esClient] Circuit breaker OPEN`**

ES returned an error and the circuit breaker tripped. It will auto-reset after 150 seconds and retry. Check `ES_URL`, `ES_USERNAME`, `ES_PASSWORD` in your `.env`.

**ES connection refused / TLS error**

- IBM Cloud cluster: set `ES_CA_CERT_PATH` to the path of the PEM cert provided by IBM Cloud.
- Copy the same cert into the Kibana container: `docker cp <cert> <kibana-container>:/usr/share/kibana/data/ibmcloud_ca.crt`

---

## Adding new panels

1. Edit `scripts/rebuild-dashboard.js` — add a new `create('lens', 'lens-NNN', …)` call in `buildLensObjects()` and add the panel entry to the `panels` array in `buildDashboard()`.
2. Run `node scripts/rebuild-dashboard.js`.
3. If you added new fields to `eventService.js`, run `node scripts/refresh-kibana-dataview.js` first.

> **Field naming rule:** Check the ES mapping before referencing a field. Fields emitted by `eventService.js` are mapped as pure `keyword` or `long` — they have **no `.keyword` sub-field**. Use `event_type` not `event_type.keyword`, and `payload.recommendation` not `payload.recommendation.keyword`.
