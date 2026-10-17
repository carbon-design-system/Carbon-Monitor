#!/usr/bin/env node
/**
 * Creates the carbon-monitor-index-pattern data view in Kibana.
 *
 * Run this ONCE after pointing Kibana at IBM Cloud ES (before rebuild-dashboard.js).
 * The data view must exist before rebuild-dashboard.js can register runtime fields.
 *
 * Usage:  node scripts/init-kibana.js
 *
 * Safe to re-run — uses override:true so it is idempotent.
 */

'use strict';

require('dotenv').config();
const http = require('http');

// Kibana always authenticates with ES username/password regardless of whether
// ES_API_KEY is set — API keys are for direct ES access, not the Kibana API.
const AUTH = `Basic ${Buffer.from(`${process.env.ES_USERNAME || 'elastic'}:${process.env.ES_PASSWORD || ''}`).toString('base64')}`;

const DATA_VIEW_ID = 'carbon-monitor-index-pattern';
const INDEX_PATTERN = 'carbon-monitor-events-*';
const TIME_FIELD = 'timestamp';
const KIBANA_URL = new URL(process.env.KIBANA_URL || 'http://localhost:5601');
const transport = KIBANA_URL.protocol === 'https:' ? require('https') : http;

function kReq(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = transport.request(
      new URL(path, KIBANA_URL),
      {
        method,
        headers: {
          Authorization: AUTH,
          'kbn-xsrf': 'true',
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(d) });
          } catch (_) {
            resolve({ status: res.statusCode, body: d });
          }
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  console.log(
    '\n── Carbon Monitor — Kibana Init ────────────────────────────\n'
  );

  // 1. Check Kibana is reachable
  const status = await kReq('GET', '/api/status', null);
  if (status.status !== 200) {
    console.error(
      `❌ Cannot reach Kibana at ${KIBANA_URL.origin}. Is it running?`
    );
    console.error('   docker ps');
    process.exit(1);
  }
  console.log(
    `✅ Kibana ${status.body?.version?.number ?? '(unknown version)'} reachable`
  );

  // 2. Check if the data view already exists
  const existing = await kReq(
    'GET',
    `/api/data_views/data_view/${DATA_VIEW_ID}`,
    null
  );
  if (existing.status === 200) {
    const dv = existing.body.data_view || {};
    console.log(
      `ℹ️  Data view already exists: id="${dv.id}"  title="${dv.title}"  timeField="${dv.timeFieldName}"`
    );
    console.log(
      '   Nothing to do — run node scripts/rebuild-dashboard.js next.\n'
    );
    return;
  }

  // 3. Create the data view with the exact ID all Lens panels reference
  console.log(`\nCreating data view "${DATA_VIEW_ID}" → ${INDEX_PATTERN} ...`);
  const create = await kReq('POST', '/api/data_views/data_view', {
    data_view: {
      id: DATA_VIEW_ID,
      title: INDEX_PATTERN,
      timeFieldName: TIME_FIELD,
    },
    override: true,
  });

  if (create.status === 200 || create.status === 201) {
    const dv = create.body.data_view || {};
    console.log(
      `✅ Data view created: id="${dv.id}"  title="${dv.title}"  timeField="${dv.timeFieldName}"`
    );
  } else {
    console.error(`❌ Failed to create data view: HTTP ${create.status}`);
    console.error('   Response:', JSON.stringify(create.body).slice(0, 400));
    process.exit(1);
  }

  console.log(
    '\n── Next step ────────────────────────────────────────────────'
  );
  console.log('   node scripts/rebuild-dashboard.js');
  console.log('────────────────────────────────────────────────────────────\n');
}

main().catch((e) => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
