'use strict';

const CARBON_MCP_SERVER = 'carbon-mcp';
const CARBON_MCP_TOOLS = [
  'docs_search',
  'code_search',
  'get_charts',
  'labs_search',
  'code_audit',
];

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) =>
      typeof b === 'string' ? b : b && b.type === 'text' ? b.text : ''
    )
    .filter(Boolean)
    .join('');
}

// Carbon MCP tool name for a use_mcp_tool call (or a bare MCP tool call), else null.
function mcpToolName(call) {
  const params = call.params || {};
  const candidate =
    call.name === 'use_mcp_tool' ? params.tool_name || params.name : call.name;
  if (typeof candidate !== 'string') return null;
  return (
    CARBON_MCP_TOOLS.find(
      (t) =>
        candidate === t ||
        candidate.endsWith(`__${t}`) ||
        candidate.endsWith(`/${t}`)
    ) || null
  );
}

// classify(call) returns { skill: true }, { file: path } or nothing.
function summarize(toolCalls = [], classify) {
  const summary = {
    skillInvoked: false,
    skillFiles: [],
    mcpCalls: {},
    total: toolCalls.length,
  };
  for (const call of toolCalls) {
    const hit = classify(call) || {};
    if (hit.skill) {
      summary.skillInvoked = true;
    } else if (hit.file && !summary.skillFiles.includes(hit.file)) {
      summary.skillFiles.push(hit.file);
    }
    const mcp = mcpToolName(call);
    if (mcp) summary.mcpCalls[mcp] = (summary.mcpCalls[mcp] || 0) + 1;
  }
  return summary;
}

module.exports = {
  CARBON_MCP_SERVER,
  CARBON_MCP_TOOLS,
  contentToText,
  mcpToolName,
  summarize,
};
