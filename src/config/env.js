/**
 * env.js — centralised, whitespace-trimmed environment config
 *
 * All credential env vars are passed through readTrimmedString() before
 * reaching any call site. Kubernetes/Code Engine secrets created via CLI
 * --from-literal or copy-pasted YAML can carry trailing newlines or spaces
 * that silently cause 401s. Trimming here means no call site needs to remember.
 *
 * Architecture mirrors carbon-migrate/agent-dispatcher/src/config/env.js.
 */

'use strict';

/**
 * Read an env var and trim surrounding whitespace.
 * Returns '' when the var is absent or empty after trimming.
 */
function readTrimmedString(name) {
  return (process.env[name] || '').trim();
}

/**
 * Produce a safe diagnostic description of a credential value.
 * Never logs the actual value — logs length, whitespace flags, first/last
 * 2 chars, and a SHA-256 prefix so local and deployed secrets can be compared.
 */
function describeCredential(label, value) {
  const { createHash } = require('crypto');
  const raw = process.env[label] || '';
  const trimmed = raw.trim();
  return {
    label,
    length: raw.length,
    trimmedLength: trimmed.length,
    hasLeadingWhitespace:  raw.length > 0 && raw[0] !== trimmed[0],
    hasTrailingWhitespace: raw.length > 0 && raw[raw.length - 1] !== trimmed[trimmed.length - 1],
    hasInnerControlChars:  /[\x00-\x1f\x7f]/.test(trimmed),
    firstChars: trimmed.length >= 2 ? trimmed.slice(0, 2) : trimmed,
    lastChars:  trimmed.length >= 2 ? trimmed.slice(-2)   : trimmed,
    sha256Prefix: trimmed.length > 0
      ? createHash('sha256').update(trimmed).digest('hex').slice(0, 12)
      : '(empty)',
  };
}

const env = {
  es: {
    url:        readTrimmedString('ES_URL'),
    username:   readTrimmedString('ES_USERNAME') || 'elastic',
    password:   readTrimmedString('ES_PASSWORD'),
    caCertPath: readTrimmedString('ES_CA_CERT_PATH'),
    index:      readTrimmedString('ES_INDEX') || 'carbon-monitor-events',
  },
  observability: {
    otlpEndpoint:    readTrimmedString('OTEL_EXPORTER_OTLP_ENDPOINT'),
    retentionDays:   Math.max(90, parseInt(readTrimmedString('EVENTS_RETENTION_DAYS') || '180', 10)),
    logLevel:        readTrimmedString('LOG_LEVEL') || 'info',
  },
};

module.exports = { env, readTrimmedString, describeCredential };
