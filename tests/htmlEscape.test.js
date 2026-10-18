/**
 * The OAuth callback page reflects query parameters and error messages, so
 * every dynamic value must reach the HTML escaped.
 */

process.env.AUTH_REQUIRED = 'false';
process.env.CARBON_MONITOR_SKIP_DOTENV = '1';

const assert = require('assert');
const { handleRequest } = require('../src/api/server');
const mcpConnection = require('../src/api/mcpConnection');

function fakeRes() {
  return {
    statusCode: null,
    body: '',
    headersSent: false,
    setHeader() {},
    writeHead(status) {
      this.statusCode = status;
      this.headersSent = true;
    },
    end(chunk) {
      if (chunk) this.body += chunk;
    },
  };
}

async function get(url) {
  const res = fakeRes();
  await handleRequest(
    { method: 'GET', url, headers: { host: 'localhost' } },
    res
  );
  return res;
}

let failed = 0;
async function test(description, fn) {
  try {
    await fn();
    console.log(`  ✅ ${description}`);
  } catch (err) {
    console.error(`  ❌ ${description}\n     ${err.message}`);
    failed++;
  }
}

async function main() {
  console.log('\n🧱 HTML escaping tests\n');

  await test('error query parameter is escaped on the callback page', async () => {
    const res = await get(
      '/api/mcp/callback?error=%3Cscript%3Ealert(1)%3C%2Fscript%3E'
    );
    assert.strictEqual(res.statusCode, 400);
    assert(res.body.includes('&lt;script&gt;'), 'escaped tag missing');
    assert(!res.body.includes('<script>alert'), 'raw tag reflected');
  });

  await test('quotes and ampersands in the error are escaped', async () => {
    const res = await get(
      '/api/mcp/callback?error=' + encodeURIComponent(`"x" & 'y'`)
    );
    assert(res.body.includes('&quot;x&quot; &amp; &#39;y&#39;'));
  });

  await test('an exception message is escaped on the callback page', async () => {
    const original = mcpConnection.completeAuthorization;
    mcpConnection.completeAuthorization = async () => {
      throw new Error('<img src=x onerror=alert(1)>');
    };
    try {
      const res = await get('/api/mcp/callback?code=c&state=s');
      assert.strictEqual(res.statusCode, 400);
      assert(res.body.includes('&lt;img src=x onerror=alert(1)&gt;'));
      assert(!res.body.includes('<img src=x'), 'raw tag reflected');
    } finally {
      mcpConnection.completeAuthorization = original;
    }
  });

  if (failed) process.exit(1);
  console.log('\nAll HTML escaping tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
