#!/usr/bin/env node
/**
 * init-index.js — idempotent Elasticsearch bootstrap for Carbon Monitor
 *
 * Mirrors carbon-migrate/agent-dispatcher/scripts/init-index.js.
 *
 * What it does (all operations are idempotent — safe to re-run):
 *   1. Ping ES (validates credentials + TLS)
 *   2. Ensure ILM policy "carbon-monitor-events-ilm"
 *   3. Ensure composable index template "carbon-monitor-events-template"
 *      (auto-applies mapping + ILM policy to all carbon-monitor-events-* indices)
 *   4. Create the current month's index if absent (carbon-monitor-events-YYYY.MM)
 *   5. Ensure read/write alias "carbon-monitor-events" points at it
 *
 * Usage:
 *   node scripts/init-index.js            # live run
 *   node scripts/init-index.js --dry-run  # print actions, no writes
 *
 * Required env vars (loaded from .env automatically):
 *   ES_URL, ES_USERNAME, ES_PASSWORD
 * Optional:
 *   ES_CA_CERT_PATH, EVENTS_RETENTION_DAYS (default 180, min 90)
 */

'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const esNames = require('../src/esNames');

const DRY = process.argv.includes('--dry-run');

// ── Config ────────────────────────────────────────────────────────────────────
const ES_URL = (process.env.ES_URL || '').trim();
const ES_USERNAME = (process.env.ES_USERNAME || 'elastic').trim();
const ES_PASSWORD = (process.env.ES_PASSWORD || '').trim();
const ES_CA_CERT = (process.env.ES_CA_CERT_PATH || '').trim();
const RETENTION = Math.max(
  90,
  parseInt(process.env.EVENTS_RETENTION_DAYS || '180', 10)
);

// Names are derived from ES_INDEX_PREFIX so this script can bootstrap both
// the core and the caic index by setting that variable before running.
const ALIAS = esNames.eventsAlias();
const TEMPLATE = esNames.eventsTemplate();
const ILM_NAME = esNames.eventsIlm();

function currentMonthIndex() {
  return esNames.eventsIndex();
}

// ── Client ────────────────────────────────────────────────────────────────────
let Client;
try {
  ({ Client } = require('@elastic/elasticsearch'));
} catch (_) {
  console.error(
    '❌  @elastic/elasticsearch is not installed. Run: npm install'
  );
  process.exit(1);
}

if (!ES_URL) {
  console.error('❌  ES_URL is not set — nothing to bootstrap.');
  process.exit(1);
}

const clientOpts = {
  node: ES_URL,
  auth: { username: ES_USERNAME, password: ES_PASSWORD },
  requestTimeout: 15_000,
  maxRetries: 0,
};

if (ES_CA_CERT) {
  try {
    clientOpts.tls = { ca: fs.readFileSync(path.resolve(ES_CA_CERT)) };
    console.log('ℹ️   CA cert loaded from', ES_CA_CERT);
  } catch (e) {
    console.warn('⚠️   Could not read ES_CA_CERT_PATH:', e.message);
  }
} else if (
  ES_URL.startsWith('https://localhost') ||
  ES_URL.startsWith('https://127.')
) {
  clientOpts.tls = { rejectUnauthorized: false };
  console.log('ℹ️   Local HTTPS — TLS verification disabled');
}

const client = new Client(clientOpts);

// ── Index mapping ─────────────────────────────────────────────────────────────
// dynamic:false at root prevents schema drift; payload/data sub-objects are
// free-form (dynamic:true) — same pattern as Carbon Migrate.
const INDEX_MAPPING = {
  dynamic: false,
  properties: {
    doc_type: { type: 'keyword' },
    event_id: { type: 'keyword' },
    event_type: { type: 'keyword' },
    level: { type: 'keyword' },
    timestamp: { type: 'date' },
    correlation_id: { type: 'keyword' },
    repo: { type: 'keyword' },
    pr_number: { type: 'long' },
    pr_author: { type: 'keyword' },
    pr_title: {
      type: 'text',
      fields: { keyword: { type: 'keyword', ignore_above: 512 } },
    },
    agent: { type: 'keyword' },
    profile: { type: 'keyword' },
    commit_sha: { type: 'keyword' },
    payload: {
      dynamic: true,
      properties: {
        // Flat numeric fields used by Kibana Lens sum/average aggregations
        recommendation: { type: 'keyword' },
        findings_total: { type: 'integer' },
        findings_blocking: { type: 'integer' },
        findings_major: { type: 'integer' },
        findings_minor: { type: 'integer' },
        findings_nit: { type: 'integer' },
        cat1_findings: { type: 'integer' },
        cat2_findings: { type: 'integer' },
        catalogue_present: { type: 'boolean' },
        skill_activated: { type: 'boolean' },
        skill_files_read: { type: 'integer' },
        inline_comments_posted: { type: 'integer' },
        summary_findings: { type: 'integer' },
        // coinsSpent and remainingAfter are the keys server.js aggregates.
        // Mappings apply when the next monthly index is created.
        coinsSpent: { type: 'float' },
        remainingAfter: { type: 'float' },
        token_input: { type: 'integer' },
        token_output: { type: 'integer' },
        token_total: { type: 'integer' },
        token_cache_read: { type: 'integer' },
        token_cache_write: { type: 'integer' },
        token_source: { type: 'keyword' },
        cost_unit: { type: 'keyword' },
        coins_source: { type: 'keyword' },
        bob_task_id: { type: 'keyword' },
        tool_calls: { type: 'integer' },
        mcp_tool_calls: { type: 'integer' },
        runs: { type: 'integer' },
        bobcoins_spent: { type: 'float' },
        bobcoins_remaining: { type: 'float' },
        duration_ms: { type: 'long' },
        prs_reviewed: { type: 'integer' },
        prs_requested: { type: 'integer' },
        prs_fetch_failed: { type: 'integer' },
        target_mode: { type: 'keyword' },
        coverage: {
          properties: {
            files_total: { type: 'integer' },
            files_reviewed: { type: 'integer' },
            files_omitted: { type: 'integer' },
            diff_chars_total: { type: 'long' },
            diff_chars_reviewed: { type: 'long' },
            partial: { type: 'boolean' },
          },
        },
        error: { type: 'text' },
      },
    },
  },
};

// ── ILM Policy ────────────────────────────────────────────────────────────────
const ILM_POLICY = {
  policy: {
    phases: {
      hot: { min_age: '0d', actions: { set_priority: { priority: 100 } } },
      warm: {
        min_age: '30d',
        actions: {
          readonly: {},
          set_priority: { priority: 50 },
          allocate: { number_of_replicas: 0 },
        },
      },
      cold: { min_age: '90d', actions: { set_priority: { priority: 0 } } },
      delete: { min_age: `${RETENTION}d`, actions: { delete: {} } },
    },
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function step(msg) {
  console.log('\n' + msg);
}
function ok(msg) {
  console.log('  ✅ ' + msg);
}
function skip(msg) {
  console.log('  ⏭️  ' + msg + ' (dry-run)');
}

async function run() {
  console.log(
    '\n── Carbon Monitor — Elasticsearch Bootstrap ────────────────────'
  );
  if (DRY) console.log('   (DRY RUN — no writes)\n');

  // 1. Ping
  step('1. Ping Elasticsearch');
  const info = await client.info();
  ok(`Connected to ${info.name} (ES ${info.version?.number}) at ${ES_URL}`);

  // 2. ILM policy
  step(`2. ILM policy "${ILM_NAME}" (retention ${RETENTION} days)`);
  if (DRY) {
    skip('PUT _ilm/policy');
  } else {
    await client.ilm.putLifecycle({
      name: ILM_NAME,
      policy: ILM_POLICY.policy,
    });
    ok('ILM policy upserted');
  }

  // 3. Index template
  step(`3. Composable index template "${TEMPLATE}"`);
  const template = {
    index_patterns: [`${ALIAS}-*`],
    priority: 500,
    template: {
      settings: {
        number_of_shards: 1,
        number_of_replicas: 1,
        'index.lifecycle.name': ILM_NAME,
        'index.lifecycle.rollover_alias': ALIAS,
      },
      mappings: INDEX_MAPPING,
    },
  };
  if (DRY) {
    skip('PUT _index_template');
  } else {
    await client.indices.putIndexTemplate({ name: TEMPLATE, ...template });
    ok('Index template upserted');
  }

  // 4. Current month's index
  const monthIdx = currentMonthIndex();
  step(`4. Monthly index "${monthIdx}"`);
  let indexExists = false;
  try {
    indexExists = await client.indices.exists({ index: monthIdx });
  } catch (_) {
    /* treat as not-exists */
  }

  if (indexExists) {
    // Only add new fields — cannot change the type of existing mapped fields.
    // The init-index script is idempotent: new indices are created with the full
    // schema; existing indices receive only additive updates.
    ok(`Index already exists — no schema migration needed`);
  } else {
    if (DRY) {
      skip(`Create index ${monthIdx}`);
    } else {
      await client.indices.create({
        index: monthIdx,
        settings: {
          number_of_shards: 1,
          number_of_replicas: 1,
          'index.lifecycle.name': ILM_NAME,
          'index.lifecycle.rollover_alias': ALIAS,
        },
        mappings: INDEX_MAPPING,
      });
      ok(`Index created: ${monthIdx}`);
    }
  }

  // 5. Alias
  step(`5. Alias "${ALIAS}" → "${monthIdx}"`);
  let aliases = {};
  try {
    const result = await client.indices.getAlias({ name: ALIAS });
    aliases = result || {};
  } catch (e) {
    if (e.meta?.statusCode !== 404) throw e;
  }

  const aliasMissing = Object.keys(aliases).length === 0;
  if (aliasMissing) {
    if (DRY) {
      skip(`Create alias ${ALIAS}`);
    } else {
      await client.indices.putAlias({
        index: monthIdx,
        name: ALIAS,
        is_write_index: true,
      });
      ok(`Alias created: ${ALIAS} → ${monthIdx}`);
    }
  } else {
    // Ensure the current month is the write index
    const currentWrite = Object.entries(aliases).find(
      ([, v]) => v.aliases?.[ALIAS]?.is_write_index
    )?.[0];
    if (currentWrite === monthIdx) {
      ok(`Alias already points at ${monthIdx} (write index) — nothing to do`);
    } else {
      if (DRY) {
        skip(`Update alias write-index to ${monthIdx}`);
      } else {
        const actions = [];
        if (currentWrite) {
          actions.push({ remove: { index: currentWrite, alias: ALIAS } });
        }
        actions.push({
          add: { index: monthIdx, alias: ALIAS, is_write_index: true },
        });
        await client.indices.updateAliases({ actions });
        ok(`Alias write-index updated → ${monthIdx}`);
      }
    }
  }

  console.log(
    '\n── Bootstrap complete ──────────────────────────────────────────'
  );
  console.log(`   Index pattern: ${ALIAS}-*`);
  console.log(`   Write alias:   ${ALIAS}`);
  console.log(`   ILM policy:    ${ILM_NAME} (delete after ${RETENTION}d)`);
  console.log();
}

run().catch((err) => {
  console.error('\n❌ Bootstrap failed:', err.message);
  if (err.meta?.body)
    console.error('   ES response:', JSON.stringify(err.meta.body, null, 2));
  process.exit(1);
});
