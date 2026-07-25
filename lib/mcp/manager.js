/**
 * Workspace-Aware MCP Manager
 *
 * This is the core of LeadPilot's multi-tenant MCP architecture.
 * Every client (organisation) has their own Meta/Google tokens.
 * When their AI Analyst chat runs a tool — we spawn the MCP server
 * with THEIR specific token. This means 1000 clients can use the
 * same MCP server code but each gets their own isolated data.
 *
 * This is exactly what the LeadPilot blueprint calls:
 * "Workspace-aware MCP proxy — multi-tenant auth over single-account open source tools"
 */

const { spawn } = require('child_process');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { executeMetaTool: executeMetaGraphTool } = require('../services/metaGraph');

// ─── Spawn a Meta MCP server with a specific org's credentials ─────────────

async function createMetaMCPClient(metaToken, adAccountId) {
  // Inject THIS org's token into the MCP server's environment
  // This is the workspace isolation — every org gets their own server instance
  const env = {
    ...process.env,
    META_APP_ID:       process.env.META_APP_ID,
    META_APP_SECRET:   process.env.META_APP_SECRET,
    META_ACCESS_TOKEN: metaToken,
    META_AD_ACCOUNT_ID: adAccountId || '',
  };

  const transport = new StdioClientTransport({
    command: process.env.META_MCP_PYTHON || '/opt/anaconda3/bin/python',
    args:    ['-m', process.env.META_MCP_MODULE || 'meta_ads_mcp'],
    env,
  });

  const client = new Client({ name: 'leadpilot', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);

  return client;
}

// ─── Spawn a Google Ads MCP server with a specific org's credentials ────────

async function createGoogleMCPClient(refreshToken, customerId) {
  const fs   = require('fs');
  const path = require('path');
  const os   = require('os');

  // Write a temporary google-ads.yaml for this org
  // Each org gets their own credentials file — workspace isolation
  const yamlContent = [
    `developer_token: ${process.env.GOOGLE_DEVELOPER_TOKEN}`,
    `client_id: ${process.env.GOOGLE_CLIENT_ID}`,
    `client_secret: ${process.env.GOOGLE_CLIENT_SECRET}`,
    `refresh_token: ${refreshToken}`,
    customerId ? `login_customer_id: ${customerId.replace(/-/g, '')}` : '',
    'use_proto_plus: True',
  ].filter(Boolean).join('\n');

  const tmpFile = path.join(os.tmpdir(), `leadpilot-google-${Date.now()}.yaml`);
  fs.writeFileSync(tmpFile, yamlContent);

  const env = {
    ...process.env,
    GOOGLE_ADS_CONFIGURATION_FILE_PATH: tmpFile,
  };

  const transport = new StdioClientTransport({
    command: process.env.GOOGLE_MCP_PYTHON || '/opt/anaconda3/bin/python',
    args:    [process.env.GOOGLE_MCP_SERVER ||
              '/Users/dheerajkurupati/Desktop/mcp_practice/google-ads-mcp/ads_mcp/server.py'],
    env,
  });

  const client = new Client({ name: 'leadpilot', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);

  // Cleanup temp file after connection (server already read it)
  setTimeout(() => {
    try { fs.unlinkSync(tmpFile); } catch {}
  }, 5000);

  return client;
}

// ─── Execute a tool on the Meta MCP server ──────────────────────────────────

// Meta tools now go through the direct Graph API adapter (no subprocess).
// The broken meta-ads-mcp stdio path (createMetaMCPClient above) is retained
// only for reference and is no longer used.
async function executeMetaTool(toolName, args, metaToken, adAccountId) {
  console.log(`[meta:graph] executing "${toolName}" for account=${adAccountId || 'none'}`);
  const result = await executeMetaGraphTool(toolName, args || {}, metaToken, adAccountId);
  if (!result.success) console.warn(`[meta:graph] "${toolName}" failed: ${result.error}`);
  return result;
}

// ─── Execute a tool on the Google MCP server ────────────────────────────────

async function executeGoogleTool(toolName, args, refreshToken, customerId) {
  let client;
  try {
    console.log(`[mcp:google] executing tool "${toolName}"`);
    client = await createGoogleMCPClient(refreshToken, customerId);

    const result = await client.callTool({ name: toolName, arguments: args });
    const content = result.content?.[0]?.text || JSON.stringify(result);

    console.log(`[mcp:google] tool "${toolName}" returned ${content.length} chars`);
    return { success: true, data: content, isError: result.isError };
  } catch (err) {
    console.error(`[mcp:google] tool "${toolName}" failed:`, err.message);
    return { success: false, error: err.message };
  } finally {
    if (client) {
      try { await client.close(); } catch {}
    }
  }
}

// ─── List available tools from Meta MCP ──────────────────────────────────────

// The tool catalog is static (same for every org/token) — cache it so listing
// doesn't spawn a Python process on every request.
let _toolCache = null;
let _toolCacheAt = 0;
const TOOL_CACHE_TTL = 60 * 60 * 1000;

async function listMetaTools(metaToken, adAccountId) {
  if (_toolCache && Date.now() - _toolCacheAt < TOOL_CACHE_TTL) return _toolCache;
  let client;
  try {
    client = await createMetaMCPClient(metaToken, adAccountId);
    const { tools } = await client.listTools();
    _toolCache = tools.map((t) => ({ name: t.name, description: t.description }));
    _toolCacheAt = Date.now();
    return _toolCache;
  } finally {
    if (client) {
      try { await client.close(); } catch {}
    }
  }
}

// ─── Execute a tool on the meta-ads-mcp server (Tier 2, 37 tools) ───────────
async function executeMetaMcpTool(toolName, args, metaToken, adAccountId) {
  let client;
  try {
    client = await createMetaMCPClient(metaToken, adAccountId);
    const result = await client.callTool({ name: toolName, arguments: args || {} });
    const content = result.content?.[0]?.text || JSON.stringify(result);
    return { success: !result.isError, data: content, error: result.isError ? content : null };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    if (client) { try { await client.close(); } catch {} }
  }
}

module.exports = {
  executeMetaTool,
  executeGoogleTool,
  listMetaTools,
  executeMetaMcpTool,
};
