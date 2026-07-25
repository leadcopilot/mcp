// Spawn the meta-ads-mcp server with the org's live token and list its tools.
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { getMetaConnection } = require('../lib/connections');

(async () => {
  const conn = await getMetaConnection('9a9778d7-c9b7-46d5-8788-9d36e7ac3f8a');
  const transport = new StdioClientTransport({
    command: 'python',
    args: ['-m', 'meta_ads_mcp'],
    env: {
      ...process.env,
      META_APP_ID: process.env.META_APP_ID,
      META_APP_SECRET: process.env.META_APP_SECRET,
      META_ACCESS_TOKEN: conn.access_token,
    },
  });
  const client = new Client({ name: 'leadpilot', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  const { tools } = await client.listTools();
  console.log('TOOL COUNT:', tools.length);
  console.log(tools.map((t) => t.name).join(', '));
  await client.close();
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
