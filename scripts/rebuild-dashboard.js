#!/usr/bin/env node
/**
 * Rebuilds all 9 Lens panels and the dashboard from scratch using the
 * Kibana Saved Objects API. Deletes stale objects first, then writes
 * correct ones with fully-populated datasourceStates.
 *
 * Usage:  node scripts/rebuild-dashboard.js
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

// ── Shared layer builder ──────────────────────────────────────────────────────
function xyLayer({ seriesType, xField, xInterval, metrics, filters = [] }) {
  const columns = {};
  // X axis — date histogram
  columns[xField] = {
    dataType: 'date', isBucketed: true, label: 'timestamp',
    operationType: 'date_histogram',
    params: { dropPartials: false, includeEmptyRows: true, interval: xInterval },
    scale: 'interval', sourceField: 'timestamp',
  };
  // Y axis metrics
  for (const m of metrics) {
    columns[m.id] = m.col;
  }
  return {
    columnOrder: [xField, ...metrics.map(m => m.id)],
    columns,
    incompleteColumns: {},
  };
}

function countCol(label) {
  // Kibana 8.15 requires sourceField on count operations
  return { dataType: 'number', isBucketed: false, label, operationType: 'count', scale: 'ratio', sourceField: '___records___' };
}
function sumCol(label, field) {
  return { dataType: 'number', isBucketed: false, label, operationType: 'sum', scale: 'ratio', sourceField: field };
}
function avgCol(label, field) {
  return { dataType: 'number', isBucketed: false, label, operationType: 'average', scale: 'ratio', sourceField: field };
}
function filteredCountCol(label, query) {
  // Kibana 8.15 requires sourceField on count operations
  return { dataType: 'number', isBucketed: false, label, operationType: 'count', scale: 'ratio', sourceField: '___records___', filter: { query, language: 'kuery' } };
}

function eventTypeFilter(et) {
  return [{
    $state: { store: 'appState' },
    meta: { alias: null, disabled: false, key: 'event_type', negate: false, params: { query: et }, type: 'phrase' },
    query: { match_phrase: { event_type: et } },
  }];
}

function xyState({ seriesType, layers, filters = [], legend = { isVisible: true, position: 'bottom' } }) {
  return {
    datasourceStates: {
      formBased: { layers },
    },
    filters,
    query: { language: 'kuery', query: '' },
    visualization: {
      axisTitlesVisibilitySettings: { x: true, yLeft: true, yRight: true },
      fittingFunction: 'None',
      gridlinesVisibilitySettings: { x: true, yLeft: true, yRight: true },
      labelsOrientation: { x: 0, yLeft: 0, yRight: 0 },
      layers: Object.entries(layers).map(([layerId, layer]) => ({
        accessors: layer.columnOrder.slice(1),
        layerId,
        layerType: 'data',
        seriesType,
        xAccessor: layer.columnOrder[0],
        yConfig: [],
      })),
      legend,
      preferredSeriesType: seriesType,
      tickLabelsVisibilitySettings: { x: true, yLeft: true, yRight: true },
      valueLabels: 'hide',
    },
  };
}

const dvRef = (name) => [{ id: DV_ID, name, type: 'index-pattern' }];

// ── Build all lens objects ────────────────────────────────────────────────────
async function buildLensObjects() {

  // lens-001: PRs reviewed per day (bar)
  await create('lens', 'lens-001', {
    title: 'PRs Reviewed per Day',
    visualizationType: 'lnsXY',
    state: xyState({
      seriesType: 'bar',
      filters: eventTypeFilter('pr_review_completed'),
      layers: {
        layer1: {
          columnOrder: ['col-date', 'col-count'],
          columns: {
            'col-date': { dataType:'date', isBucketed:true, label:'timestamp', operationType:'date_histogram', params:{dropPartials:false,includeEmptyRows:true,interval:'1d'}, scale:'interval', sourceField:'timestamp' },
            'col-count': countCol('PRs Reviewed'),
          },
          incompleteColumns: {},
        },
      },
      legend: { isVisible: false, position: 'right' },
    }),
  }, dvRef('indexpattern-datasource-layer-layer1'));

  // lens-002: PRs reviewed per week (area)
  await create('lens', 'lens-002', {
    title: 'PRs Reviewed per Week',
    visualizationType: 'lnsXY',
    state: xyState({
      seriesType: 'area',
      filters: eventTypeFilter('pr_review_completed'),
      layers: {
        layer1: {
          columnOrder: ['col-date', 'col-count'],
          columns: {
            'col-date': { dataType:'date', isBucketed:true, label:'timestamp', operationType:'date_histogram', params:{dropPartials:false,includeEmptyRows:true,interval:'1w'}, scale:'interval', sourceField:'timestamp' },
            'col-count': countCol('PRs Reviewed'),
          },
          incompleteColumns: {},
        },
      },
      legend: { isVisible: false, position: 'right' },
    }),
  }, dvRef('indexpattern-datasource-layer-layer1'));

  // lens-003: Total PRs this run — metric tile
  await create('lens', 'lens-003', {
    title: 'Total PRs This Run',
    visualizationType: 'lnsMetric',
    state: {
      datasourceStates: {
        formBased: {
          layers: {
            layer1: {
              columnOrder: ['col-sum'],
              columns: { 'col-sum': sumCol('PRs This Run', 'payload.prs_reviewed') },
              incompleteColumns: {},
            },
          },
        },
      },
      filters: eventTypeFilter('run_completed'),
      query: { language: 'kuery', query: '' },
      visualization: {
        layers: [{
          layerId: 'layer1',
          layerType: 'data',
          metricAccessor: 'col-sum',
        }],
      },
    },
  }, dvRef('indexpattern-datasource-layer-layer1'));

  // lens-004: Recommendation distribution — donut
  await create('lens', 'lens-004', {
    title: 'Recommendation Distribution',
    visualizationType: 'lnsPie',
    state: {
      datasourceStates: {
        formBased: {
          layers: {
            layer1: {
              columnOrder: ['col-rec', 'col-count'],
              columns: {
                'col-rec': { dataType:'string', isBucketed:true, label:'Recommendation', operationType:'terms', params:{missingBucket:false,orderBy:{columnId:'col-count',type:'column'},orderDirection:'desc',otherBucket:true,size:10}, scale:'ordinal', sourceField:'payload.recommendation.keyword' },
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

  // lens-005: Findings by severity stacked bar
  await create('lens', 'lens-005', {
    title: 'Findings per PR — Severity Breakdown',
    visualizationType: 'lnsXY',
    state: xyState({
      seriesType: 'bar_stacked',
      filters: eventTypeFilter('pr_review_completed'),
      layers: {
        layer1: {
          columnOrder: ['col-date', 'col-blocking', 'col-major', 'col-minor', 'col-nit'],
          columns: {
            'col-date': { dataType:'date', isBucketed:true, label:'timestamp', operationType:'date_histogram', params:{dropPartials:false,includeEmptyRows:true,interval:'1d'}, scale:'interval', sourceField:'timestamp' },
            'col-blocking': sumCol('Blocking', 'payload.findings_blocking'),
            'col-major':    sumCol('Major',    'payload.findings_major'),
            'col-minor':    sumCol('Minor',    'payload.findings_minor'),
            'col-nit':      sumCol('Nit',      'payload.findings_nit'),
          },
          incompleteColumns: {},
        },
      },
    }),
  }, dvRef('indexpattern-datasource-layer-layer1'));

  // lens-006: Cat1 vs Cat2 findings stacked bar
  await create('lens', 'lens-006', {
    title: 'Carbon API Verification — Cat1 vs Cat2 Findings',
    visualizationType: 'lnsXY',
    state: xyState({
      seriesType: 'bar_stacked',
      filters: eventTypeFilter('pr_review_completed'),
      layers: {
        layer1: {
          columnOrder: ['col-date', 'col-cat1', 'col-cat2'],
          columns: {
            'col-date': { dataType:'date', isBucketed:true, label:'timestamp', operationType:'date_histogram', params:{dropPartials:false,includeEmptyRows:true,interval:'1d'}, scale:'interval', sourceField:'timestamp' },
            'col-cat1': sumCol('Cat1 (Carbon-specific)', 'payload.cat1_findings'),
            'col-cat2': sumCol('Cat2 (Non-Carbon)',      'payload.cat2_findings'),
          },
          incompleteColumns: {},
        },
      },
    }),
  }, dvRef('indexpattern-datasource-layer-layer1'));

  // lens-007: Agent reliability — catalogue present vs missing
  await create('lens', 'lens-007', {
    title: 'Agent Reliability — Catalogue Present vs Missing',
    visualizationType: 'lnsXY',
    state: xyState({
      seriesType: 'bar_stacked',
      filters: eventTypeFilter('pr_review_completed'),
      layers: {
        layer1: {
          columnOrder: ['col-date', 'col-reliable', 'col-unreliable'],
          columns: {
            'col-date': { dataType:'date', isBucketed:true, label:'timestamp', operationType:'date_histogram', params:{dropPartials:false,includeEmptyRows:true,interval:'1d'}, scale:'interval', sourceField:'timestamp' },
            'col-reliable':   filteredCountCol('Reliable (catalogue present)', 'payload.catalogue_present: true'),
            'col-unreliable': filteredCountCol('Unreliable (no catalogue)',    'payload.catalogue_present: false'),
          },
          incompleteColumns: {},
        },
      },
    }),
  }, dvRef('indexpattern-datasource-layer-layer1'));

  // lens-008: Token cost — avg input & output per day (line)
  await create('lens', 'lens-008', {
    title: 'Token Cost — Avg Input & Output Tokens per Review',
    visualizationType: 'lnsXY',
    state: xyState({
      seriesType: 'line',
      filters: eventTypeFilter('pr_review_completed'),
      layers: {
        layer1: {
          columnOrder: ['col-date', 'col-input', 'col-output'],
          columns: {
            'col-date':   { dataType:'date', isBucketed:true, label:'timestamp', operationType:'date_histogram', params:{dropPartials:false,includeEmptyRows:true,interval:'1d'}, scale:'interval', sourceField:'timestamp' },
            'col-input':  avgCol('Avg Input Tokens',  'payload.token_input'),
            'col-output': avgCol('Avg Output Tokens', 'payload.token_output'),
          },
          incompleteColumns: {},
        },
      },
      legend: { isVisible: true, position: 'right' },
    }),
  }, dvRef('indexpattern-datasource-layer-layer1'));

  // lens-009: Run health — event type distribution (horizontal bar)
  await create('lens', 'lens-009', {
    title: 'Run Health — Event Type Distribution',
    visualizationType: 'lnsXY',
    state: {
      datasourceStates: {
        formBased: {
          layers: {
            layer1: {
              columnOrder: ['col-event', 'col-count'],
              columns: {
                'col-event': { dataType:'string', isBucketed:true, label:'Event Type', operationType:'terms', params:{missingBucket:false,orderBy:{columnId:'col-count',type:'column'},orderDirection:'desc',otherBucket:false,size:20}, scale:'ordinal', sourceField:'event_type.keyword' },
                'col-count': countCol('Count'),
              },
              incompleteColumns: {},
            },
          },
        },
      },
      filters: [],
      query: { language: 'kuery', query: '' },
      visualization: {
        axisTitlesVisibilitySettings: { x: false, yLeft: true, yRight: true },
        fittingFunction: 'None',
        gridlinesVisibilitySettings: { x: true, yLeft: true, yRight: true },
        labelsOrientation: { x: 0, yLeft: 0, yRight: 0 },
        layers: [{ accessors:['col-count'], layerId:'layer1', layerType:'data', seriesType:'bar_horizontal', xAccessor:'col-event', yConfig:[] }],
        legend: { isVisible: false, position: 'right' },
        preferredSeriesType: 'bar_horizontal',
        tickLabelsVisibilitySettings: { x: true, yLeft: true, yRight: true },
        valueLabels: 'show',
      },
    },
  }, dvRef('indexpattern-datasource-layer-layer1'));
}

// ── Build the dashboard ───────────────────────────────────────────────────────
async function buildDashboard() {
  const panels = [
    { i:'p1',  x:0,  y:0,  w:24, h:10, id:'lens-001', title:'PRs Reviewed per Day' },
    { i:'p2',  x:24, y:0,  w:24, h:10, id:'lens-002', title:'PRs Reviewed per Week' },
    { i:'p3',  x:0,  y:10, w:12, h:8,  id:'lens-003', title:'Total PRs This Run' },
    { i:'p4',  x:12, y:10, w:36, h:8,  id:'lens-004', title:'Recommendation Distribution' },
    { i:'p5',  x:0,  y:18, w:16, h:12, id:'lens-005', title:'Findings per PR — Severity' },
    { i:'p6',  x:16, y:18, w:16, h:12, id:'lens-006', title:'Carbon API Verification' },
    { i:'p7',  x:32, y:18, w:16, h:12, id:'lens-007', title:'Agent Reliability' },
    { i:'p8',  x:0,  y:30, w:24, h:10, id:'lens-008', title:'Token Cost' },
    { i:'p9',  x:24, y:30, w:24, h:10, id:'lens-009', title:'Run Health' },
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
    description: 'Review throughput, finding quality, Carbon API verification, agent reliability, token cost, recommendation distribution, run health.',
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

  // Confirm Kibana is reachable
  const status = await kReq('GET', '/api/status', null);
  if (status.status !== 200) {
    console.error('❌ Cannot reach Kibana at localhost:5601. Is it running?');
    process.exit(1);
  }
  console.log(`✅ Kibana ${status.body?.version?.number} reachable\n`);

  console.log('Deleting stale Lens objects...');
  for (let i = 1; i <= 9; i++) await del('lens', `lens-00${i}`);
  await del('dashboard', 'carbon-monitor-dashboard');
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
