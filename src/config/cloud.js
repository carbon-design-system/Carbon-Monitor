/**
 * cloud.js — IBM Cloud / Code Engine environment detection
 *
 * Mirrors the pattern from carbon-mcp-internal/src/config/cloud.js.
 *
 * Code Engine (Knative) automatically injects four env vars into every
 * running revision. Checking any one of them is sufficient to know the
 * process is running in the cloud rather than a developer laptop or CI.
 *
 *   K_SERVICE          — Knative service name (e.g. "carbon-monitor")
 *   K_REVISION         — Knative revision name
 *   CE_SUBSCRIPTION_ID — Code Engine event-subscription ID
 *   IBM_CE_PROJECT     — Code Engine project name
 *
 * None of these are present in local dev or in standard CI environments,
 * so the check has no false positives in practice.
 */

'use strict';

/**
 * Returns true when the process appears to be running inside IBM Cloud
 * Code Engine (Knative). Used by esClient.js to pick the right TLS
 * fallback and by indexEnv.js to default the index suffix correctly.
 *
 * @returns {boolean}
 */
function isRunningInCloud() {
  return Boolean(
    process.env.K_SERVICE          ||  // Knative service name
    process.env.CE_SUBSCRIPTION_ID ||  // Code Engine subscription
    process.env.IBM_CE_PROJECT     ||  // Code Engine project
    process.env.K_REVISION             // Knative revision
  );
}

/**
 * Path to the OS-managed CA bundle inside a standard Linux container.
 * Used as a TLS fallback when ES_CA_CERT_PATH is absent but the app is
 * running in the cloud (where the IBM Cloud public CA is trusted by default).
 *
 * @returns {string}
 */
function defaultCaPath() {
  return '/etc/ssl/certs/ca-certificates.crt';
}

module.exports = { isRunningInCloud, defaultCaPath };

// Made with Bob
