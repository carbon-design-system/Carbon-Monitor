#!/usr/bin/env node
/**
 * Rebuilds all Lens panels and the dashboard from scratch using the
 * Kibana Saved Objects API. Deletes stale objects first, then writes
 * correct ones with fully-populated datasourceStates.
 *
 * Panels (7 total):
 *   lens-001  PRs Reviewed per Day           (bar)
 *   lens-004  Recommendation Distribution    (donut)
 *   lens-005  Findings per PR — Severity     (stacked bar, shades of blue)
 *   lens-006  Carbon API Verification        (stacked bar)
 *   lens-008  Input & Output Tokens          (line — Input / Output)
 *   lens-009  Run Health                     (horizontal bar)
 *   lens-010  Total Token Usage              (line — Total)
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
const http  = require('http');
const https = require('https');

// ── Config from env ───────────────────────────────────────────────────────────
const KIBANA_URL  = (process.env.KIBANA_URL  || '').trim();
const ES_API_KEY  = (process.env.ES_API_KEY  || '').trim();
const ES_USERNAME = (process.env.ES_USERNAME || 'elastic').trim();
const ES_PASSWORD = (process.env.ES_PASSWORD || '').trim();

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

// API key preferred over basic auth (mirrors esClient.js)
const AUTH_HEADER = ES_API_KEY
  ? `ApiKey ${ES_API_KEY}`
  : `Basic ${Buffer.from(`${ES_USERNAME}:${ES_PASSWORD}`).toString('base64')}`;

const DV_ID = 'carbon-monitor-index-pattern';

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function kReq(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      hostname, port, method, path,
      headers: {
        'Authorization': AUTH_HEADER,
        'kbn-xsrf': 'true',
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      ...(useHttps && (hostname === 'localhost' || hostname === '127.0.0.1')
        ? { rejectUnauthorized: false } : {}),
    };
    const req = transport.request(opts, res => {
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
// label is what shows in legends and tooltips — keep it short and human-readable.
// field is the ES field path — never shown to the user.

function dateCol() {
  return {
    dataType: 'date', isBucketed: true, label: 'Date',
    operationType: 'date_histogram',
    params: { dropPartials: false, includeEmptyRows: true, interval: '1d' },
    scale: 'interval', sourceField: 'timestamp',
  };
}
function countCol(label) {
  return { dataType: 'number', isBucketed: false, label, operationType: 'count', scale: 'ratio', sourceField: '___records___' };
}
function sumCol(label, field) {
  return { dataType: 'number', isBucketed: false, label, customLabel: true, operationType: 'sum', scale: 'ratio', sourceField: field };
}
function avgCol(label, field) {
  return { dataType: 'number', isBucketed: false, label, customLabel: true, operationType: 'average', scale: 'ratio', sourceField: field };
}
function filteredCountCol(label, query) {
  return { dataType: 'number', isBucketed: false, label, operationType: 'count', scale: 'ratio', sourceField: '___records___', filter: { query, language: 'kuery' } };
}

function eventTypeFilter(et) {
  return [{
    $state: { store: 'appState' },
    meta: { alias: null, disabled: false, key: 'event_type', negate: false, params: { query: et }, type: 'phrase' },
    query: { match_phrase: { event_type: et } },
  }];
}

// ── Full XY state builder ─────────────────────────────────────────────────────
// yTitle:  label shown on the left Y axis (replaces the raw field path Kibana
//          would otherwise auto-generate from the column definition)
// xTitle:  label shown on the X axis (default 'Date')
function xyState({ seriesType, layers, filters = [], legend = { isVisible: true, position: 'bottom' }, yTitle = '', xTitle = 'Date', yConfig = [] }) {
  return {
    datasourceStates: { formBased: { layers } },
    filters,
    query: { language: 'kuery', query: '' },
    visualization: {
      axisTitlesVisibilitySettings: { x: true, yLeft: true, yRight: false },
      fittingFunction: 'None',
      gridlinesVisibilitySettings: { x: true, yLeft: true, yRight: true },
      labelsOrientation: { x: 0, yLeft: 0, yRight: 0 },
      layers: Object.entries(layers).map(([layerId, layer]) => ({
        accessors: layer.columnOrder.slice(1),
        layerId,
        layerType: 'data',
        seriesType,
        xAccessor: layer.columnOrder[0],
        yConfig,
      })),
      legend,
      preferredSeriesType: seriesType,
      tickLabelsVisibilitySettings: { x: true, yLeft: true, yRight: true },
      valueLabels: 'hide',
      // Explicit axis titles override the auto-generated "Sum of payload.x" text
      yLeftExtent: { mode: 'full' },
      yTitle,
      xTitle,
    },
  };
}

const dvRef = (name) => [{ id: DV_ID, name, type: 'index-pattern' }];

// ── Build all lens objects ────────────────────────────────────────────────────
async function buildLensObjects() {

  // ── lens-001: PRs reviewed per day (bar) ─────────────────────────────────
  await create('lens', 'lens-001', {
    title: 'PRs AI Reviewed per Day',
    visualizationType: 'lnsXY',
    state: xyState({
      seriesType: 'bar',
      filters: eventTypeFilter('pr_review_completed'),
      layers: {
        layer1: {
          columnOrder: ['col-date', 'col-count'],
          columns: {
            'col-date':  dateCol(),
            'col-count': countCol('PRs Reviewed'),
          },
          incompleteColumns: {},
        },
      },
      legend: { isVisible: false, position: 'right' },
      yTitle: 'PRs Reviewed',
      xTitle: 'Date',
    }),
  }, dvRef('indexpattern-datasource-layer-layer1'));

  // ── lens-004: Recommendation distribution — donut ─────────────────────────
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
                'col-rec':   { dataType:'string', isBucketed:true, label:'Recommendation', operationType:'terms', params:{missingBucket:false,orderBy:{columnId:'col-count',type:'column'},orderDirection:'desc',otherBucket:true,size:10}, scale:'ordinal', sourceField:'payload.recommendation.keyword' },
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

  // ── lens-005: Findings by severity — shades of blue ───────────────────────
  await create('lens', 'lens-005', {
    title: 'Findings per PR — Severity',
    visualizationType: 'lnsXY',
    state: {
      datasourceStates: {
        formBased: {
          layers: {
            layer1: {
              columnOrder: ['col-date', 'col-blocking', 'col-major', 'col-minor', 'col-nit'],
              columns: {
                'col-date':     dateCol(),
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
        fittingFunction: 'None',
        gridlinesVisibilitySettings: { x: true, yLeft: true, yRight: true },
        labelsOrientation: { x: 0, yLeft: 0, yRight: 0 },
        layers: [{
          accessors: ['col-blocking', 'col-major', 'col-minor', 'col-nit'],
          layerId: 'layer1',
          layerType: 'data',
          seriesType: 'bar_stacked',
          xAccessor: 'col-date',
          yConfig: [
            { forAccessor: 'col-blocking', color: '#002d9c' },
            { forAccessor: 'col-major',    color: '#0f62fe' },
            { forAccessor: 'col-minor',    color: '#78a9ff' },
            { forAccessor: 'col-nit',      color: '#d0e2ff' },
          ],
        }],
        legend: { isVisible: true, position: 'bottom' },
        preferredSeriesType: 'bar_stacked',
        tickLabelsVisibilitySettings: { x: true, yLeft: true, yRight: true },
        valueLabels: 'hide',
        yTitle: 'Findings',
        xTitle: 'Date',
      },
    },
  }, dvRef('indexpattern-datasource-layer-layer1'));

  // ── lens-006: Carbon Findings vs General Findings ─────────────────────────
  await create('lens', 'lens-006', {
    title: 'Carbon API Verification',
    visualizationType: 'lnsXY',
    state: xyState({
      seriesType: 'bar_stacked',
      filters: eventTypeFilter('pr_review_completed'),
      layers: {
        layer1: {
          columnOrder: ['col-date', 'col-cat1', 'col-cat2'],
          columns: {
            'col-date': dateCol(),
            'col-cat1': sumCol('Carbon Findings', 'payload.cat1_findings'),
            'col-cat2': sumCol('General Findings', 'payload.cat2_findings'),
          },
          incompleteColumns: {},
        },
      },
      yTitle: 'Findings',
      xTitle: 'Date',
    }),
  }, dvRef('indexpattern-datasource-layer-layer1'));

  // ── lens-008: Input & Output tokens per review (line) ─────────────────────
  await create('lens', 'lens-008', {
    title: 'Input & Output Tokens per Review',
    visualizationType: 'lnsXY',
    state: xyState({
      seriesType: 'line',
      filters: eventTypeFilter('pr_review_completed'),
      layers: {
        layer1: {
          columnOrder: ['col-date', 'col-input', 'col-output'],
          columns: {
            'col-date':   dateCol(),
            'col-input':  avgCol('Input Tokens',  'payload.token_input'),
            'col-output': avgCol('Output Tokens', 'payload.token_output'),
          },
          incompleteColumns: {},
        },
      },
      legend: { isVisible: true, position: 'bottom' },
      yTitle: 'Tokens',
      xTitle: 'Date',
    }),
  }, dvRef('indexpattern-datasource-layer-layer1'));

  // ── lens-009: Run health — event type distribution (horizontal bar) ────────
  await create('lens', 'lens-009', {
    title: 'Run Health — Event Breakdown',
    visualizationType: 'lnsXY',
    state: {
      datasourceStates: {
        formBased: {
          layers: {
            layer1: {
              columnOrder: ['col-pr', 'col-ts-order', 'col-blocking', 'col-major', 'col-minor', 'col-nit'],
              columns: {
                'col-event': { dataType:'string', isBucketed:true, label:'Event', operationType:'terms', params:{missingBucket:false,orderBy:{columnId:'col-count',type:'column'},orderDirection:'desc',otherBucket:false,size:20}, scale:'ordinal', sourceField:'event_type.keyword' },
                'col-count': countCol('Count'),
              },
              incompleteColumns: {},
            },
          },
        },
      },
      filters: eventTypeFilter('pr_review_completed'),
      query: { language: 'kuery', query: '' },
      visualization: {
        axisTitlesVisibilitySettings: { x: false, yLeft: true, yRight: false },
        fittingFunction: 'None',
        gridlinesVisibilitySettings: { x: true, yLeft: true, yRight: false },
        labelsOrientation: { x: 0, yLeft: 0, yRight: 0 },
        layers: [{ accessors:['col-count'], layerId:'layer1', layerType:'data', seriesType:'bar_horizontal', xAccessor:'col-event', yConfig:[] }],
        legend: { isVisible: false, position: 'right' },
        preferredSeriesType: 'bar_horizontal',
        tickLabelsVisibilitySettings: { x: true, yLeft: true, yRight: true },
        valueLabels: 'show',
        yTitle: 'Count',
      },
    },
  }, dvRef('indexpattern-datasource-layer-layer1'));

  // ── lens-010: Total tokens per review (single line) ───────────────────────
  await create('lens', 'lens-010', {
    title: 'Total Token Usage per Review',
    visualizationType: 'lnsXY',
    state: xyState({
      seriesType: 'line',
      filters: eventTypeFilter('pr_review_completed'),
      layers: {
        layer1: {
          columnOrder: ['col-date', 'col-total'],
          columns: {
            'col-date':  dateCol(),
            'col-total': avgCol('Total Tokens', 'payload.token_total'),
          },
          incompleteColumns: {},
        },
      },
      legend: { isVisible: false, position: 'right' },
      yTitle: 'Tokens',
      xTitle: 'Date',
    }),
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
    // Row 1 — throughput (full width)
    { i:'p1', x:0,  y:0,  w:48, h:10, id:'lens-001', title:'PRs Reviewed per Day' },
    // Row 2 — recommendation (full width)
    { i:'p4', x:0,  y:10, w:48, h:10, id:'lens-004', title:'Recommendation Distribution' },
    // Row 3 — finding quality, side by side
    { i:'p5', x:0,  y:20, w:24, h:12, id:'lens-005', title:'Findings per PR — Severity' },
    { i:'p6', x:24, y:20, w:24, h:12, id:'lens-006', title:'Carbon API Verification' },
    // Row 4 — token usage, side by side
    { i:'p8', x:0,  y:32, w:24, h:12, id:'lens-008', title:'Input & Output Tokens per Review' },
    { i:'p10',x:24, y:32, w:24, h:12, id:'lens-010', title:'Total Token Usage per Review' },
    // Row 5 — run health (full width)
    { i:'p9', x:0,  y:44, w:48, h:12, id:'lens-009', title:'Run Health — Event Breakdown' },
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
    description: 'Review throughput, recommendation distribution, finding quality, Carbon API verification, token usage, run health.',
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
    console.error(`❌ Cannot reach Kibana at ${KIBANA_URL}. Is it running?`);
    process.exit(1);
  }
  console.log(`✅ Kibana ${status.body?.version?.number} reachable\n`);

  console.log('Deleting stale Lens objects...');
  for (let i = 1; i <= 9; i++)   await del('lens', `lens-00${i}`);
  for (let i = 10; i <= 13; i++) await del('lens', `lens-0${i}`);
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

  // ISO timestamps inside a RISON string must have : and . percent-encoded,
  // otherwise Kibana's RISON parser throws "missing ':'".
  const now  = new Date();
  const from = new Date(now - 30 * 86400e3).toISOString()
                 .replace(/:/g, '%3A').replace(/\./g, '%2E');
  const to   = now.toISOString()
                 .replace(/:/g, '%3A').replace(/\./g, '%2E');
  console.log(`
✅ Done. Open:
   ${KIBANA_URL}/app/dashboards#/view/carbon-monitor-dashboard?_g=(filters:!(),refreshInterval:(pause:!t,value:0),time:(from:'${from}',to:'${to}'))
`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
