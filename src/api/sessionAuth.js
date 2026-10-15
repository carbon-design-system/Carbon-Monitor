/******************************************************************************
 * Console Session Authentication
 *
 * Ported from Carbon Migrate's agent-dispatcher (src/middleware/auth.js). The
 * operator signs in with CONSOLE_USERNAME / CONSOLE_PASSWORD — credentials
 * dedicated to this console and kept separate from the Elasticsearch (ES_*)
 * account, so the two are never coupled.
 *
 * A stateless HMAC-signed token in an HttpOnly cookie — no session store, which
 * matters because Code Engine may run several instances and scale to zero. Any
 * instance can verify a token minted by any other, and a restart does not sign
 * everyone out (provided a stable signing key is configured).
 *
 * ── Deliberate divergence from the original ─────────────────────────────────
 * Carbon Migrate's verifyToken checks only the HMAC and never reads back the
 * timestamp it signed, so its 8-hour limit is enforced solely by the browser's
 * cookie Max-Age — a copied token stays valid forever. This port validates the
 * age server-side as well. The token format is unchanged.
 *****************************************************************************/

const crypto = require('crypto');

const COOKIE_NAME = 'cm_session';
const SESSION_MAX_AGE_SECONDS = Number(
  process.env.SESSION_MAX_AGE_SECONDS || 8 * 60 * 60
);

/** Where a locked-out operator is told to request access to Carbon Monitor. */
const ACCESS_CONTACT_EMAIL = (process.env.CONSOLE_CONTACT_EMAIL || '').trim() || null;

/**
 * Feature flag: whether the console requires a sign-in.
 *
 * OFF BY DEFAULT, everywhere — including production. The default deployment is
 * open, and the password-protected console is opt-in via AUTH_REQUIRED. This is
 * deliberately NOT keyed to NODE_ENV: inferring a security posture from an
 * unrelated variable is how a deployment ends up in a state nobody chose.
 *
 * Because the default is off, the dangerous mistake is now a typo while turning
 * it ON — AUTH_REQUIRED=1 silently leaving the console open when the operator
 * believes it is protected. So the common spellings are accepted and anything
 * unrecognised is reported loudly rather than quietly treated as false.
 */
function readAuthFlag(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { enabled: false, recognized: true };
  }
  const value = String(raw).trim().toLowerCase();
  if (['true', '1', 'yes', 'on', 'enabled'].includes(value)) {
    return { enabled: true, recognized: true };
  }
  if (['false', '0', 'no', 'off', 'disabled'].includes(value)) {
    return { enabled: false, recognized: true };
  }
  return { enabled: false, recognized: false };
}

const AUTH_FLAG = readAuthFlag(process.env.AUTH_REQUIRED);
const AUTH_REQUIRED = AUTH_FLAG.enabled;

if (!AUTH_FLAG.recognized) {
  console.warn(
    `[api/sessionAuth] WARNING: AUTH_REQUIRED="${process.env.AUTH_REQUIRED}" is not a ` +
      'recognised boolean. The console is running WITHOUT sign-in. Use ' +
      'AUTH_REQUIRED=true to require one.'
  );
}

// Sign-in is on but unusable without credentials to check against — worth saying
// at startup rather than letting every attempt fail with a 503.
if (AUTH_REQUIRED && !(process.env.CONSOLE_USERNAME && process.env.CONSOLE_PASSWORD)) {
  console.warn(
    '[api/sessionAuth] WARNING: AUTH_REQUIRED is set but CONSOLE_USERNAME/CONSOLE_PASSWORD ' +
      'are not — nobody will be able to sign in.'
  );
}

/** Secure cookies require HTTPS, which is what Code Engine terminates. */
const IS_SECURE = process.env.NODE_ENV === 'production';

/**
 * Per-process fallback signing key.
 *
 * Generated rather than hardcoded: a checked-in fallback would let anyone forge
 * a session against any deployment that forgot to set a key. The cost is that
 * sessions do not survive a restart, and instances do not share them — so
 * SESSION_SIGNING_KEY should be set in any real deployment.
 */
const EPHEMERAL_KEY = crypto.randomBytes(32).toString('hex');

function getSigningKey() {
  return process.env.SESSION_SIGNING_KEY || process.env.API_SECRET || EPHEMERAL_KEY;
}

// ── Token helpers ───────────────────────────────────────────────────────────

/** Mint a signed session token carrying its own issue time. */
function makeToken() {
  const id = crypto.randomBytes(16).toString('hex');
  const ts = Date.now().toString();
  const mac = crypto
    .createHmac('sha256', getSigningKey())
    .update(`${id}:${ts}`)
    .digest('hex');
  return Buffer.from(`${id}:${ts}:${mac}`).toString('base64url');
}

/**
 * Verify a session token's signature and age.
 * @returns {boolean} True only for an authentic, unexpired token
 */
function verifyToken(token) {
  if (!token) return false;
  try {
    const parts = Buffer.from(token, 'base64url').toString('ascii').split(':');
    if (parts.length !== 3) return false;

    const [id, ts, mac] = parts;
    const expected = crypto
      .createHmac('sha256', getSigningKey())
      .update(`${id}:${ts}`)
      .digest('hex');

    const macBuf = Buffer.from(mac, 'hex');
    const expectedBuf = Buffer.from(expected, 'hex');

    // timingSafeEqual requires equal lengths — HMAC-SHA256 is always 32 bytes.
    if (macBuf.length !== expectedBuf.length || macBuf.length === 0) return false;
    if (!crypto.timingSafeEqual(macBuf, expectedBuf)) return false;

    // Signature is authentic; now enforce the lifetime it claims. Checked after
    // the HMAC so an attacker cannot probe issue times with forged tokens.
    const issuedAt = Number(ts);
    if (!Number.isFinite(issuedAt)) return false;
    const ageSeconds = (Date.now() - issuedAt) / 1000;
    return ageSeconds >= 0 && ageSeconds < SESSION_MAX_AGE_SECONDS;
  } catch {
    return false;
  }
}

// ── Cookie helpers ──────────────────────────────────────────────────────────

/** Parse the request's Cookie header into an object. */
function parseCookies(req) {
  const header = req.headers.cookie ?? '';
  const result = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    try {
      result[key] = decodeURIComponent(val);
    } catch {
      result[key] = val;
    }
  }
  return result;
}

function setSessionCookie(res, token) {
  const parts = [
    `${COOKIE_NAME}=${token}`,
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
  ];
  if (IS_SECURE) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/`
  );
}

// ── Credential comparison ───────────────────────────────────────────────────

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Validate operator credentials and issue a session cookie.
 *
 * @param {Object} res - Response to attach the cookie to
 * @param {Object} credentials - { username, password }
 * @returns {{ok: boolean, status: number, body: Object}}
 */
function login(res, { username, password } = {}) {
  const expectedUser = process.env.CONSOLE_USERNAME;
  const expectedPass = process.env.CONSOLE_PASSWORD;

  if (!expectedUser || !expectedPass) {
    return {
      ok: false,
      status: 503,
      body: {
        error:
          'Sign-in is not configured. CONSOLE_USERNAME and CONSOLE_PASSWORD must ' +
          'be set on the server.',
        contact: ACCESS_CONTACT_EMAIL,
      },
    };
  }

  // Both comparisons run before branching so response time does not reveal
  // which field was wrong.
  const userOk = safeEqual(username, expectedUser);
  const passOk = safeEqual(password, expectedPass);

  // One generic message for BOTH a wrong username and a wrong password: saying
  // which was wrong would confirm valid usernames to someone guessing. The
  // contact address rides in its own field so the sign-in page can render it as a
  // mailto link rather than parse it out of the message.
  if (!userOk || !passOk) {
    return {
      ok: false,
      status: 401,
      body: {
        error: 'Username or password is incorrect.',
        contact: ACCESS_CONTACT_EMAIL,
      },
    };
  }

  setSessionCookie(res, makeToken());
  return { ok: true, status: 200, body: { ok: true, username } };
}

/** Clear the session cookie. */
function logout(res) {
  clearSessionCookie(res);
  return { ok: true, status: 200, body: { ok: true } };
}

/** Whether the request carries a valid session (or auth is not enforced). */
function hasValidSession(req) {
  if (!AUTH_REQUIRED) return true;
  return verifyToken(parseCookies(req)[COOKIE_NAME]);
}

/**
 * Report auth state to the console so it knows whether to show the login page.
 */
function status(req) {
  return {
    authRequired: AUTH_REQUIRED,
    authenticated: hasValidSession(req),
    configured: !!(process.env.CONSOLE_USERNAME && process.env.CONSOLE_PASSWORD),
  };
}

module.exports = {
  login,
  logout,
  status,
  hasValidSession,
  verifyToken,
  parseCookies,
  AUTH_REQUIRED,
  COOKIE_NAME,
};
