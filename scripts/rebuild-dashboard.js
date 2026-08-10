#!/usr/bin/env node
/**
 * Rebuilds all Lens panels and the dashboard from scratch using the
 * Kibana Saved Objects API. Deletes stale objects first, then writes
 * correct ones with fully-populated datasourceStates.
 *
 * Usage:  node scripts/rebuild-dashboard.js
 *
 * Panels (7 total after removals):
 *   lens-001  PRs AI Reviewed per Day        (bar, X=date, Y=PRs AI Reviewed)
 *   lens-003  Total PRs This Run             (metric tile)
 *   lens-004  AI Recommendation Summary      (donut, renamed values)
 *   lens-005  Findings by Severity           (vertical stacked bar, X=PR #)
 *   lens-006  Carbon vs Non-Carbon Issues    (stacked bar, renamed labels)
 *   lens-007  Agent Reliability              (stacked bar)
 *   lens-008  Token Cost — Input & Output    (line, X=PR #, Y=Token Count)
 *   lens-010  Token Cost — Total Tokens      (line, X=PR #, Y=Token Count)
 *
 * Removed:
 *   lens-002  PRs Reviewed per Week          (deleted per request)
 *   lens-009  Run Health                     (deleted per request)
 */
'use strict';

require('dotenv').config();
const http = require('http');

const AUTH = Buffer.from(
  `${process.env.ES_USERNAME || 'elastic'}:${process.env.ES_PASSWORD || ''}`
).toString('base64');
const DV_ID = 'carbon-monitor-index-pattern';

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function kReq(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'localhost', port: 5601, method, path,
      headers: {
        'Authorization': `Basic ${AUTH}`,
        'kbn-xsrf': 'true',
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const req = http.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch (_) { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function del(type, id) {
  const r = await kReq('DELETE', `/api/saved_objects/${type}/${id}?force=true`);
  console.log(`  DELETE ${type}/${id} → ${r.status}`);
}

async function create(type, id, attributes, references = []) {
  const r = await kReq('POST', `/api/saved_objects/${type}/${id}?overwrite=true`, { attributes, references });
  if (r.status !== 200 && r.status !== 201) {
    console.error(`  ❌ CREATE ${type}/${id} → ${r.status}`, JSON.stringify(r.body).slice(0, 300));
  } else {
    console.log(`  ✅ CREATE ${type}/${id} → ${r.status}`);
  }
  return r;
}

// ── Column helpers ────────────────────────────────────────────────────────────
// customLabel: true is required in Kibana 8.15 to make the legend display the
// column's label property instead of auto-generating "Sum of payload.field_name".
function countCol(label) {
  return { dataType: 'number', isBucketed: false, label, customLabel: true, operationType: 'count', scale: 'ratio', sourceField: '___records___' };
}
function sumCol(label, field) {
  return { dataType: 'number', isBucketed: false, label, customLabel: true, operationType: 'sum', scale: 'ratio', sourceField: field };
}
function filteredCountCol(label, query) {
  return { dataType: 'number', isBucketed: false, label, customLabel: true, operationType: 'count', scale: 'ratio', sourceField: '___records___', filter: { query, language: 'kuery' } };
}

// Date histogram bucket column
function dateCol(label, interval) {
  return {
    dataType: 'date', isBucketed: true, label,
    operationType: 'date_histogram',
    params: { dropPartials: false, includeEmptyRows: false, interval },
    scale: 'interval', sourceField: 'timestamp',
  };
}

// Terms bucket on the pr_label runtime field — one slot per Carbon PR label,
// ordered chronologically via min(timestamp).
// pr_label is a runtime keyword that maps test repo PR numbers to Carbon PR labels
// e.g. test PR 157 → '#864', unmapped PRs fall back to '#<pr_number>'.
function prNumberCol() {
  return {
    dataType: 'string', isBucketed: true, label: 'Carbon PR', customLabel: true,
    operationType: 'terms',
    params: {
      size: 100,
      orderBy: { type: 'column', columnId: 'col-ts-order' },
      orderDirection: 'asc',
      missingBucket: false, otherBucket: false,
    },
    scale: 'ordinal', sourceField: 'pr_label',
  };
}

// Hidden sort column — min(timestamp) per PR bucket, used only for ordering
function tsOrderCol() {
  return {
    dataType: 'number', isBucketed: false, label: 'Time (sort)',
    operationType: 'min', scale: 'ratio', sourceField: 'timestamp', params: {},
  };
}

function eventTypeFilter(et) {
  return [{
    $state: { store: 'appState' },
    meta: { alias: null, disabled: false, key: 'event_type', negate: false, params: { query: et }, type: 'phrase' },
    query: { match_phrase: { event_type: et } },
  }];
}

// Standard XY visualization wrapper
function xyViz({ seriesType, layerId, xAccessor, accessors, splitAccessor, legend, yLeftTitle, xTitle, rotateX = false }) {
  return {
    axisTitlesVisibilitySettings: { x: !!xTitle, yLeft: !!yLeftTitle, yRight: false },
    axisExtentsConfig: { yLeftExtent: { mode: 'full' }, yRightExtent: { mode: 'full' } },
    yTitle: yLeftTitle || '',
    xTitle: xTitle || '',
    fittingFunction: 'None',
    gridlinesVisibilitySettings: { x: true, yLeft: true, yRight: false },
    labelsOrientation: { x: rotateX ? -45 : 0, yLeft: 0, yRight: 0 },
    layers: [{
      accessors,
      layerId,
      layerType: 'data',
      seriesType,
      xAccessor,
      ...(splitAccessor ? { splitAccessor } : {}),
      yConfig: accessors.map(a => ({ forAccessor: a, axisMode: 'left' })),
    }],
    legend: legend ?? { isVisible: true, position: 'right', showSingleSeries: true },
    preferredSeriesType: seriesType,
    tickLabelsVisibilitySettings: { x: true, yLeft: true, yRight: false },
    valueLabels: 'hide',
  };
}

const dvRef = (name) => [{ id: DV_ID, name, type: 'index-pattern' }];

// ── Build all lens objects ────────────────────────────────────────────────────
async function buildLensObjects() {

  // ── lens-001: PRs AI Reviewed per Day ──────────────────────────────────────
  // X = date (day), Y = "PRs AI Reviewed" count
  await create('lens', 'lens-001', {
    title: 'PRs AI Reviewed per Day',
    visualizationType: 'lnsXY',
    state: {
      datasourceStates: {
        formBased: {
          layers: {
            layer1: {
              columnOrder: ['col-date', 'col-count'],
              columns: {
                'col-date': dateCol('Date', '1d'),
                'col-count': countCol('PRs AI Reviewed'),
              },
              incompleteColumns: {},
            },
          },
        },
      },
      filters: eventTypeFilter('pr_review_completed'),
      query: { language: 'kuery', query: '' },
      visualization: xyViz({
        seriesType: 'bar',
        layerId: 'layer1',
        xAccessor: 'col-date',
        accessors: ['col-count'],
        xTitle: 'Date',
        yLeftTitle: 'PRs AI Reviewed',
        legend: { isVisible: false, position: 'right' },
      }),
    },
  }, dvRef('indexpattern-datasource-layer-layer1'));

  // ── lens-004: AI Recommendation Summary — donut ─────────────────────────────
  // Renamed values via a runtime field that maps raw ES values to display labels.
  // We use a Kibana runtime field (scripted) approach: add a formula column that
  // maps the raw recommendation string to the friendly label, then bucket on that.
  // Kibana Lens doesn't support value renaming natively, so we use the 'formula'
  // operationType which evaluates a Painless-like expression per bucket.
  // Simplest working approach: bucket on raw field, rely on Kibana's display name
  // feature via the terms column label override. The actual slice labels in the
  // donut come from the bucket key. We use a scripted_metric approach via a
  // runtime_field registered on the data view — but that requires a PUT to the
  // data view API. Easier: just use a scripted label column via Lens 'static_value'
  // — not supported. Correct approach: use the Kibana runtime fields API to add
  // a computed field, or use a terms column with a 'missing' fallback.
  //
  // ✅ Actual supported method: add a runtime field to the data view that maps
  // the raw recommendation to the display label, then bucket on that field.
  await create('lens', 'lens-004', {
    title: 'AI Recommendation Summary',
    visualizationType: 'lnsPie',
    state: {
      datasourceStates: {
        formBased: {
          layers: {
            layer1: {
              columnOrder: ['col-rec', 'col-count'],
              columns: {
                'col-rec': {
                  dataType: 'string', isBucketed: true, label: 'Recommendation',
                  operationType: 'terms',
                  params: {
                    missingBucket: false,
                    orderBy: { columnId: 'col-count', type: 'column' },
                    orderDirection: 'desc',
                    otherBucket: false,
                    size: 10,
                  },
                  scale: 'ordinal',
                  // Runtime keyword fields don't get a .keyword sub-field — they ARE keyword
                  sourceField: 'payload.recommendation_label',
                },
                'col-count': countCol('Reviews'),
              },
              incompleteColumns: {},
            },
          },
        },
      },
      filters: eventTypeFilter('pr_review_completed'),
      query: { language: 'kuery', query: '' },
      visualization: {
        shape: 'donut',
        layers: [{
          layerId: 'layer1',
          layerType: 'data',
          primaryGroups: ['col-rec'],
          metrics: ['col-count'],
          categoryDisplay: 'default',
          legendDisplay: 'default',
          nestedLegend: false,
          numberDisplay: 'percent',
        }],
      },
    },
  }, dvRef('indexpattern-datasource-layer-layer1'));

  // ── lens-005: Findings by Severity — vertical stacked bar, X = PR number ───
  // Colors: Carbon Design System IBM Blue scale — darkest = most severe
  // Blocking: Blue 60 (#0f62fe) → Major: Blue 50 (#4589ff)
  // Minor:    Blue 40 (#78a9ff) → Nit:   Blue 30 (#a6c8ff)
  await create('lens', 'lens-005', {
    title: 'Findings by Severity',
    visualizationType: 'lnsXY',
    state: {
      datasourceStates: {
        formBased: {
          layers: {
            layer1: {
              columnOrder: ['col-pr', 'col-ts-order', 'col-blocking', 'col-major', 'col-minor', 'col-nit'],
              columns: {
                'col-pr':       prNumberCol(),
                'col-ts-order': tsOrderCol(),
                'col-blocking': sumCol('Blocking', 'payload.findings_blocking'),
                'col-major':    sumCol('Major',    'payload.findings_major'),
                'col-minor':    sumCol('Minor',    'payload.findings_minor'),
                'col-nit':      sumCol('Nit',      'payload.findings_nit'),
              },
              incompleteColumns: {},
            },
          },
        },
      },
      filters: eventTypeFilter('pr_review_completed'),
      query: { language: 'kuery', query: '' },
      visualization: {
        axisTitlesVisibilitySettings: { x: true, yLeft: true, yRight: false },
        yTitle: 'Findings', xTitle: 'PR Tag',
        fittingFunction: 'None',
        gridlinesVisibilitySettings: { x: true, yLeft: true, yRight: false },
        labelsOrientation: { x: 0, yLeft: 0, yRight: 0 },
        layers: [{
          accessors: ['col-blocking', 'col-major', 'col-minor', 'col-nit'],
          layerId: 'layer1', layerType: 'data', seriesType: 'bar_stacked',
          xAccessor: 'col-pr',
          yConfig: [
            { forAccessor: 'col-blocking', axisMode: 'left', color: '#0f62fe' }, // IBM Blue 60
            { forAccessor: 'col-major',    axisMode: 'left', color: '#4589ff' }, // IBM Blue 50
            { forAccessor: 'col-minor',    axisMode: 'left', color: '#78a9ff' }, // IBM Blue 40
            { forAccessor: 'col-nit',      axisMode: 'left', color: '#a6c8ff' }, // IBM Blue 30
          ],
        }],
        legend: { isVisible: true, position: 'right' },
        preferredSeriesType: 'bar_stacked',
        tickLabelsVisibilitySettings: { x: true, yLeft: true, yRight: false },
        valueLabels: 'hide',
      },
    },
  }, dvRef('indexpattern-datasource-layer-layer1'));

  // ── lens-006: Carbon vs Non-Carbon Issue Detection ──────────────────────────
  // X = PR number, Y = Findings, series = Carbon / Non-Carbon
  await create('lens', 'lens-006', {
    title: 'Carbon vs Non-Carbon Issue Detection',
    visualizationType: 'lnsXY',
    state: {
      datasourceStates: {
        formBased: {
          layers: {
            layer1: {
              columnOrder: ['col-pr', 'col-ts-order', 'col-carbon', 'col-noncarbbon'],
              columns: {
                'col-pr':        prNumberCol(),
                'col-ts-order':  tsOrderCol(),
                'col-carbon':    sumCol('Carbon Findings',     'payload.cat1_findings'),
                'col-noncarbbon': sumCol('Non-Carbon Findings', 'payload.cat2_findings'),
              },
              incompleteColumns: {},
            },
          },
        },
      },
      filters: eventTypeFilter('pr_review_completed'),
      query: { language: 'kuery', query: '' },
      visualization: xyViz({
        seriesType: 'bar_stacked',
        layerId: 'layer1',
        xAccessor: 'col-pr',
        accessors: ['col-carbon', 'col-noncarbbon'],
        xTitle: 'PR Tag',
        yLeftTitle: 'Findings',
        legend: { isVisible: true, position: 'right' },
      }),
    },
  }, dvRef('indexpattern-datasource-layer-layer1'));

  // ── lens-008: Token Cost — Input & Output per PR ────────────────────────────
  // Grouped bar chart — each PR gets two side-by-side bars (input / output).
  // Bar is intentional: each PR is independent, no trend is implied.
  await create('lens', 'lens-008', {
    title: 'Token Cost — Input & Output per PR',
    visualizationType: 'lnsXY',
    state: {
      datasourceStates: {
        formBased: {
          layers: {
            layer1: {
              columnOrder: ['col-pr', 'col-ts-order', 'col-input', 'col-output'],
              columns: {
                'col-pr':       prNumberCol(),
                'col-ts-order': tsOrderCol(),
                'col-input':    sumCol('Input Tokens',  'payload.token_input'),
                'col-output':   sumCol('Output Tokens', 'payload.token_output'),
              },
              incompleteColumns: {},
            },
          },
        },
      },
      filters: eventTypeFilter('pr_review_completed'),
      query: { language: 'kuery', query: '' },
      visualization: {
        axisTitlesVisibilitySettings: { x: true, yLeft: true, yRight: false },
        yTitle: 'Token Count', xTitle: 'Carbon PR',
        fittingFunction: 'None',
        gridlinesVisibilitySettings: { x: true, yLeft: true, yRight: false },
        labelsOrientation: { x: -30, yLeft: 0, yRight: 0 },
        layers: [{ accessors: ['col-input', 'col-output'], layerId: 'layer1', layerType: 'data',
          seriesType: 'bar', xAccessor: 'col-pr',
          yConfig: [{ forAccessor:'col-input', axisMode:'left' }, { forAccessor:'col-output', axisMode:'left' }],
        }],
        legend: { isVisible: true, position: 'right', showSingleSeries: true },
        preferredSeriesType: 'bar',
        tickLabelsVisibilitySettings: { x: true, yLeft: true, yRight: false },
        valueLabels: 'hide',
      },
    },
  }, dvRef('indexpattern-datasource-layer-layer1'));

  // ── lens-010: Token Cost — Total Tokens per PR ──────────────────────────────
  // Single bar per PR — total = input + output.
  await create('lens', 'lens-010', {
    title: 'Token Cost — Total Tokens per PR',
    visualizationType: 'lnsXY',
    state: {
      datasourceStates: {
        formBased: {
          layers: {
            layer1: {
              columnOrder: ['col-pr', 'col-ts-order', 'col-total'],
              columns: {
                'col-pr':       prNumberCol(),
                'col-ts-order': tsOrderCol(),
                'col-total':    sumCol('Total Tokens', 'payload.token_total'),
              },
              incompleteColumns: {},
            },
          },
        },
      },
      filters: eventTypeFilter('pr_review_completed'),
      query: { language: 'kuery', query: '' },
      visualization: {
        axisTitlesVisibilitySettings: { x: true, yLeft: true, yRight: false },
        yTitle: 'Token Count', xTitle: 'Carbon PR',
        fittingFunction: 'None',
        gridlinesVisibilitySettings: { x: true, yLeft: true, yRight: false },
        labelsOrientation: { x: -30, yLeft: 0, yRight: 0 },
        layers: [{ accessors: ['col-total'], layerId: 'layer1', layerType: 'data',
          seriesType: 'bar', xAccessor: 'col-pr',
          yConfig: [{ forAccessor:'col-total', axisMode:'left' }],
        }],
        legend: { isVisible: true, position: 'right', showSingleSeries: true },
        preferredSeriesType: 'bar',
        tickLabelsVisibilitySettings: { x: true, yLeft: true, yRight: false },
        valueLabels: 'hide',
      },
    },
  }, dvRef('indexpattern-datasource-layer-layer1'));
}

// ── Register ALL runtime fields in a single POST ──────────────────────────────
// IMPORTANT: always register both fields together — a single POST to
// /api/data_views/data_view/:id overwrites the entire runtimeFieldMap.
// Sending them separately causes the second call to wipe the first.
//
// To add a new PR mapping: add an 'else if' line to prLabelScript below,
// then run:  node scripts/rebuild-dashboard.js
async function registerRuntimeFields() {
  // pr_label — test repo PR# → Carbon PR last-3-digit label
  // Add new entries here as more PRs are reviewed against the Carbon repo.
  const prLabelScript = `
    long n = doc['pr_number'].value;
    if      (n == 157) { emit('#864'); }
    else if (n == 156) { emit('#855'); }
    else if (n == 155) { emit('#867'); }
    else if (n == 154) { emit('#872'); }
    else if (n == 152) { emit('#887'); }
    else if (n == 145) { emit('#773'); }
    else if (n == 144) { emit('#759'); }
    else if (n == 143) { emit('#760'); }
    else if (n == 142) { emit('#777'); }
    else               { emit('#' + n); }
  `.trim();

  // payload.recommendation_label — friendly donut slice labels
  const recLabelScript = `
    def raw = doc['payload.recommendation.keyword'].size() > 0
      ? doc['payload.recommendation.keyword'].value : '';
    if (raw == 'looks-good') { emit('No Intervention Needed'); }
    else if (raw == 'suggested-improvements') { emit('AI Suggested Improvements'); }
    else if (raw == 'consider-revising') { emit('Significant Rework Required'); }
    else { emit(raw); }
  `.trim();

  const r = await kReq('POST', `/api/data_views/data_view/${DV_ID}`, {
    data_view: {
      runtimeFieldMap: {
        'pr_label':                     { type: 'keyword', script: { source: prLabelScript  } },
        'payload.recommendation_label': { type: 'keyword', script: { source: recLabelScript } },
      },
    },
  });
  if (r.status === 200) {
    console.log('  ✅ Runtime fields registered (pr_label + payload.recommendation_label)');
  } else {
    console.warn('  ⚠️  Runtime field registration returned', r.status, JSON.stringify(r.body).slice(0, 200));
  }
}

// ── Build the dashboard ───────────────────────────────────────────────────────
async function buildDashboard() {
  // 6 panels — lens-002, lens-003, lens-007, lens-009 removed
  const panels = [
    { i:'p1', x:0,  y:0,  w:48, h:10, id:'lens-001', title:'PRs AI Reviewed per Day' },
    { i:'p4', x:0,  y:10, w:48, h:10, id:'lens-004', title:'AI Recommendation Summary' },
    { i:'p5', x:0,  y:20, w:24, h:12, id:'lens-005', title:'Findings by Severity' },
    { i:'p6', x:24, y:20, w:24, h:12, id:'lens-006', title:'Carbon vs Non-Carbon Issue Detection' },
    { i:'p8', x:0,  y:32, w:24, h:10, id:'lens-008', title:'Token Cost — Input & Output per PR' },
    { i:'p10',x:24, y:32, w:24, h:10, id:'lens-010', title:'Token Cost — Total Tokens per PR' },
  ];

  const panelsJSON = JSON.stringify(panels.map(p => ({
    version: '8.15.0',
    type: 'lens',
    gridData: { x: p.x, y: p.y, w: p.w, h: p.h, i: p.i },
    panelIndex: p.i,
    embeddableConfig: { enhancements: {} },
    panelRefName: p.i,
    title: p.title,
  })));

  const references = [
    { id: DV_ID, name: 'indexpattern-datasource-layer-throughput', type: 'index-pattern' },
    ...panels.map(p => ({ id: p.id, name: p.i, type: 'lens' })),
  ];

  await create('dashboard', 'carbon-monitor-dashboard', {
    title: 'Carbon Monitor — PR Review Metrics',
    description: 'Review throughput, finding quality, Carbon vs Non-Carbon issue detection, agent reliability, token cost, recommendation distribution.',
    panelsJSON,
    optionsJSON: JSON.stringify({ useMargins: true, syncColors: false, syncCursor: true, syncTooltips: false, hidePanelTitles: false }),
    kibanaSavedObjectMeta: { searchSourceJSON: JSON.stringify({ query: { query: '', language: 'kuery' }, filter: [] }) },
    refreshInterval: { pause: true, value: 0 },
    timeFrom: 'now-30d',
    timeTo: 'now',
    timeRestore: true,
    version: 1,
  }, references);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n── Carbon Monitor — Rebuild Kibana Dashboard ────────────────\n');

  const status = await kReq('GET', '/api/status', null);
  if (status.status !== 200) {
    console.error('❌ Cannot reach Kibana at localhost:5601. Is it running?');
    process.exit(1);
  }
  console.log(`✅ Kibana ${status.body?.version?.number} reachable\n`);

  console.log('Deleting stale objects...');
  // Delete all lens IDs we have ever used (including lens-010 new one)
  for (let i = 1; i <= 10; i++) {
    await del('lens', `lens-0${String(i).padStart(2, '0')}`);
  }
  await del('dashboard', 'carbon-monitor-dashboard');
  console.log();

  console.log('Registering runtime fields...');
  await registerRuntimeFields();
  console.log();

  console.log('Creating Lens visualisations...');
  await buildLensObjects();
  console.log();

  console.log('Creating dashboard...');
  await buildDashboard();

  const now = new Date();
  const from = new Date(now - 30 * 86400e3).toISOString();
  console.log(`
✅ Done. Open:
   http://localhost:5601/app/dashboards#/view/carbon-monitor-dashboard?_g=(filters:!(),refreshInterval:(pause:!t,value:0),time:(from:'${from}',to:'${now.toISOString()}'))
`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
