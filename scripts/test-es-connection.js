#!/usr/bin/env node
/**
 * Diagnostic script — run this to verify ES connectivity and
 * confirm that documents are actually landing in Kibana.
 *
 * Usage:
 *   node scripts/test-es-connection.js
 *
 * It will:
 *   1. Print which ES_URL / ES_USERNAME are loaded from .env
 *   2. Ping the cluster
 *   3. Write one test document to carbon-monitor-events-YYYY.MM
 *   4. Read it back immediately and print it
 *   5. Count all documents in carbon-monitor-events-*
 *   6. Show the 3 most recent real events (if any)
 */

'use strict';

require('dotenv').config();
const fs   = require('fs');
const path = require('path');

// ── 0. Check env ──────────────────────────────────────────────────────────────
console.log('\n──────────────────────────────────────────────');
console.log('  Carbon Monitor — ES connectivity diagnostic');
console.log('──────────────────────────────────────────────\n');

const ES_URL      = process.env.ES_URL;
const ES_API_KEY  = (process.env.ES_API_KEY  || '').trim();
const ES_USERNAME = process.env.ES_USERNAME || 'elastic';
const ES_PASSWORD = process.env.ES_PASSWORD || '';
const ES_CA_CERT  = process.env.ES_CA_CERT_PATH;

console.log('ENV CHECK');
console.log('  ES_URL     :', ES_URL      || '(not set — ES is DISABLED)');
console.log('  Auth       :', ES_API_KEY  ? 'API key (ES_API_KEY)' : `basic (${ES_USERNAME} / ${ES_PASSWORD ? 'password set' : 'NO PASSWORD'})`);
console.log('  ES_CA_CERT :', ES_CA_CERT  || '(not set)');
console.log('  Index mode :', process.env.CARBON_MONITOR_INDEX_MODE || '(not set → auto-resolves: sandbox locally, prod in Code Engine)');
console.log();

if (!ES_URL) {
  console.error('❌  ES_URL is not set in .env — nothing will ever reach Elasticsearch.');
  console.error('    Set ES_URL=https://localhost:9200 (local) or your IBM cluster URL.');
  process.exit(1);
}

// ── 1. Build client ───────────────────────────────────────────────────────────
let Client;
try {
  ({ Client } = require('@elastic/elasticsearch'));
} catch (_) {
  console.error('❌  @elastic/elasticsearch package not installed. Run: npm install');
  process.exit(1);
}

const opts = {
  node: ES_URL,
  requestTimeout: 10_000,
  maxRetries: 0,
};

// API key preferred over username/password (mirrors esClient.js)
if (ES_API_KEY) {
  opts.auth = { apiKey: ES_API_KEY };
} else {
  opts.auth = { username: ES_USERNAME, password: ES_PASSWORD };
}

if (ES_CA_CERT) {
  // Try two candidate paths: as-is, then resolved from CWD
  const candidates = [ES_CA_CERT, path.resolve(process.cwd(), ES_CA_CERT)];
  for (const candidate of candidates) {
    try {
      opts.tls = { ca: fs.readFileSync(candidate) };
      console.log('ℹ️   Using CA cert from', candidate);
      break;
    } catch (_) { /* try next */ }
  }
  if (!opts.tls) console.warn('⚠️   Could not read ES_CA_CERT_PATH from either path — TLS may fail');
} else if (
  ES_URL.startsWith('https://localhost') || ES_URL.startsWith('https://127.') ||
  ES_URL.startsWith('https://0.0.0.0')  || ES_URL.startsWith('https://[::1]')
) {
  opts.tls = { rejectUnauthorized: false };
  console.log('ℹ️   Local HTTPS — TLS verification disabled');
}

const client = new Client(opts);

// ── Index name (mirrors eventService.js + indexEnv.js) ───────────────────────
function currentIndex() {
  const now  = new Date();
  const yyyy = now.getUTCFullYear();
  const mm   = String(now.getUTCMonth() + 1).padStart(2, '0');
  const base = `carbon-monitor-events-${yyyy}.${mm}`;
  // Honour CARBON_MONITOR_INDEX_MODE the same way indexEnv.js does at runtime
  const mode = (process.env.CARBON_MONITOR_INDEX_MODE || '').trim().toLowerCase();
  if (mode === 'prod' || process.env.NODE_ENV === 'production') return base;
  return `${base}_sandbox`;  // default: sandbox (safe)
}

const INDEX = currentIndex();
const WILDCARD = 'carbon-monitor-events-*';

// ── 2. Ping ───────────────────────────────────────────────────────────────────
async function run() {
  console.log('STEP 1 — Ping cluster');
  try {
    const info = await client.info();
    console.log('  ✅ Connected to:', info.name, '| version:', info.version?.number);
  } catch (err) {
    console.error('  ❌ Cannot connect to ES:', err.message);
    console.error('\n  Common causes:');
    console.error('    • Wrong ES_URL (check the port — Kibana is 5601, ES is 9200)');
    console.error('    • Wrong username/password');
    console.error('    • ES not running (check: docker ps  or  curl', ES_URL, ')');
    console.error('    • TLS cert mismatch — set ES_CA_CERT_PATH or use http:// locally');
    process.exit(1);
  }

  // ── 3. Write a test document ────────────────────────────────────────────────
  console.log('\nSTEP 2 — Write a test document to', INDEX);
  const testDoc = {
    doc_type:       'carbon_monitor_event',
    event_id:       'diagnostic-' + Date.now(),
    event_type:     'diagnostic_ping',
    level:          'info',
    timestamp:      new Date().toISOString(),
    correlation_id: 'diagnostic',
    repo:           'diagnostic/test',
    pr_number:      null,
    agent:          'diagnostic',
    commit_sha:     '',
    payload: {
      message: 'ES connectivity test from scripts/test-es-connection.js',
    },
  };

  let docId;
  try {
    const res = await client.index({ index: INDEX, document: testDoc, refresh: 'wait_for' });
    docId = res._id;
    console.log('  ✅ Document written — _id:', docId);
  } catch (err) {
    console.error('  ❌ Failed to write document:', err.message);
    if (err.meta?.body) console.error('     ES response:', JSON.stringify(err.meta.body, null, 2));
    process.exit(1);
  }

  // ── 4. Read it back ─────────────────────────────────────────────────────────
  console.log('\nSTEP 3 — Read it back');
  try {
    const got = await client.get({ index: INDEX, id: docId });
    console.log('  ✅ Round-trip confirmed. Document source:');
    console.log(JSON.stringify(got._source, null, 4));
  } catch (err) {
    console.error('  ❌ Could not read back the document:', err.message);
  }

  // ── 5. Count all carbon-monitor documents ───────────────────────────────────
  console.log('\nSTEP 4 — Count documents in', WILDCARD);
  try {
    const countRes = await client.count({ index: WILDCARD });
    console.log('  Total documents across all carbon-monitor-events-* indices:', countRes.count);
    if (countRes.count === 1) {
      console.log('  ⚠️   Only the diagnostic doc exists — no real reviews have run with ES enabled yet.');
    }
  } catch (err) {
    if (err.meta?.statusCode === 404) {
      console.log('  ⚠️   No carbon-monitor-events-* indices found yet (only the one just created).');
    } else {
      console.error('  ❌', err.message);
    }
  }

  // ── 6. Latest 3 real events ──────────────────────────────────────────────────
  console.log('\nSTEP 5 — Most recent 3 real events (excluding this diagnostic)');
  try {
    const searchRes = await client.search({
      index: WILDCARD,
      size: 3,
      sort: [{ timestamp: 'desc' }],
      query: {
        bool: {
          must_not: [{ term: { event_type: 'diagnostic_ping' } }],
        },
      },
    });
    const hits = searchRes.hits?.hits ?? [];
    if (hits.length === 0) {
      console.log('  ⚠️   No real events found. Run npm start (with a valid GitHub token) to generate them.');
    } else {
      hits.forEach((h, i) => {
        const s = h._source;
        console.log(`\n  [${i + 1}] ${s.timestamp}  event_type=${s.event_type}  pr=${s.pr_number ?? 'n/a'}`);
        if (s.payload && Object.keys(s.payload).length > 0) {
          console.log('      payload:', JSON.stringify(s.payload));
        }
      });
    }
  } catch (err) {
    console.error('  ❌ Search failed:', err.message);
  }

  // ── 7. Data view check ───────────────────────────────────────────────────────
  console.log('\nSTEP 6 — Check Kibana data view (best-effort)');
  const kibanaBase = ES_URL.replace(':9200', ':5601').replace('elasticsearch', 'kibana');
  console.log(`  If Kibana is at ${kibanaBase}, go to:`);
  console.log(`  ${kibanaBase}/app/management/kibana/dataViews`);
  console.log(`  and confirm the data view "carbon-monitor-events-*" exists.`);
  console.log(`  If it does not, the dashboard will show no data even though ES has documents.`);
  console.log(`\n  Also verify the dashboard time range covers the document timestamp above.`);

  console.log('\n──────────────────────────────────────────────');
  console.log('  Diagnostic complete');
  console.log('──────────────────────────────────────────────\n');
}

run().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
