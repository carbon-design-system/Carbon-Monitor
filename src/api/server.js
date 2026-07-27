/******************************************************************************
 * Carbon PR Review Agent - API Server
 * 
 * Provides REST API endpoints for managing the review agent, including:
 * - Token refresh for Carbon MCP integration
 * - Health checks
 * - Configuration management
 * - Manual review triggers
 *****************************************************************************/

const http = require('http');
const { URL } = require('url');
const { refreshMcpToken, getMcpStatus } = require('./tokenManager');
const { reviewPRs } = require('../index');

// Configuration
const PORT = process.env.API_PORT || 3000;
const API_SECRET = process.env.API_SECRET || '';
const ENABLE_AUTH = process.env.API_ENABLE_AUTH !== 'false';

/**
 * Verify API authentication
 */
function verifyAuth(req) {
  if (!ENABLE_AUTH) {
    return true;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return false;
  }

  const token = authHeader.replace('Bearer ', '');
  return token === API_SECRET;
}

/**
 * Send JSON response
 */
function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data, null, 2));
}

/**
 * Send error response
 */
function sendError(res, statusCode, message) {
  sendJSON(res, statusCode, {
    error: message,
    timestamp: new Date().toISOString()
  });
}

/**
 * Handle POST /api/mcp/refresh
 * Refresh Carbon MCP token configuration
 */
async function handleMcpRefresh(req, res) {
  try {
    // Parse request body
    let body = '';
    for await (const chunk of req) {
      body += chunk.toString();
    }

    const data = body ? JSON.parse(body) : {};
    const { agent = 'bob', token, sessionId, repos } = data;

    // Validate input
    if (!token) {
      return sendError(res, 400, 'Missing required field: token');
    }

    // Refresh token
    const result = await refreshMcpToken({
      agent,
      token,
      sessionId,
      repos
    });

    sendJSON(res, 200, {
      success: true,
      message: 'Carbon MCP token refreshed successfully',
      agent,
      timestamp: new Date().toISOString(),
      ...result
    });

  } catch (error) {
    console.error('Error refreshing MCP token:', error);
    sendError(res, 500, error.message);
  }
}

/**
 * Handle GET /api/mcp/status
 * Get current MCP configuration status
 */
async function handleMcpStatus(req, res) {
  try {
    const status = await getMcpStatus();
    sendJSON(res, 200, {
      success: true,
      ...status,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error getting MCP status:', error);
    sendError(res, 500, error.message);
  }
}

/**
 * Handle POST /api/review/trigger
 * Manually trigger a PR review run
 */
async function handleReviewTrigger(req, res) {
  try {
    // Send immediate response
    sendJSON(res, 202, {
      success: true,
      message: 'Review triggered, running in background',
      timestamp: new Date().toISOString()
    });

    // Run review in background
    reviewPRs().catch(error => {
      console.error('Background review error:', error);
    });

  } catch (error) {
    console.error('Error triggering review:', error);
    sendError(res, 500, error.message);
  }
}

/**
 * Handle GET /api/health
 * Health check endpoint
 */
function handleHealth(req, res) {
  sendJSON(res, 200, {
    status: 'healthy',
    service: 'carbon-pr-review-agent',
    version: require('../../package.json').version,
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
}

/**
 * Handle GET /api/config
 * Get current configuration (sanitized)
 */
function handleConfig(req, res) {
  const config = {
    agent: process.env.GITHUB_AI_AGENT_CLI || 'bob',
    owner: process.env.GITHUB_AI_AGENT_OWNER || 'carbon-design-system',
    repo: process.env.GITHUB_AI_AGENT_REPO || 'carbon',
    label: process.env.GITHUB_AI_AGENT_REVIEW_LABEL || 'AIReviewed',
    maxPRs: parseInt(process.env.GITHUB_AI_AGENT_MAX_PRS || '5'),
    daysBack: parseInt(process.env.GITHUB_AI_AGENT_DAYS_BACK || '21'),
    postInlineComments: process.env.GITHUB_AI_AGENT_POST_INLINE_COMMENTS !== 'false',
    postSummaryComment: process.env.GITHUB_AI_AGENT_POST_SUMMARY_COMMENT !== 'false'
  };

  sendJSON(res, 200, {
    success: true,
    config,
    timestamp: new Date().toISOString()
  });
}

/**
 * Main request handler
 */
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method;

  console.log(`${method} ${path}`);

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Handle OPTIONS for CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check (no auth required)
  if (path === '/api/health' && method === 'GET') {
    return handleHealth(req, res);
  }

  // Verify authentication for protected endpoints
  if (ENABLE_AUTH && !verifyAuth(req)) {
    return sendError(res, 401, 'Unauthorized: Invalid or missing API token');
  }

  // Route requests
  try {
    if (path === '/api/mcp/refresh' && method === 'POST') {
      await handleMcpRefresh(req, res);
    } else if (path === '/api/mcp/status' && method === 'GET') {
      await handleMcpStatus(req, res);
    } else if (path === '/api/review/trigger' && method === 'POST') {
      await handleReviewTrigger(req, res);
    } else if (path === '/api/config' && method === 'GET') {
      await handleConfig(req, res);
    } else {
      sendError(res, 404, 'Not found');
    }
  } catch (error) {
    console.error('Request handler error:', error);
    sendError(res, 500, 'Internal server error');
  }
}

/**
 * Start the API server
 */
function startServer() {
  const server = http.createServer(handleRequest);

  server.listen(PORT, () => {
    console.log(`\n${'='.repeat(60)}`);
    console.log('🚀 Carbon PR Review Agent API Server');
    console.log(`${'='.repeat(60)}`);
    console.log(`📡 Listening on: http://localhost:${PORT}`);
    console.log(`🔒 Authentication: ${ENABLE_AUTH ? 'Enabled' : 'Disabled'}`);
    console.log(`\nAvailable endpoints:`);
    console.log(`  GET  /api/health          - Health check`);
    console.log(`  GET  /api/config          - Get configuration`);
    console.log(`  GET  /api/mcp/status      - Get MCP status`);
    console.log(`  POST /api/mcp/refresh     - Refresh MCP token`);
    console.log(`  POST /api/review/trigger  - Trigger manual review`);
    console.log(`${'='.repeat(60)}\n`);
  });

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully...');
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  });

  return server;
}

// Export for module usage
module.exports = { startServer, handleRequest };

// Run if executed directly
if (require.main === module) {
  startServer();
}

// Made with Bob