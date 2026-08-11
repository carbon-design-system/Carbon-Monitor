/**
 * indexEnv.js — Elasticsearch index mode resolver
 *
 * Mirrors the pattern from carbon-mcp-internal/src/config/indexEnv.js.
 *
 * Resolves an index mode string at startup and exposes resolveIndexName(),
 * which appends the correct suffix to every index name so that:
 *
 *   - Production writes go to the bare name (e.g. carbon-monitor-events-YYYY.MM)
 *   - Sandbox / local dev writes go to names suffixed with _sandbox
 *     (e.g. carbon-monitor-events-YYYY.MM_sandbox)
 *
 * Mode resolution order:
 *   1. CARBON_MONITOR_INDEX_MODE env var — explicit override, highest priority
 *   2. NODE_ENV=production → "prod"
 *   3. Hostname contains "sandbox" → "sandbox"
 *   4. Default → "sandbox"   (local dev is safe by default; set
 *      CARBON_MONITOR_INDEX_MODE=prod to write to the real index)
 *
 * This keeps all if/else logic in one place rather than scattered through
 * every index write site.
 */

'use strict';

const os = require('os');

/** @type {'prod'|'sandbox'} */
let _resolvedMode = null;

/**
 * Resolve and cache the index mode for this process lifetime.
 *
 * @returns {'prod'|'sandbox'}
 */
function resolveIndexMode() {
  if (_resolvedMode) return _resolvedMode;

  const explicit = (process.env.CARBON_MONITOR_INDEX_MODE || '').trim().toLowerCase();
  if (explicit === 'prod' || explicit === 'sandbox') {
    _resolvedMode = explicit;
    return _resolvedMode;
  }

  if (process.env.NODE_ENV === 'production') {
    _resolvedMode = 'prod';
    return _resolvedMode;
  }

  const hostname = os.hostname().toLowerCase();
  if (hostname.includes('sandbox')) {
    _resolvedMode = 'sandbox';
    return _resolvedMode;
  }

  // Default: sandbox — safe for local dev and CI.
  _resolvedMode = 'sandbox';
  return _resolvedMode;
}

/**
 * Apply the resolved index mode suffix to a base index name.
 *
 *   resolveIndexName('carbon-monitor-events-2025.06')
 *   → 'carbon-monitor-events-2025.06'          (prod)
 *   → 'carbon-monitor-events-2025.06_sandbox'  (sandbox)
 *
 * @param {string} baseName
 * @returns {string}
 */
function resolveIndexName(baseName) {
  const mode = resolveIndexMode();
  if (mode === 'prod') return baseName;
  return `${baseName}_${mode}`;
}

// Log the resolved mode once at module load time so it is visible in
// startup output and in Code Engine log streams.
const _mode = resolveIndexMode();
console.log(`[indexEnv] Index mode: ${_mode} (set CARBON_MONITOR_INDEX_MODE=prod to write to production index)`);

module.exports = { resolveIndexMode, resolveIndexName };

// Made with Bob
