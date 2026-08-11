# Carbon Monitor — Kibana Dashboard

This directory contains the tooling to set up the **Carbon Monitor — PR Review Metrics** dashboard in Kibana. The scripts connect to whatever Kibana and Elasticsearch instances you point them at — the same IBM Cloud cluster used in production, or a local Podman stack for development.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| Node.js 22+ | `node --version` must be ≥ 22 |
| `.env` configured | See the env vars section below — all scripts read from `.env` automatically |
| ES has data | At least one `npm start` run must have completed so events exist in the index |

---

## Required `.env` variables

Copy `.env.example` to `.env` and fill in these values. Ask Ignacio for the IBM Cloud cluster credentials.

```env
# ── Elasticsearch ─────────────────────────────────────────────────────────────
ES_URL=https://<ibm-cloud-es-host>:<port>

# Auth — API key is preferred. Get one from Kibana → Stack Management → API Keys.
# If you only have username/password, set those instead and leave ES_API_KEY blank.
ES_API_KEY=<base64-or-id:key>
ES_USERNAME=elastic
ES_PASSWORD=

# CA certificate for IBM Cloud Databases clusters (self-signed CA).
# The cert is already committed — just point at it:
ES_CA_CERT_PATH=./src/config/fa1498a3-0bba-11ea-9a2f-deb1275e52d0.crt

# ── Kibana ─────────────────────────────────────────────────────────────────────
# Required by refresh-kibana-dataview.js and rebuild-dashboard.js.
# Different host from ES_URL — ask Ignacio for the IBM Cloud Kibana URL.
# Local Podman stack: KIBANA_URL=http://localhost:5601
KIBANA_URL=https://<ibm-cloud-kibana-host>:<port>

# ── Index mode ─────────────────────────────────────────────────────────────────
# On your laptop, events go to carbon-monitor-events-YYYY.MM_sandbox by default.
# Set to "prod" only when you intentionally want to write to the production index.
# CARBON_MONITOR_INDEX_MODE=prod
```

> **Auth priority:** `ES_API_KEY` takes precedence over `ES_USERNAME`/`ES_PASSWORD` when both are set. The same key is used for both Elasticsearch and Kibana API calls.

---

## Quick setup (3 commands)

Run these from the `Carbon-Monitor/` directory in order:

```bash
# 1. Verify ES connectivity and confirm events exist
node scripts/test-es-connection.js

# 2. Force Kibana to re-scan ES field mappings for the data view
node scripts/refresh-kibana-dataview.js

# 3. Build (or rebuild) all dashboard panels from scratch
node scripts/rebuild-dashboard.js
```

Step 3 prints a direct URL to the dashboard. Open it in your browser.

---

## What each script does

### `scripts/test-es-connection.js`

Verifies end-to-end Elasticsearch connectivity before touching Kibana. Run this first whenever the dashboard stops updating — it tells you exactly where the chain breaks.

1. Prints which `ES_URL`, auth method, CA cert, and index mode are loaded
2. Pings the cluster
3. Writes a `diagnostic_ping` test document to the current index
4. Reads it back to confirm round-trip success
5. Counts all documents in `carbon-monitor-events-*`
6. Shows the 3 most recent real events

The test document is written to the **sandbox index** by default (`carbon-monitor-events-YYYY.MM_sandbox`) so it never pollutes production data.

### `scripts/refresh-kibana-dataview.js`

Forces Kibana to re-scan ES mappings for the `carbon-monitor-index-pattern` data view that all Lens panels reference. Requires `KIBANA_URL` to be set.

Run this after:
- First-ever setup (field types aren't visible in Kibana until documents exist)
- Adding new fields to `payload.*` in `src/observability/eventService.js`
- Any index mapping change in `scripts/init-index.js`

Also prints a ready-to-use dashboard link covering the last 7 days.

### `scripts/rebuild-dashboard.js`

Deletes and recreates all Lens visualisations and the dashboard object via the Kibana Saved Objects API. Safe to run multiple times (`overwrite=true`). Requires `KIBANA_URL` to be set.

Use this to:
- Set up the dashboard for the first time
- Reset the dashboard after accidental edits in the Kibana UI
- Pick up changes made to panel definitions in the script itself

Prints a direct link to the rebuilt dashboard on success.

### `scripts/init-index.js`

One-time (idempotent) Elasticsearch bootstrap. Creates the ILM lifecycle policy, composable index template, current month's index, and read/write alias. Run this once before the first `npm start`.

```bash
node scripts/init-index.js            # live run
node scripts/init-index.js --dry-run  # print actions without writing
```

---

## Dashboard panels

| Panel | What it shows | Key ES fields |
|---|---|---|
| PRs AI Reviewed per Day | Daily review throughput | `event_type=pr_review_completed`, 1d bucket |
| Total PRs This Run | PRs processed per run | `payload.prs_reviewed` sum from `run_completed` |
| AI Recommendation Summary | Approve / Request Changes / Comment split | `payload.recommendation` terms (donut) |
| Findings by Severity | Blocking / Major / Minor / Nit over time | `payload.findings_blocking/major/minor/nit` sum |
| Carbon vs Non-Carbon Issues | Carbon-specific vs general findings | `payload.cat1_findings` vs `payload.cat2_findings` |
| Agent Reliability | Runs with a full Carbon catalogue vs without | `payload.catalogue_present` filtered count |
| Token Cost — Input & Output | Average input and output tokens per review | `payload.token_input` / `payload.token_output` avg |
| Token Cost — Total Tokens | Total token usage trend | `payload.token_total` avg |

---

## Index names and sandbox mode

Events are written to monthly time-partitioned indices:

| Environment | Index written to |
|---|---|
| Local dev (default) | `carbon-monitor-events-YYYY.MM_sandbox` |
| IBM Code Engine (production) | `carbon-monitor-events-YYYY.MM` |
| Explicit override | Set `CARBON_MONITOR_INDEX_MODE=prod` or `=sandbox` |

The Kibana data view uses the pattern `carbon-monitor-events-*`, which covers both production and sandbox indices. If the dashboard shows no data after a local run, check that the time range in the date picker covers when the reviews ran and that you're not filtering to the wrong index.

> **Two data views with the same title:** Kibana may show two data views named `carbon-monitor-events-*` — one you created manually (with a random UUID as its id) and one created by the scripts (id `carbon-monitor-index-pattern`). All Lens panels reference `carbon-monitor-index-pattern`. The `refresh-kibana-dataview.js` script targets the correct id automatically.

---

## Troubleshooting

**`KIBANA_URL is not set in .env`**

Add `KIBANA_URL=http://localhost:5601` (local) or the IBM Cloud Kibana URL to your `.env`. It is a different host from `ES_URL`.

**`401 Unauthorized` when running a Kibana script**

- If you set `KIBANA_URL=http://localhost:5601` but Kibana isn't running locally, the connection hits nothing and returns a 401-like error. Either start Kibana locally (see below) or set `KIBANA_URL` to the IBM Cloud Kibana URL.
- If Kibana is running, check that `ES_API_KEY` (or `ES_USERNAME`/`ES_PASSWORD`) match the credentials for that Kibana instance.

**Dashboard panels show "No results"**

1. Check the **time picker** in the top right — panels use whatever range is selected. Make sure it covers the window when your reviews ran.
2. Run `node scripts/test-es-connection.js` — if the event count is 0, no reviews have written events yet.
3. Check the **index mode**: local runs write to `_sandbox` indices. If your Kibana data view only covers the production index, sandbox events won't appear.
4. Run `node scripts/refresh-kibana-dataview.js` — if `payload.*` fields aren't discovered yet, panels that aggregate on them will show nothing.

**`rison decoder error: missing ':'` when opening a dashboard URL**

The URL contains an unencoded ISO timestamp. This is fixed in the current scripts — re-run `refresh-kibana-dataview.js` or `rebuild-dashboard.js` to get a corrected link. Alternatively, set the time range manually in Kibana's date picker.

**`aggValueCount requires the "field" argument` or broken donut chart**

The saved Lens objects are stale. Run:
```bash
node scripts/rebuild-dashboard.js
```

**`[esClient] Circuit breaker OPEN`**

ES returned a connection error and the circuit breaker tripped. It auto-resets after 150 seconds. Check `ES_URL`, auth credentials, and `ES_CA_CERT_PATH` in your `.env`, then run `node scripts/test-es-connection.js` to diagnose.

**TLS / certificate error connecting to ES**

- **IBM Cloud cluster:** `ES_CA_CERT_PATH` should point at `./src/config/fa1498a3-0bba-11ea-9a2f-deb1275e52d0.crt` (already committed). This is the CA cert for the shared IBM Cloud Databases cluster.
- **Local Podman cluster with self-signed cert:** set `ES_TLS_REJECT_UNAUTHORIZED=false` in your `.env`.
- **Other error:** run `node scripts/test-es-connection.js` — it prints the cert SHA-256 prefix so you can verify the right file loaded.

---

## Running Kibana locally with Podman

If you don't have access to the IBM Cloud Kibana URL, you can run a local ES + Kibana stack. This uses a **separate** local ES instance — it won't have any production data.

```bash
# Create a shared network
podman network create elastic

# Start Elasticsearch 8.15
podman run -d --name es01 --network elastic \
  -p 9200:9200 \
  -e "discovery.type=single-node" \
  -e "xpack.security.enabled=true" \
  -e "ELASTIC_PASSWORD=changeme" \
  docker.elastic.co/elasticsearch/elasticsearch:8.15.0

# Extract the CA cert from the container
podman exec es01 cat config/certs/http_ca.crt > .es-ca-cert.tmp

# Start Kibana 8.15
podman run -d --name kib01 --network elastic \
  -p 5601:5601 \
  docker.elastic.co/kibana/kibana:8.15.0

# Get the Kibana enrollment token from ES and paste it into localhost:5601
podman exec es01 bin/elasticsearch-create-enrollment-token -s kibana
```

Then set in `.env`:
```env
ES_URL=https://localhost:9200
ES_USERNAME=elastic
ES_PASSWORD=changeme
ES_CA_CERT_PATH=./.es-ca-cert.tmp
KIBANA_URL=http://localhost:5601
```

Bootstrap the index and run a review to generate events before running the Kibana scripts.

---

## Adding new dashboard panels

1. Add a new event field to `src/observability/eventService.js` and emit it in `src/index.js`.
2. Add the field mapping to `scripts/init-index.js` under `INDEX_MAPPING.properties.payload.properties`.
3. Run `node scripts/init-index.js` to update the template (won't affect existing indices).
4. Run `npm start` to generate at least one event with the new field.
5. Run `node scripts/refresh-kibana-dataview.js` so Kibana discovers the new field type.
6. Add a new `create('lens', 'lens-NNN', …)` call in `buildLensObjects()` inside `scripts/rebuild-dashboard.js` and a matching entry in the `panels` array in `buildDashboard()`.
7. Run `node scripts/rebuild-dashboard.js`.
