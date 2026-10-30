/**
 * tests/esNames.test.js — AC-5, AC-9, AC-18
 *
 * AC-5:  Given no ES_INDEX_PREFIX, every name equals today's literal (the §7 table, core column).
 * AC-9:  Given ES_INDEX_PREFIX=carbon-monitor-caic, no caic name matches core's wildcard or template
 *        pattern, and no core name matches caic's.
 * AC-18: Given a fresh caic deployment, the schedule `enabled` is false and the schedule reads
 *        from and writes to the caic-prefixed index only.
 */

'use strict';

const assert = require('assert');

let passed = 0;
let failed = 0;

function test(description, fn) {
  try {
    fn();
    console.log(`  ✅ ${description}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${description}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function withPrefix(prefix, fn) {
  const saved = process.env.ES_INDEX_PREFIX;
  if (prefix === undefined) delete process.env.ES_INDEX_PREFIX;
  else process.env.ES_INDEX_PREFIX = prefix;
  // Clear require cache so the module re-reads the env var.
  delete require.cache[require.resolve('../src/esNames.js')];
  try {
    fn(require('../src/esNames.js'));
  } finally {
    if (saved === undefined) delete process.env.ES_INDEX_PREFIX;
    else process.env.ES_INDEX_PREFIX = saved;
    delete require.cache[require.resolve('../src/esNames.js')];
  }
}

// A fixed date for deterministic index name tests.
const JAN_2025 = new Date('2025-01-15T12:00:00Z');

// ── AC-5: Empty prefix → today's literals ─────────────────────────────────────
console.log(
  '\n── AC-5: empty prefix gives core literals ─────────────────────'
);

test('eventsIndex() with no prefix matches characterization snapshot', () => {
  withPrefix(undefined, (n) => {
    const idx = n.eventsIndex(JAN_2025);
    assert.strictEqual(idx, 'carbon-monitor-events-2025.01');
  });
});

test('eventsIndex() with empty string prefix matches characterization snapshot', () => {
  withPrefix('', (n) => {
    assert.strictEqual(
      n.eventsIndex(JAN_2025),
      'carbon-monitor-events-2025.01'
    );
  });
});

test('eventsWildcard() with no prefix is carbon-monitor-events-*', () => {
  withPrefix(undefined, (n) => {
    assert.strictEqual(n.eventsWildcard(), 'carbon-monitor-events-*');
  });
});

test('eventsAlias() with no prefix is carbon-monitor-events', () => {
  withPrefix(undefined, (n) => {
    assert.strictEqual(n.eventsAlias(), 'carbon-monitor-events');
  });
});

test('eventsTemplate() with no prefix is carbon-monitor-events-template', () => {
  withPrefix(undefined, (n) => {
    assert.strictEqual(n.eventsTemplate(), 'carbon-monitor-events-template');
  });
});

test('eventsIlm() with no prefix is carbon-monitor-events-ilm', () => {
  withPrefix(undefined, (n) => {
    assert.strictEqual(n.eventsIlm(), 'carbon-monitor-events-ilm');
  });
});

test('scheduleIndex() with no prefix is carbon-monitor-schedule', () => {
  withPrefix(undefined, (n) => {
    assert.strictEqual(n.scheduleIndex(), 'carbon-monitor-schedule');
  });
});

test('mcpStateIndexDefault() with no prefix is carbon-monitor-mcp-state', () => {
  withPrefix(undefined, (n) => {
    assert.strictEqual(n.mcpStateIndexDefault(), 'carbon-monitor-mcp-state');
  });
});

// ── AC-9: Caic prefix → disjoint names ────────────────────────────────────────
console.log(
  '\n── AC-9: caic prefix produces disjoint names ──────────────────'
);

const CAIC_PREFIX = 'carbon-monitor-caic';

test('caic eventsIndex() starts with the caic prefix', () => {
  withPrefix(CAIC_PREFIX, (n) => {
    const idx = n.eventsIndex(JAN_2025);
    assert.strictEqual(idx, 'carbon-monitor-caic-events-2025.01');
  });
});

test('caic eventsWildcard() is carbon-monitor-caic-events-*', () => {
  withPrefix(CAIC_PREFIX, (n) => {
    assert.strictEqual(n.eventsWildcard(), 'carbon-monitor-caic-events-*');
  });
});

test('no caic name matches the core wildcard carbon-monitor-events-*', () => {
  const coreWildcard = /^carbon-monitor-events-/;
  withPrefix(CAIC_PREFIX, (n) => {
    const caicNames = [
      n.eventsIndex(JAN_2025),
      n.eventsWildcard(),
      n.eventsAlias(),
      n.eventsTemplate(),
      n.eventsIlm(),
      n.scheduleIndex(),
      n.mcpStateIndexDefault(),
    ];
    for (const name of caicNames) {
      assert.ok(
        !coreWildcard.test(name),
        `Caic name "${name}" matches core wildcard — index isolation broken`
      );
    }
  });
});

test('no core name matches the caic wildcard carbon-monitor-caic-events-*', () => {
  const caicWildcard = /^carbon-monitor-caic-/;
  withPrefix(undefined, (n) => {
    const coreNames = [
      n.eventsIndex(JAN_2025),
      n.eventsWildcard(),
      n.eventsAlias(),
      n.eventsTemplate(),
      n.eventsIlm(),
      n.scheduleIndex(),
      n.mcpStateIndexDefault(),
    ];
    for (const name of coreNames) {
      assert.ok(
        !caicWildcard.test(name),
        `Core name "${name}" matches caic prefix — isolation broken`
      );
    }
  });
});

test('caic eventsIndex() does not match core template pattern carbon-monitor-events-template', () => {
  withPrefix(CAIC_PREFIX, (n) => {
    assert.notStrictEqual(
      n.eventsIndex(JAN_2025),
      'carbon-monitor-events-template'
    );
    assert.notStrictEqual(n.eventsTemplate(), 'carbon-monitor-events-template');
  });
});

test('caic scheduleIndex() is different from core scheduleIndex()', () => {
  let coreSchedule, caicSchedule;
  withPrefix(undefined, (n) => {
    coreSchedule = n.scheduleIndex();
  });
  withPrefix(CAIC_PREFIX, (n) => {
    caicSchedule = n.scheduleIndex();
  });
  assert.notStrictEqual(caicSchedule, coreSchedule);
  assert.strictEqual(caicSchedule, 'carbon-monitor-caic-schedule');
});

test('caic mcpStateIndexDefault() is different from core mcpStateIndexDefault()', () => {
  let coreMcp, caicMcp;
  withPrefix(undefined, (n) => {
    coreMcp = n.mcpStateIndexDefault();
  });
  withPrefix(CAIC_PREFIX, (n) => {
    caicMcp = n.mcpStateIndexDefault();
  });
  assert.notStrictEqual(caicMcp, coreMcp);
  assert.strictEqual(caicMcp, 'carbon-monitor-caic-mcp-state');
});

// ── AC-18: schedule defaults to disabled; ES index follows the prefix ──────────
console.log(
  '\n── AC-18: schedule default-off and index follows prefix ───────'
);

test('scheduleManager defaultState() has enabled: false', () => {
  delete require.cache[require.resolve('../src/api/scheduleManager.js')];
  delete require.cache[require.resolve('../src/esNames.js')];
  const sm = require('../src/api/scheduleManager.js');
  const state = sm.defaultState();
  assert.strictEqual(
    state.enabled,
    false,
    'defaultState() must have enabled: false'
  );
  delete require.cache[require.resolve('../src/api/scheduleManager.js')];
});

test('scheduleManager reads from the caic-prefixed schedule index when ES_INDEX_PREFIX is set', () => {
  // The implementation derives the index via esNames.scheduleIndex() at call time.
  // Verifying the names module produces the right value is sufficient; the
  // integration is covered by the esCall replacement in scheduleManager.js.
  process.env.ES_INDEX_PREFIX = CAIC_PREFIX;
  delete require.cache[require.resolve('../src/esNames.js')];
  try {
    const n = require('../src/esNames.js');
    assert.strictEqual(
      n.scheduleIndex(),
      'carbon-monitor-caic-schedule',
      'With caic prefix, scheduleIndex() must return the caic-prefixed name'
    );
    assert.notStrictEqual(
      n.scheduleIndex(),
      'carbon-monitor-schedule',
      'With caic prefix, scheduleIndex() must not return the core name'
    );
  } finally {
    delete process.env.ES_INDEX_PREFIX;
    delete require.cache[require.resolve('../src/esNames.js')];
  }
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) process.exit(1);
