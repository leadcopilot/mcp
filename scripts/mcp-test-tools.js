// Test a batch of READ-ONLY meta-ads-mcp tools against the live account.
// One persistent MCP connection reused for all calls (no per-call respawn).
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { getMetaConnection } = require('../lib/connections');

(async () => {
  const conn = await getMetaConnection('9a9778d7-c9b7-46d5-8788-9d36e7ac3f8a');
  const at = conn.access_token;
  const acct = conn.ad_account_id;
  const tests = [
    ['get_ad_accounts', { access_token: at }],
    ['get_account_info', { access_token: at, account_id: acct }],
    ['get_campaigns', { access_token: at, account_id: acct }],
    ['get_adsets', { access_token: at, account_id: acct }],
    ['get_ads', { access_token: at, account_id: acct }],
    ['get_ad_creatives', { access_token: at, account_id: acct }],
    ['get_account_pages', { access_token: at, account_id: acct }],
    ['get_insights', { access_token: at, object_id: acct }],
    ['search_interests', { access_token: at, query: 'fitness' }],
    ['get_interest_suggestions', { access_token: at, interest_list: ['Fitness'] }],
    ['search_geo_locations', { access_token: at, query: 'Hyderabad' }],
    ['search_ads_archive', { access_token: at, search_terms: 'gym', ad_reached_countries: ['IN'] }],
  ];

  const transport = new StdioClientTransport({
    command: 'python', args: ['-m', 'meta_ads_mcp'],
    env: { ...process.env, META_APP_ID: process.env.META_APP_ID, META_APP_SECRET: process.env.META_APP_SECRET, META_ACCESS_TOKEN: at },
  });
  const client = new Client({ name: 'leadpilot', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);

  let pass = 0, fail = 0;
  for (const [name, args] of tests) {
    try {
      const r = await client.callTool({ name, arguments: args });
      const txt = (r.content?.[0]?.text || JSON.stringify(r)).replace(/\s+/g, ' ');
      const isErr = r.isError || /"error"|invalid|unsupported|missing|required/i.test(txt.slice(0, 80));
      console.log(`${isErr ? 'FAIL' : 'PASS'}  ${name} -> ${txt.slice(0, 70)}`);
      isErr ? fail++ : pass++;
    } catch (e) {
      console.log(`FAIL  ${name} -> ${e.message.slice(0, 70)}`);
      fail++;
    }
  }
  console.log(`\n${pass}/${tests.length} read tools passed`);
  await client.close();
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
