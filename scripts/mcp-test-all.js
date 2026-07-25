// Broader validation: more read tools + a real create_campaign (PAUSED) that is
// deleted afterwards. One reused MCP connection.
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { getMetaConnection } = require('../lib/connections');

const ORG = '9a9778d7-c9b7-46d5-8788-9d36e7ac3f8a';

async function call(client, name, args) {
  try {
    const r = await client.callTool({ name, arguments: args });
    const txt = (r.content?.[0]?.text || JSON.stringify(r)).replace(/\s+/g, ' ');
    const isErr = r.isError || /"error"|validation error|unsupported|invalid_/i.test(txt.slice(0, 90));
    console.log(`${isErr ? 'FAIL' : 'PASS'}  ${name} -> ${txt.slice(0, 75)}`);
    return { ok: !isErr, txt };
  } catch (e) {
    console.log(`FAIL  ${name} -> ${e.message.slice(0, 75)}`);
    return { ok: false, txt: e.message };
  }
}

(async () => {
  const c = await getMetaConnection(ORG);
  const at = c.access_token, acct = c.ad_account_id;
  const transport = new StdioClientTransport({
    command: 'python', args: ['-m', 'meta_ads_mcp'],
    env: { ...process.env, META_APP_ID: process.env.META_APP_ID, META_APP_SECRET: process.env.META_APP_SECRET, META_ACCESS_TOKEN: at },
  });
  const client = new Client({ name: 'leadpilot', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);

  console.log('--- more READ tools ---');
  await call(client, 'search_behaviors', { access_token: at, query: 'shopping' });
  await call(client, 'search_demographics', { access_token: at, query: 'parents' });
  await call(client, 'search_pages_by_name', { access_token: at, query: 'nike' });
  await call(client, 'get_login_link', { access_token: at });
  const camps = await call(client, 'get_campaigns', { access_token: at, account_id: acct });
  let cid = null;
  try { cid = JSON.parse(camps.txt.replace(/^[^{]*/, '')).data?.[0]?.id; } catch {}
  if (cid) await call(client, 'get_campaign_details', { access_token: at, campaign_id: cid });

  console.log('--- WRITE: create a PAUSED test campaign, then delete it ---');
  const created = await call(client, 'create_campaign', {
    access_token: at, account_id: acct, name: 'LeadPilot MCP Test (auto-delete)',
    objective: 'OUTCOME_TRAFFIC', status: 'PAUSED', special_ad_categories: [],
  });
  let newId = null;
  try { newId = JSON.parse(created.txt.replace(/^[^{]*/, '')).id; } catch {}
  if (newId) {
    console.log('  created campaign id:', newId, '-> cleaning up');
    await call(client, 'update_campaign', { access_token: at, campaign_id: newId, status: 'DELETED' });
  }

  await client.close();
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
