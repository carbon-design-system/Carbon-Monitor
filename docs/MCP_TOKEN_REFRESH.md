# Carbon MCP Token Refresh

> Manual fallback. The console's **Sign in with IBMid** flow and unattended refresh (see [ARCHITECTURE.md §4](ARCHITECTURE.md)) supersede this for normal operation.

## Overview

Carbon Monitor connects to Carbon MCP over streamable HTTP. The connection requires two credentials that expire approximately every 24 hours:

- **Authorization code** — an IBM JWT used in the `Authorization: Bearer` header
- **Session ID** — a unique session identifier used in the `X-MCP-Session` header

Both are obtained from the same place and should be refreshed together.

---

## Getting New Credentials

1. Go to the Carbon MCP portal
2. Select **Auth code and session ID**
3. Copy the **Authorization code** (the long `eyJ...` string)
4. Copy the **Session ID** (the shorter hex string)

---

## Refreshing the Token

### Option 1 — API endpoint (recommended)

Start the API server if it isn't already running:

```bash
npm run api
```

Then call the refresh endpoint with both values:

```bash
curl -X POST http://localhost:3000/api/mcp/refresh \
  -H "Authorization: Bearer YOUR_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "token": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...",
    "sessionId": "4243b156cfdf4095b964dc0ad7f048b9"
  }'
```

Replace `YOUR_API_SECRET` with the `API_SECRET` value from your `.env`.

A successful response looks like:

```json
{
  "success": true,
  "message": "Carbon MCP token refreshed successfully",
  "agent": "bob",
  "configPath": "/Users/you/.bob/settings/mcp.json",
  "updated": true
}
```

This updates `~/.bob/settings/mcp.json` in place — no restart of Carbon Monitor needed.

### Option 2 — Edit the file manually

Open `~/.bob/settings/mcp.json` and replace both values directly:

```json
{
  "mcpServers": {
    "carbon-mcp": {
      "type": "streamable-http",
      "url": "https://mcp.carbondesignsystem.com/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_NEW_JWT",
        "X-MCP-Session": "YOUR_NEW_SESSION_ID"
      }
    }
  }
}
```

---

## Verifying the Connection

After refreshing, open Bob shell and check the live MCP connection status:

```bash
bob
```

Then inside Bob:

```
/mcp list
```

Expected output:

```
carbon-mcp - Ready
```

If it still shows disconnected, double-check that both values were copied in full without extra whitespace.

---

## Checking Current Status

To see whether Carbon MCP is currently configured and connected without refreshing:

```bash
curl http://localhost:3000/api/mcp/status \
  -H "Authorization: Bearer YOUR_API_SECRET"
```

---

## Known Limitation

The refresh endpoint requires you to manually obtain new credentials from the Carbon MCP portal each time. Full automation depends on the Carbon MCP team providing a non-expiring auth mechanism or a programmatic way to fetch new tokens. This is a known gap and a question worth raising with the Carbon MCP team.

---

## Automating Token Refresh (Future Implementation)

If the Carbon MCP portal ever exposes a programmatic way to fetch new credentials (e.g. an API endpoint that accepts a long-lived service credential and returns a fresh JWT and session ID), the full refresh cycle can be automated with a cron job.

### How it would work

1. A cron script runs on a schedule (e.g. every 20 hours, before the 24-hour expiry)
2. It calls the Carbon MCP auth endpoint to obtain a fresh JWT and session ID
3. It calls Carbon Monitor's `POST /api/mcp/refresh` with the new values
4. The connection stays live with no manual intervention

### Example cron script structure

```bash
#!/bin/bash
# refresh-mcp-token.sh
# Run every 20 hours to stay ahead of the 24-hour expiry

# Step 1 — Fetch new credentials from Carbon MCP auth endpoint
# (replace this with the actual auth call once the endpoint is known)
RESPONSE=$(curl -s -X POST https://mcp.carbondesignsystem.com/auth \
  -H "Content-Type: application/json" \
  -d '{"apiKey": "$CARBON_MCP_API_KEY"}')

NEW_TOKEN=$(echo $RESPONSE | jq -r '.token')
NEW_SESSION=$(echo $RESPONSE | jq -r '.sessionId')

# Step 2 — Push new credentials to Carbon Monitor
curl -s -X POST http://localhost:3000/api/mcp/refresh \
  -H "Authorization: Bearer $API_SECRET" \
  -H "Content-Type: application/json" \
  -d "{\"token\": \"$NEW_TOKEN\", \"sessionId\": \"$NEW_SESSION\"}"

echo "MCP token refreshed at $(date)"
```

### Scheduling with cron

```bash
crontab -e

# Run every 20 hours
0 */20 * * * /path/to/refresh-mcp-token.sh >> /var/log/mcp-refresh.log 2>&1
```

### Prerequisites for this to work

- The Carbon MCP team must provide a programmatic auth endpoint
- A long-lived credential (service account API key or similar) that the script can use
- The Carbon Monitor API server must be running continuously (`npm run api`)
- `jq` must be installed for JSON parsing (`brew install jq`)

Until that endpoint exists, manual refresh via the portal remains the only option.
