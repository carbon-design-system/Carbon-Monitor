/**
 * Tests for src/observability/eventService.js
 *
 * Stubs esCall to capture the document that would be indexed, so nothing
 * contacts Elasticsearch. Covers the optional `profile` field.
 */

'use strict';

const assert = require('assert');

const esClient = require('../src/observability/esClient');

const indexed = [];
// Replaced before eventService loads: it destructures esCall at require time.
esClient.esCall = async (fn) =>
  fn({
    index: async (request) => {
      indexed.push(request);
      return { result: 'created' };
    },
  });

const { emitEvent } = require('../src/observability/eventService');

let passed = 0;
let failed = 0;

async function test(description, fn) {
  try {
    await fn();
    console.log(`  ✅ ${description}`);
    passed++;
  } catch (error) {
    console.error(`  ❌ ${description}`);
    console.error(`     ${error.message}`);
    failed++;
  }
}

async function emitOne(extra) {
  indexed.length = 0;
  // emitEvent logs a metrics line per event; keep the test output readable
  const log = console.log;
  const error = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    await emitEvent({
      event_type: 'pr_review_started',
      correlation_id: 'run-1',
      repo: 'carbon-design-system/carbon',
      pr_number: 42,
      agent: 'bob',
      ...extra,
    });
  } finally {
    console.log = log;
    console.error = error;
  }
  assert.strictEqual(indexed.length, 1, 'one document indexed');
  return indexed[0].document;
}

async function main() {
  await test('profile core survives into the indexed document', async () => {
    const doc = await emitOne({ profile: 'core' });
    assert.strictEqual(doc.profile, 'core');
  });

  await test('profile caic survives into the indexed document', async () => {
    const doc = await emitOne({ profile: 'caic' });
    assert.strictEqual(doc.profile, 'caic');
  });

  await test('omitting profile leaves the document without the field', async () => {
    const doc = await emitOne({});
    assert.ok(!('profile' in doc), 'no profile key');
    assert.deepStrictEqual(
      Object.keys(doc).sort(),
      [
        'agent',
        'commit_sha',
        'correlation_id',
        'doc_type',
        'event_id',
        'event_type',
        'level',
        'payload',
        'pr_number',
        'repo',
        'timestamp',
      ],
      'document shape is unchanged'
    );
  });

  await test('other fields are intact when profile is supplied', async () => {
    const doc = await emitOne({ profile: 'caic' });
    assert.strictEqual(doc.doc_type, 'carbon_monitor_event');
    assert.strictEqual(doc.event_type, 'pr_review_started');
    assert.strictEqual(doc.level, 'info');
    assert.strictEqual(doc.correlation_id, 'run-1');
    assert.strictEqual(doc.repo, 'carbon-design-system/carbon');
    assert.strictEqual(doc.pr_number, 42);
    assert.strictEqual(doc.agent, 'bob');
  });

  await test('the payload is still scrubbed when profile is supplied', async () => {
    const doc = await emitOne({
      profile: 'core',
      event_type: 'pr_review_failed',
      payload: { error: 'boom\n    at /internal/path.js:1:1' },
    });
    assert.strictEqual(doc.payload.error, 'boom');
    assert.strictEqual(doc.level, 'error');
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main();
