/**
 * Meta Graph API adapter (replaces the broken meta-ads-mcp subprocess).
 *
 * Exposes the SAME executeMetaTool(toolName, args, accessToken, adAccountId)
 * contract the routes already use — returns { success, data, error } where
 * `data` is a JSON string of the Graph response — but talks to
 * https://graph.facebook.com/v19.0 directly with the org's stored token.
 * This preserves the multi-tenant per-org-token design without any subprocess,
 * package, or tool-name-mismatch problems.
 *
 * NOTE: written to Graph API v19.0 conventions; exercise against a real ad
 * account before relying on write paths. All calls fail gracefully (no crash)
 * when the org has no token / ad account.
 */

const crypto = require('crypto');

const GRAPH = 'https://graph.facebook.com/v19.0';
const TIMEOUT_MS = 20000;

// New-style (ODAX) campaign objectives.
const OBJECTIVE_MAP = {
  LEADS: 'OUTCOME_LEADS', LEAD_GENERATION: 'OUTCOME_LEADS', OUTCOME_LEADS: 'OUTCOME_LEADS',
  TRAFFIC: 'OUTCOME_TRAFFIC', LINK_CLICKS: 'OUTCOME_TRAFFIC', OUTCOME_TRAFFIC: 'OUTCOME_TRAFFIC',
  CONVERSIONS: 'OUTCOME_SALES', SALES: 'OUTCOME_SALES', OUTCOME_SALES: 'OUTCOME_SALES',
  BRAND_AWARENESS: 'OUTCOME_AWARENESS', AWARENESS: 'OUTCOME_AWARENESS', REACH: 'OUTCOME_AWARENESS',
  OUTCOME_AWARENESS: 'OUTCOME_AWARENESS',
  ENGAGEMENT: 'OUTCOME_ENGAGEMENT', OUTCOME_ENGAGEMENT: 'OUTCOME_ENGAGEMENT',
  APP_INSTALLS: 'OUTCOME_APP_PROMOTION', OUTCOME_APP_PROMOTION: 'OUTCOME_APP_PROMOTION',
};
const mapObjective = (o) => OBJECTIVE_MAP[String(o || '').toUpperCase()] || 'OUTCOME_TRAFFIC';

async function graph(method, node, params, token) {
  if (!token) throw new Error('Meta account not connected for this organisation');
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries({ access_token: token, ...params })) {
    if (v === undefined || v === null || v === '') continue;
    form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    let resp;
    if (method === 'GET') {
      resp = await fetch(`${GRAPH}/${node}?${form.toString()}`, { signal: ctrl.signal });
    } else {
      resp = await fetch(`${GRAPH}/${node}`, { method: 'POST', body: form, signal: ctrl.signal });
    }
    const json = await resp.json().catch(() => ({}));
    if (json.error) throw new Error(json.error.error_user_msg || json.error.message || 'Graph API error');
    return json;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Meta Graph API request timed out');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function requireAccount(adAccountId) {
  if (!adAccountId) throw new Error('No Meta ad account on file — reconnect Meta');
  return adAccountId; // already in act_XXXX form
}

// Use the org's first Facebook Page when a creative needs one and none is given.
async function firstPageId(token) {
  const r = await graph('GET', 'me/accounts', { fields: 'id,name', limit: 1 }, token);
  const p = r.data && r.data[0];
  if (!p) throw new Error('No Facebook Page found on this account — a Page is required to build a creative');
  return p.id;
}

// ─── Tool dispatch (same names the routes/AI already call) ──────────────────
async function executeMetaTool(toolName, args = {}, token, adAccountId) {
  try {
    let json;
    switch (toolName) {
      case 'list_campaigns': {
        const act = requireAccount(adAccountId);
        const params = { fields: 'id,name,status,objective,daily_budget,lifetime_budget,effective_status', limit: args.limit || 50 };
        if (args.status_filter && args.status_filter !== 'ALL') params.effective_status = [args.status_filter];
        json = await graph('GET', `${act}/campaigns`, params, token);
        break;
      }
      case 'get_insights': {
        const level = args.level || 'campaign';
        const fields = args.fields || 'campaign_id,campaign_name,spend,impressions,clicks,ctr,cpc,actions,action_values,reach,frequency';
        const node = args.object_id ? `${args.object_id}/insights` : `${requireAccount(adAccountId)}/insights`;
        json = await graph('GET', node, { level, date_preset: args.date_preset || 'last_7d', fields }, token);
        break;
      }
      case 'create_campaign': {
        const act = requireAccount(adAccountId);
        json = await graph('POST', `${act}/campaigns`, {
          name: args.name, objective: mapObjective(args.objective),
          status: args.status || 'PAUSED', special_ad_categories: [],
          daily_budget: args.daily_budget, lifetime_budget: args.lifetime_budget,
        }, token);
        break;
      }
      case 'update_campaign': {
        const fields = {};
        if (args.status) fields.status = args.status;
        if (args.name) fields.name = args.name;
        if (args.daily_budget) fields.daily_budget = args.daily_budget;
        json = await graph('POST', args.campaign_id, fields, token);
        break;
      }
      case 'create_ad_set': {
        const act = requireAccount(adAccountId);
        const optimization_goal = args.optimization_goal || 'LINK_CLICKS';
        const body = {
          campaign_id: args.campaign_id, name: args.name,
          targeting: args.targeting || { geo_locations: { countries: ['IN'] } },
          billing_event: args.billing_event || 'IMPRESSIONS',
          optimization_goal, status: args.status || 'PAUSED',
          daily_budget: args.daily_budget, start_time: args.start_time, end_time: args.end_time,
        };
        // LEAD_GENERATION requires a promoted_object (page + lead form). If the
        // caller didn't supply one, fall back to LINK_CLICKS so Meta accepts it.
        if (optimization_goal === 'LEAD_GENERATION') {
          if (args.promoted_object) body.promoted_object = args.promoted_object;
          else body.optimization_goal = 'LINK_CLICKS';
        }
        json = await graph('POST', `${act}/adsets`, body, token);
        break;
      }
      case 'create_ad_creative': {
        const act = requireAccount(adAccountId);
        const pageId = args.page_id || await firstPageId(token);
        const link_data = {
          message: args.body, link: args.link_url || 'https://facebook.com',
          name: args.title,
          call_to_action: { type: args.call_to_action_type || 'LEARN_MORE', value: { link: args.link_url || 'https://facebook.com' } },
        };
        if (args.image_hash) link_data.image_hash = args.image_hash;
        json = await graph('POST', `${act}/adcreatives`, {
          name: args.name || 'LeadPilot creative',
          object_story_spec: { page_id: pageId, link_data },
        }, token);
        break;
      }
      case 'create_ad': {
        const act = requireAccount(adAccountId);
        const creativeId = args.creative?.creative_id || args.creative_id;
        json = await graph('POST', `${act}/ads`, {
          name: args.name, adset_id: args.adset_id,
          creative: { creative_id: creativeId }, status: args.status || 'PAUSED',
        }, token);
        break;
      }
      case 'search_interests': {
        json = await graph('GET', 'search', { type: 'adinterest', q: args.query, limit: args.limit || 20 }, token);
        break;
      }
      case 'get_custom_audiences': {
        const act = requireAccount(adAccountId);
        json = await graph('GET', `${act}/customaudiences`, { fields: 'id,name,approximate_count_lower_bound,subtype,delivery_status', limit: 50 }, token);
        break;
      }
      case 'get_delivery_estimate': {
        const act = requireAccount(adAccountId);
        json = await graph('GET', `${act}/delivery_estimate`, {
          optimization_goal: args.optimization_goal || 'LINK_CLICKS',
          targeting_spec: args.targeting || { geo_locations: { countries: ['IN'] } },
        }, token);
        break;
      }
      case 'get_ad_preview': {
        json = await graph('GET', `${args.creative_id}/previews`, { ad_format: args.ad_format || 'DESKTOP_FEED_STANDARD' }, token);
        break;
      }
      case 'search_ad_library': {
        json = await graph('GET', 'ads_archive', {
          search_terms: args.search_terms || args.query,
          ad_reached_countries: args.country ? [args.country] : ['IN'],
          ad_type: 'ALL', ad_active_status: 'ALL',
          fields: 'id,ad_creative_bodies,ad_creative_link_titles,page_name,ad_delivery_start_time',
          limit: args.limit || 25,
        }, token);
        break;
      }
      case 'get_account_info': {
        const act = requireAccount(adAccountId);
        json = await graph('GET', act, { fields: 'name,currency,account_status,amount_spent,balance,business_name' }, token);
        break;
      }
      case 'get_ad_accounts': {
        json = await graph('GET', 'me/adaccounts', { fields: 'id,name,account_status,currency,amount_spent,business_name', limit: 50 }, token);
        break;
      }
      case 'get_ad_sets': {
        const node = args.campaign_id ? `${args.campaign_id}/adsets` : `${requireAccount(adAccountId)}/adsets`;
        json = await graph('GET', node, { fields: 'id,name,status,effective_status,daily_budget,optimization_goal,billing_event,campaign_id,targeting', limit: args.limit || 50 }, token);
        break;
      }
      case 'get_ads': {
        const node = args.adset_id ? `${args.adset_id}/ads` : `${requireAccount(adAccountId)}/ads`;
        json = await graph('GET', node, { fields: 'id,name,status,effective_status,adset_id,creative{id,name,thumbnail_url}', limit: args.limit || 50 }, token);
        break;
      }
      case 'update_ad_set': {
        const fields = {};
        for (const k of ['status', 'name', 'daily_budget', 'optimization_goal', 'start_time', 'end_time']) {
          if (args[k] != null) fields[k] = args[k];
        }
        if (args.targeting) fields.targeting = args.targeting;
        json = await graph('POST', args.adset_id, fields, token);
        break;
      }
      case 'get_ad_creatives': {
        const act = requireAccount(adAccountId);
        json = await graph('GET', `${act}/adcreatives`, { fields: 'id,name,object_story_spec,thumbnail_url,status', limit: args.limit || 50 }, token);
        break;
      }
      case 'get_saved_audiences': {
        const act = requireAccount(adAccountId);
        json = await graph('GET', `${act}/saved_audiences`, { fields: 'id,name,approximate_count_lower_bound,targeting', limit: 50 }, token);
        break;
      }
      case 'get_targeting_insights': {
        const act = requireAccount(adAccountId);
        json = await graph('GET', `${act}/delivery_estimate`, {
          optimization_goal: args.optimization_goal || 'REACH',
          targeting_spec: args.targeting || { geo_locations: { countries: ['IN'] } },
        }, token);
        break;
      }
      case 'create_lookalike_audience': {
        const act = requireAccount(adAccountId);
        json = await graph('POST', `${act}/customaudiences`, {
          name: args.name || 'LeadPilot Lookalike',
          subtype: 'LOOKALIKE',
          origin_audience_id: args.source_audience_id || args.origin_audience_id,
          lookalike_spec: { type: 'similarity', country: args.country || 'IN', ratio: args.ratio || 0.01 },
        }, token);
        break;
      }
      case 'create_custom_audience': {
        const act = requireAccount(adAccountId);
        json = await graph('POST', `${act}/customaudiences`, {
          name: args.name || 'LeadPilot Audience',
          subtype: args.subtype || 'CUSTOM',
          customer_file_source: args.customer_file_source || 'USER_PROVIDED_ONLY',
          description: args.description || 'Created by LeadPilot',
        }, token);
        // If lead records are supplied, hash (SHA-256) and add them to the audience.
        if (json.id && Array.isArray(args.users) && args.users.length) {
          const norm = (s) => crypto.createHash('sha256').update(String(s).trim().toLowerCase()).digest('hex');
          const hasEmail = args.users.some(u => u.email);
          const hasPhone = args.users.some(u => u.phone);
          const schema = [];
          if (hasEmail) schema.push('EMAIL');
          if (hasPhone) schema.push('PHONE');
          const data = args.users.map(u => {
            const row = [];
            if (hasEmail) row.push(u.email ? norm(u.email) : '');
            if (hasPhone) row.push(u.phone ? norm(String(u.phone).replace(/\D/g, '')) : '');
            return row;
          });
          try {
            json.users_added = await graph('POST', `${json.id}/users`, { payload: { schema, data } }, token);
          } catch (e) { json.users_add_error = e.message; }
        }
        break;
      }
      case 'upload_ad_image': {
        const act = requireAccount(adAccountId);
        let b64 = args.bytes;
        if (!b64 && args.image_url) {
          const r = await fetch(args.image_url);
          b64 = Buffer.from(await r.arrayBuffer()).toString('base64');
        }
        if (!b64) throw new Error('image_url or bytes required to upload an image');
        json = await graph('POST', `${act}/adimages`, { bytes: b64 }, token);
        break;
      }
      case 'delivery_check': {
        // Surface why a campaign/ad set/ad is (not) delivering.
        if (!args.object_id) throw new Error('object_id (campaign/ad set/ad id) required');
        json = await graph('GET', args.object_id, { fields: 'effective_status,configured_status,issues_info' }, token);
        break;
      }
      case 'get_account_quality': {
        const act = requireAccount(adAccountId);
        json = await graph('GET', act, { fields: 'account_status,disable_reason,is_prepay_account,business,adtrust_dsl' }, token);
        break;
      }
      case 'search_ads_archive': {
        // alias — the AI tool registry refers to this name
        json = await graph('GET', 'ads_archive', {
          search_terms: args.search_terms || args.query,
          ad_reached_countries: args.country ? [args.country] : ['IN'],
          ad_type: args.ad_type || 'ALL', ad_active_status: 'ALL',
          fields: 'id,ad_creative_bodies,ad_creative_link_titles,page_name,ad_delivery_start_time',
          limit: args.limit || 25,
        }, token);
        break;
      }
      case 'get_leads': {
        // Primary lead flow is the webhook → DB. This pulls a form's leads on demand.
        if (!args.form_id) throw new Error('form_id required (or use the Leads module, which receives leads via webhook)');
        json = await graph('GET', `${args.form_id}/leads`, { fields: 'id,created_time,field_data,ad_id,campaign_id', limit: args.limit || 50 }, token);
        break;
      }
      default:
        return { success: false, error: `Meta tool "${toolName}" is not supported by the Graph adapter` };
    }
    return { success: true, data: JSON.stringify(json) };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { executeMetaTool, mapObjective };
