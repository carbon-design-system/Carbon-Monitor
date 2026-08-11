#!/usr/bin/env node
/**
 * Force-refreshes the field list for the carbon-monitor-index-pattern data view
 * that the dashboard Lens panels reference.
 *
 * Usage:  node scripts/refresh-kibana-dataview.js
 *
 * Required env var:
 *   KIBANA_URL — e.g. http://localhost:5601  or  https://your-kibana.cloud.ibm.com
 *
 * Auth (same priority as esClient.js):
 *   ES_API_KEY   — preferred; set in Kibana → Stack Management → API Keys
 *   ES_USERNAME / ES_PASSWORD — fallback basic auth
 */

'use strict';

require('dotenv').config();

const http  = require('http');
const https = require('https');

// ── Config from env ───────────────────────────────────────────────────────────
const KIBANA_URL   = (process.env.KIBANA_URL   || '').trim();
const ES_API_KEY   = (process.env.ES_API_KEY   || '').trim();
const ES_USERNAME  = (process.env.ES_USERNAME  || 'elastic').trim();
const ES_PASSWORD  = (process.env.ES_PASSWORD  || '').trim();

if (!KIBANA_URL) {
  console.error('❌  KIBANA_URL is not set in .env');
  console.error('    Example: KIBANA_URL=http://localhost:5601');
  console.error('    For IBM Cloud: KIBANA_URL=https://<your-kibana-host>:<port>');
  process.exit(1);
}

const parsed    = new URL(KIBANA_URL);
const useHttps  = parsed.protocol === 'https:';
const transport = useHttps ? https : http;
const hostname  = parsed.hostname;
const port      = parseInt(parsed.port) || (useHttps ? 443 : 80);

// Build the Authorization header — API key preferred
const AUTH_HEADER = ES_API_KEY
  ? `ApiKey ${ES_API_KEY}`
  : `Basic ${Buffer.from(`${ES_USERNAME}:${ES_PASSWORD}`).toString('base64')}`;

// The ID that all 9 Lens panels reference
const DATA_VIEW_ID = 'carbon-monitor-index-pattern';

function kRequest({ method = 'GET', path, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      hostname,
      port,
      path,
      method,
      headers: {
        'Authorization': AUTH_HEADER,
        'kbn-xsrf': 'true',
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      // Skip TLS verification for localhost (self-signed Kibana dev certs)
      ...(useHttps && (hostname === 'localhost' || hostname === '127.0.0.1')
        ? { rejectUnauthorized: false } : {}),
    };

    const req = transport.request(opts, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (_) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function run() {
  console.log('\n── Kibana data view field refresh ──────────────────');
  console.log(`   Kibana: ${KIBANA_URL}`);
  console.log(`   Auth:   ${ES_API_KEY ? 'API key (ES_API_KEY)' : `basic (${ES_USERNAME})`}`);

  // 1. Confirm the data view exists
  console.log(`\n[1] Fetching data view: ${DATA_VIEW_ID}`);
  const get = await kRequest({ path: `/api/data_views/data_view/${DATA_VIEW_ID}` });
  if (get.status !== 200) {
    console.error('    ❌ Data view not found:', get.status, JSON.stringify(get.body));
    process.exit(1);
  }
  const dv = get.body.data_view;
  console.log(`    ✅ Found: title="${dv.title}"  timeFieldName="${dv.timeFieldName}"`);

  // 2. POST to the fields/refresh endpoint — forces Kibana to re-read ES mappings
  console.log(`\n[2] Refreshing field list via POST /api/data_views/data_view/${DATA_VIEW_ID}/fields`);
  const refresh = await kRequest({
    method: 'POST',
    path: `/api/data_views/data_view/${DATA_VIEW_ID}/fields`,
    body: {},
  });
  if (refresh.status === 200 || refresh.status === 201) {
    const fieldCount = Array.isArray(refresh.body?.fields)
      ? refresh.body.fields.length
      : (Object.keys(refresh.body?.fields ?? {}).length || '?');
    console.log(`    ✅ Field list refreshed — ${fieldCount} fields now indexed`);
  } else {
    // Older Kibana versions use a different endpoint — try the runtime_fields path
    console.warn(`    ⚠️  Endpoint returned ${refresh.status} — trying alternate refresh method`);

    // Alternate: PUT the data view back, which forces a field re-scan
    const put = await kRequest({
      method: 'POST',
      path: `/api/data_views/data_view/${DATA_VIEW_ID}`,
      body: {
        data_view: { title: dv.title, timeFieldName: dv.timeFieldName },
        refresh_fields: true,
      },
    });
    if (put.status === 200 || put.status === 201) {
      console.log(`    ✅ Alternate refresh succeeded (status ${put.status})`);
    } else {
      console.error(`    ❌ Both refresh methods failed. Status: ${put.status}`);
      console.error('    Response:', JSON.stringify(put.body));
      console.log('\n    Manual fallback:');
      console.log(`    http://localhost:5601/app/management/kibana/dataViews`);
      console.log(`    → click "carbon-monitor-events-*" (id: ${DATA_VIEW_ID})`);
      console.log(`    → click the ↺ refresh icon next to the field list`);
    }
  }

  // 3. Verify payload.* fields are now present
  console.log(`\n[3] Checking that payload.* numeric fields are visible`);
  const verify = await kRequest({ path: `/api/data_views/data_view/${DATA_VIEW_ID}` });
  if (verify.status === 200) {
    const fields = verify.body.data_view?.fields ?? {};
    const payloadFields = Object.keys(fields).filter(f => f.startsWith('payload.'));
    if (payloadFields.length > 0) {
      console.log(`    ✅ payload.* fields present (${payloadFields.length}):`);
      payloadFields.forEach(f => console.log(`       ${f}  [${fields[f]?.type}]`));
    } else {
      console.warn(`    ⚠️  No payload.* fields visible yet.`);
      console.warn(`       This means no pr_review_completed events have been indexed,`);
      console.warn(`       OR the field list still needs a manual refresh in the UI.`);
      console.warn(`\n       Go to: http://localhost:5601/app/management/kibana/dataViews`);
      console.warn(`       Click the data view → hit the ↺ icon → save`);
    }
  }

  // 4. Print dashboard link with correct absolute time range
  // ISO timestamps inside a RISON string must have : and . percent-encoded,
  // otherwise Kibana's RISON parser throws "missing ':'".
  const now  = new Date();
  const from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()
                 .replace(/:/g, '%3A').replace(/\./g, '%2E');
  const to   = now.toISOString()
                 .replace(/:/g, '%3A').replace(/\./g, '%2E');
  console.log(`\n[4] Dashboard link (last 7 days, absolute range):`);
  console.log(`    ${KIBANA_URL}/app/dashboards#/view/carbon-monitor-dashboard?_g=(filters:!(),refreshInterval:(pause:!t,value:0),time:(from:'${from}',to:'${to}'))`);

  console.log('\n────────────────────────────────────────────────────\n');
}

run().catch(e => { console.error('Error:', e.message); process.exit(1); });
