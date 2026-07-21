const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');

const { checkOrgToken } = require('../lib/authz');
const { runAnalyst }        = require('../lib/ai/runner');
const { searchWeb }         = require('../lib/services/tavily');
const { scrapeWebsite, enrichOrganisation } = require('../lib/services/scraper');
const { executeMetaTool }   = require('../lib/mcp/manager');
const {
  createOrg, getOrg, listOrgs, updateOrg,
  getMetaConnection, getGoogleConnection,
  saveKnowledge, getKnowledge,
  saveLead, getLeads, updateLeadStatus, getLeadStats,
  saveCampaigns, getCachedCampaigns,
  saveKeywords, getKeywords,
  getOrgIdByFacebookPage,
} = require('../lib/db');

// ── Middleware ────────────────────────────────────────────────
function withOrg(req, res, next) {
  const orgId = req.body?.org_id || req.query?.org_id;
  if (!orgId) return res.status(400).json({ error: 'org_id required' });
  const org = getOrg(orgId);
  if (!org) return res.status(404).json({ error: `Organisation "${orgId}" not found. Create it first.` });
  if (!checkOrgToken(req, org)) {
    return res.status(401).json({ error: 'Unauthorized: missing or invalid org token' });
  }
  req.orgId    = orgId;
  req.org      = org;
  req.metaConn = getMetaConnection(orgId);
  req.gConn    = getGoogleConnection(orgId);
  next();
}

// ════════════════════════════════════════════
// ORGANISATION
// ════════════════════════════════════════════

// Strip the secret api_token from any org object sent to non-issuance endpoints.
function publicOrg(org) {
  if (!org) return org;
  const { api_token, ...rest } = org;
  return rest;
}

router.post('/org/create', (req, res) => {
  const { org_id, name, website, industry } = req.body;
  if (!org_id || !name) return res.status(400).json({ error: 'org_id and name required' });
  const existing = getOrg(org_id);
  if (existing) {
    // Never re-issue or expose an existing org's token to an unauthenticated caller.
    if (!checkOrgToken(req, existing)) {
      return res.status(409).json({ error: 'Organisation already exists' });
    }
    if (website || industry) updateOrg(org_id, { website: website || null, industry: industry || null });
    return res.json({ success: true, org: publicOrg(getOrg(org_id)) });
  }
  const created = createOrg(org_id, name);
  if (website || industry) updateOrg(org_id, { website: website || null, industry: industry || null });
  // The api_token is returned ONLY here, at creation — the client must store it.
  res.json({ success: true, org: publicOrg(getOrg(org_id)), api_token: created.api_token });
});

router.get('/org/list', (req, res) => {
  res.json({ success: true, orgs: listOrgs().map(publicOrg) });
});

router.get('/org/status', (req, res) => {
  const orgId = req.query.org_id;
  if (!orgId) return res.status(400).json({ error: 'org_id required' });
  const org = getOrg(orgId);
  if (!org) return res.status(404).json({ error: 'Organisation not found' });
  const meta = getMetaConnection(orgId);
  const google = getGoogleConnection(orgId);
  res.json({
    org: publicOrg(org),
    meta_connected:   !!meta,
    google_connected: !!google,
    meta_ad_account:  meta?.ad_account_id || null,
    knowledge:        getKnowledge(orgId),
  });
});

router.post('/org/enrich', withOrg, async (req, res) => {
  const url = req.body.website_url || req.org.website;
  if (!url) return res.status(400).json({ error: 'website_url required' });
  try {
    const raw = await enrichOrganisation(url);
    if (!raw.success) return res.status(500).json({ error: raw.error });

    // Use AI to extract structured fields from raw scraped data
    let structured = {
      business_name: raw.business_name,
      website: url,
      services: raw.services_mentioned?.slice(0, 10) || [],
      prices_found: raw.prices_found || [],
      contact: raw.contact || {},
      summary_text: raw.summary_text,
    };

    try {
      const aiResult = await runAnalyst(req.orgId,
        `Based on this website content, extract structured business information in JSON format with these exact fields:
        industry, target_audience, competitors (list 3-5 likely competitors), languages, brand_voice, usps (unique selling points list).
        
        Website content: ${raw.summary_text?.substring(0, 3000)}
        
        Return ONLY valid JSON, no other text.`,
        [] // no tools needed
      );
      try {
        const parsed = JSON.parse(aiResult.answer.replace(/```json|```/g, '').trim());
        structured = { ...structured, ...parsed };
      } catch {}
    } catch {}

    saveKnowledge(req.orgId, structured);
    updateOrg(req.orgId, { website: url });
    res.json({ success: true, knowledge: structured });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════
// AI ANALYST CHAT
// ════════════════════════════════════════════

router.post('/ai-analyst', withOrg, async (req, res) => {
  const { query, tools } = req.body;
  if (!query) return res.status(400).json({ error: 'query required' });
  try {
    const result = await runAnalyst(req.orgId, query, tools || null);
    res.json({ success: true, answer: result.answer, tools_used: result.toolsUsed, model: result.model });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════
// MODULE 01 — KEYWORD RESEARCH
// ════════════════════════════════════════════

router.post('/keywords/research', withOrg, async (req, res) => {
  const { seed_keyword, country } = req.body;
  if (!seed_keyword) return res.status(400).json({ error: 'seed_keyword required' });

  try {
    // Search web for keyword data
    const tavilyResult = await searchWeb(
      `${seed_keyword} keyword search volume CPC competition ${country || 'India'} 2026 google ads`, 5
    );

    // Use AI to extract structured keyword table
    const prompt = `You are a keyword research tool. Based on this web data and your knowledge, generate a keyword research table for "${seed_keyword}" in ${country || 'India'}.

Web data: ${tavilyResult.results?.map(r => r.content).join('\n').substring(0, 2000)}

Return ONLY a JSON array of 15-20 keywords with this exact structure:
[{
  "keyword": "exact keyword phrase",
  "volume": 1000,
  "difficulty": 45,
  "cpc_low": 15.0,
  "cpc_high": 45.0,
  "intent": "Commercial",
  "trend": "stable"
}]

Intent must be one of: Informational, Commercial, Transactional, Navigational
Trend must be one of: rising, stable, declining
Include the seed keyword plus related variations, long-tail keywords, and negative keywords (mark intent as Informational for those).
Return ONLY the JSON array, no other text.`;

    const aiResult = await runAnalyst(req.orgId, prompt, []);
    let keywords = [];
    
    try {
      keywords = JSON.parse(aiResult.answer.replace(/```json|```/g, '').trim());
    } catch {
      // If JSON parse fails, return basic structure
      keywords = [{
        keyword: seed_keyword,
        volume: 1000,
        difficulty: 50,
        cpc_low: 10,
        cpc_high: 30,
        intent: 'Commercial',
        trend: 'stable'
      }];
    }

    // Save to cache
    saveKeywords(req.orgId, keywords);

    res.json({ success: true, keywords, seed: seed_keyword, country: country || 'IN' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/keywords/saved', withOrg, (req, res) => {
  res.json({ success: true, keywords: getKeywords(req.orgId) });
});

// ════════════════════════════════════════════
// MODULE 02 — AD COPY GENERATOR
// ════════════════════════════════════════════

router.post('/copy/generate', withOrg, async (req, res) => {
  const { keywords, landing_url, objective, tone, platform } = req.body;
  if (!keywords) return res.status(400).json({ error: 'keywords required' });

  const knowledge = getKnowledge(req.orgId);
  const kwList = Array.isArray(keywords) ? keywords.join(', ') : keywords;

  const prompt = `You are an expert ad copywriter for ${knowledge?.business_name || req.org.name}.
Business: ${knowledge?.business_name || req.org.name}
Industry: ${knowledge?.industry || 'General'}
Services: ${Array.isArray(knowledge?.services) ? knowledge.services.join(', ') : knowledge?.services || 'Various services'}
USPs: ${Array.isArray(knowledge?.usps) ? knowledge.usps.join(', ') : knowledge?.usps || 'Quality service'}
Keywords: ${kwList}
Landing Page: ${landing_url || 'Not specified'}
Objective: ${objective || 'LEAD_GENERATION'}
Tone: ${tone || 'Professional'}

Generate ad copy for ${platform || 'both Google and Meta'}.

Return ONLY a JSON object with this exact structure:
{
  "google": {
    "headlines": ["headline 1", "headline 2", "headline 3", "headline 4", "headline 5"],
    "descriptions": ["description 1", "description 2", "description 3"]
  },
  "meta": [
    {
      "variant": "A",
      "primary_text": "primary text here max 125 chars",
      "headline": "headline max 40 chars",
      "link_description": "link desc max 30 chars",
      "cta": "Learn More"
    },
    {
      "variant": "B",
      "primary_text": "alternative primary text",
      "headline": "alternative headline",
      "link_description": "alt link desc",
      "cta": "Get Started"
    },
    {
      "variant": "C",
      "primary_text": "third primary text variant",
      "headline": "third headline",
      "link_description": "third link desc",
      "cta": "Contact Us"
    }
  ]
}

STRICT character limits:
- Google headlines: max 30 characters each
- Google descriptions: max 90 characters each
- Meta primary_text: max 125 characters
- Meta headline: max 40 characters
- Meta link_description: max 30 characters

Return ONLY the JSON object, no other text.`;

  try {
    const result = await runAnalyst(req.orgId, prompt, []);
    let copy;
    try {
      copy = JSON.parse(result.answer.replace(/```json|```/g, '').trim());
    } catch {
      copy = { error: 'Could not parse AI response', raw: result.answer };
    }
    res.json({ success: true, copy, model: result.model });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════
// MODULE 03 — UNIFIED AD TRACKER
// ════════════════════════════════════════════

router.post('/tracker/campaigns', withOrg, async (req, res) => {
  const { date_preset } = req.body;
  const results = { meta: [], google: [], diagnostics: [] };
  // Per-lead value is only used if the org explicitly configured one; otherwise
  // ROAS is reported as null (unknown) rather than fabricated.
  const knowledge = getKnowledge(req.orgId) || {};
  const leadValue = Number(knowledge.lead_value) || 0;

  // Fetch Meta campaigns
  if (req.metaConn) {
    try {
      const campaignsResult = await executeMetaTool(
        'list_campaigns',
        { status_filter: 'ALL', limit: 50 },
        req.metaConn.access_token,
        req.metaConn.ad_account_id
      );

      if (campaignsResult.success) {
        let campaigns = [];
        try { campaigns = JSON.parse(campaignsResult.data).data || []; } catch {}

        // Get insights for each campaign
        const insightsResult = await executeMetaTool(
          'get_insights',
          { 
            date_preset: date_preset || 'last_7d',
            fields: 'campaign_id,campaign_name,spend,impressions,clicks,ctr,cpc,actions,reach,frequency',
            level: 'campaign'
          },
          req.metaConn.access_token,
          req.metaConn.ad_account_id
        );

        let insights = [];
        if (insightsResult.success) {
          try { insights = JSON.parse(insightsResult.data).data || []; } catch {}
        }

        // Merge campaigns with insights and calculate diagnostics
        results.meta = campaigns.map(c => {
          const insight = insights.find(i => i.campaign_id === c.id) || {};
          const spend    = parseFloat(insight.spend || 0);
          const impressions = parseInt(insight.impressions || 0);
          const clicks   = parseInt(insight.clicks || 0);
          const ctr      = parseFloat(insight.ctr || 0);
          const cpc      = parseFloat(insight.cpc || 0);
          const reach    = parseInt(insight.reach || 0);
          const frequency = parseFloat(insight.frequency || 0);
          const convActions = insight.actions?.find(a => a.action_type === 'lead') || {};
          const conversions = parseInt(convActions.value || 0);
          // Revenue: prefer real monetary conversion values reported by Meta;
          // fall back to an explicit configured per-lead value; else unknown.
          const actionValues = Array.isArray(insight.action_values) ? insight.action_values : [];
          const realRevenue = actionValues.reduce((s, a) => s + parseFloat(a.value || 0), 0);
          const revenue  = realRevenue > 0 ? realRevenue : (leadValue > 0 ? conversions * leadValue : 0);
          const roas     = spend > 0 && revenue > 0 ? revenue / spend : null;
          const cpl      = conversions > 0 ? spend / conversions : 0;

          // Diagnostic flag
          let diagnostic = null;
          if (spend > 500 && conversions === 0) {
            diagnostic = { level: 'red', message: 'High spend with zero conversions', action: 'Pause and review targeting' };
          } else if (frequency > 3) {
            diagnostic = { level: 'amber', message: `High frequency (${frequency.toFixed(1)}) — audience fatigue`, action: 'Refresh creative or expand audience' };
          } else if (roas != null && roas > 4 && spend > 100) {
            diagnostic = { level: 'green', message: 'Excellent ROAS — scaling opportunity', action: 'Increase budget 20-30%' };
          } else if (roas != null && roas < 2 && roas > 0 && spend > 200) {
            diagnostic = { level: 'blue', message: 'ROAS below target', action: 'Review bid strategy and landing page' };
          }

          return {
            id: c.id, name: c.name, platform: 'Meta',
            status: c.status, objective: c.objective,
            budget: c.daily_budget || c.lifetime_budget,
            spend, impressions, clicks, ctr, cpc,
            conversions, revenue, roas, reach, frequency, cpl,
            diagnostic,
          };
        });

        // Save to cache
        saveCampaigns(req.orgId, 'meta', results.meta);
      }
    } catch (err) {
      console.error('[tracker] Meta fetch error:', err.message);
    }
  } else {
    // Load from cache if Meta not connected
    results.meta = getCachedCampaigns(req.orgId)
      .filter(c => c.platform === 'meta')
      .map(c => ({ ...c, diagnostic: c.diagnostic ? JSON.parse(c.diagnostic) : null }));
  }

  // Calculate KPIs — spend/impression-weighted, not naive per-campaign means.
  const allCampaigns = [...results.meta, ...results.google];
  const totalSpend       = allCampaigns.reduce((s, c) => s + (c.spend || 0), 0);
  const totalClicks      = allCampaigns.reduce((s, c) => s + (c.clicks || 0), 0);
  const totalImpressions = allCampaigns.reduce((s, c) => s + (c.impressions || 0), 0);
  const totalConversions = allCampaigns.reduce((s, c) => s + (c.conversions || 0), 0);
  const totalRevenue     = allCampaigns.reduce((s, c) => s + (c.revenue || 0), 0);
  const kpis = {
    total_spend:       totalSpend,
    total_clicks:      totalClicks,
    total_impressions: totalImpressions,
    total_conversions: totalConversions,
    total_revenue:     totalRevenue,
    avg_ctr:      totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0,
    avg_cpc:      totalClicks > 0 ? totalSpend / totalClicks : 0,
    avg_cpl:      totalConversions > 0 ? totalSpend / totalConversions : 0,
    // Only a real number when revenue is known; otherwise null (unknown).
    blended_roas: totalRevenue > 0 && totalSpend > 0 ? totalRevenue / totalSpend : null,
  };

  res.json({
    success: true,
    meta: results.meta,
    google: results.google,
    google_status: req.gConn ? 'connected' : 'not_connected',
    kpis,
    date_preset: date_preset || 'last_7d',
  });
});

// ════════════════════════════════════════════
// MODULE 04 — META ADS CREATOR
// ════════════════════════════════════════════

// Step 1: Get interest suggestions for audience builder
router.post('/meta-creator/interests', withOrg, async (req, res) => {
  if (!req.metaConn) return res.status(424).json({ error: 'Meta not connected' });
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'query required' });

  const result = await executeMetaTool(
    'search_interests', { query, limit: 20 },
    req.metaConn.access_token, req.metaConn.ad_account_id
  );
  res.json({ success: result.success, data: result.success ? result.data : null, error: result.error });
});

// Get custom audiences
router.post('/meta-creator/audiences', withOrg, async (req, res) => {
  if (!req.metaConn) return res.status(424).json({ error: 'Meta not connected' });
  const result = await executeMetaTool(
    'get_custom_audiences', {},
    req.metaConn.access_token, req.metaConn.ad_account_id
  );
  res.json({ success: result.success, data: result.data, error: result.error });
});

// Get delivery estimate
router.post('/meta-creator/estimate', withOrg, async (req, res) => {
  if (!req.metaConn) return res.status(424).json({ error: 'Meta not connected' });
  const { targeting, daily_budget } = req.body;
  const result = await executeMetaTool(
    'get_delivery_estimate', { targeting, daily_budget },
    req.metaConn.access_token, req.metaConn.ad_account_id
  );
  res.json({ success: result.success, data: result.data, error: result.error });
});

// Step 4: Generate ad preview
router.post('/meta-creator/preview', withOrg, async (req, res) => {
  if (!req.metaConn) return res.status(424).json({ error: 'Meta not connected' });
  const { creative_id, ad_format } = req.body;
  const result = await executeMetaTool(
    'get_ad_preview', { creative_id, ad_format: ad_format || 'DESKTOP_FEED_STANDARD' },
    req.metaConn.access_token, req.metaConn.ad_account_id
  );
  res.json({ success: result.success, data: result.data, error: result.error });
});

// Create ad creative
router.post('/meta-creator/creative', withOrg, async (req, res) => {
  if (!req.metaConn) return res.status(424).json({ error: 'Meta not connected' });
  const { name, image_hash, video_id, title, body, link_url, cta_type } = req.body;

  const result = await executeMetaTool(
    'create_ad_creative', { name, image_hash, video_id, title, body, link_url, call_to_action_type: cta_type || 'LEARN_MORE' },
    req.metaConn.access_token, req.metaConn.ad_account_id
  );
  res.json({ success: result.success, data: result.data, error: result.error });
});

// Create ad set
router.post('/meta-creator/adset', withOrg, async (req, res) => {
  if (!req.metaConn) return res.status(424).json({ error: 'Meta not connected' });
  const { campaign_id, name, targeting, daily_budget, start_time, end_time, confirmed } = req.body;

  if (!confirmed) {
    return res.json({
      requires_confirmation: true,
      message: `Create ad set "${name}" in campaign ${campaign_id}?\nBudget: ₹${daily_budget}/day\nStatus will be PAUSED`,
    });
  }

  const result = await executeMetaTool(
    'create_ad_set', {
      campaign_id, name, targeting,
      daily_budget: daily_budget * 100,
      billing_event: 'IMPRESSIONS',
      optimization_goal: 'LEAD_GENERATION',
      status: 'PAUSED',
      start_time, end_time,
    },
    req.metaConn.access_token, req.metaConn.ad_account_id
  );
  res.json({ success: result.success, data: result.data, error: result.error });
});

// Create ad
router.post('/meta-creator/ad', withOrg, async (req, res) => {
  if (!req.metaConn) return res.status(424).json({ error: 'Meta not connected' });
  const { adset_id, name, creative_id, confirmed } = req.body;

  if (!confirmed) {
    return res.json({
      requires_confirmation: true,
      message: `Create ad "${name}" in ad set ${adset_id}? Status will be PAUSED.`,
    });
  }

  const result = await executeMetaTool(
    'create_ad', { adset_id, name, creative: { creative_id }, status: 'PAUSED' },
    req.metaConn.access_token, req.metaConn.ad_account_id
  );
  res.json({ success: result.success, data: result.data, error: result.error });
});

// Full campaign create (Step 5 — Publish, campaign object only)
router.post('/campaigns/create', withOrg, async (req, res) => {
  if (!req.metaConn) return res.status(424).json({ error: 'Meta not connected', connect_url: `/auth/meta?org_id=${req.orgId}` });
  const { name, objective, daily_budget, confirmed } = req.body;
  if (!name || !objective) return res.status(400).json({ error: 'name and objective required' });

  if (!confirmed) {
    return res.json({
      requires_confirmation: true,
      message: `Create campaign "${name}"?\nObjective: ${objective}\nBudget: ${daily_budget ? '₹' + daily_budget + '/day' : 'Not set'}\nStatus: PAUSED (safe)`,
    });
  }

  const result = await executeMetaTool(
    'create_campaign', { name, objective, status: 'PAUSED', daily_budget: daily_budget ? daily_budget * 100 : undefined },
    req.metaConn.access_token, req.metaConn.ad_account_id
  );
  res.json({ success: result.success, data: result.data, error: result.error });
});

// Extract an object id from an MCP tool result across the shapes meta-mcp uses.
function extractMetaId(result) {
  if (!result || !result.success) return null;
  let d = result.data;
  if (typeof d === 'string') { try { d = JSON.parse(d); } catch { return null; } }
  if (!d || typeof d !== 'object') return null;
  return d.id || d.campaign_id || d.adset_id || d.ad_set_id || d.creative_id || d.ad_id || d.data?.id || null;
}

// Build a Meta targeting spec from the wizard's Audience-Builder fields.
function buildTargeting(t = {}) {
  const spec = {};
  if (t.age_min) spec.age_min = Number(t.age_min);
  if (t.age_max) spec.age_max = Number(t.age_max);
  if (Array.isArray(t.genders) && t.genders.length) spec.genders = t.genders.map(Number);
  if (t.geo_locations) spec.geo_locations = t.geo_locations;
  else if (Array.isArray(t.countries) && t.countries.length) spec.geo_locations = { countries: t.countries };
  if (Array.isArray(t.interests) && t.interests.length) {
    spec.flexible_spec = [{ interests: t.interests.map(i => ({ id: i.id, name: i.name })) }];
  }
  return spec;
}

// Step 5 — Publish the FULL wizard: campaign → ad set → creative → ad.
// Every field the wizard collected is used; each step's outcome is reported
// so nothing is ever silently dropped. Everything is created PAUSED.
router.post('/campaigns/publish', withOrg, async (req, res) => {
  if (!req.metaConn) {
    return res.status(424).json({ error: 'Meta not connected', connect_url: `/auth/meta?org_id=${req.orgId}` });
  }
  const {
    name, objective, daily_budget, lifetime_budget, start_time, end_time,
    targeting = {}, creative = {}, confirmed,
  } = req.body;
  if (!name || !objective) return res.status(400).json({ error: 'name and objective required' });

  if (!confirmed) {
    return res.json({
      requires_confirmation: true,
      summary: {
        campaign: { name, objective, daily_budget, lifetime_budget, start_time, end_time },
        audience: buildTargeting(targeting),
        creative: {
          headline: creative.headline, primary_text: creative.primary_text,
          link_url: creative.link_url, cta: creative.cta || 'LEARN_MORE',
        },
        note: 'All objects will be created PAUSED. Nothing goes live until you activate it.',
      },
    });
  }

  const token = req.metaConn.access_token;
  const acct  = req.metaConn.ad_account_id;
  const steps = [];
  const run = async (label, tool, args) => {
    const r = await executeMetaTool(tool, args, token, acct);
    const id = extractMetaId(r);
    steps.push({ step: label, success: !!(r.success && id), id, error: r.error || (id ? null : 'no id returned') });
    return id;
  };

  const campaignId = await run('campaign', 'create_campaign', {
    name, objective, status: 'PAUSED',
    daily_budget: daily_budget ? daily_budget * 100 : undefined,
    lifetime_budget: lifetime_budget ? lifetime_budget * 100 : undefined,
  });
  if (!campaignId) return res.status(502).json({ success: false, steps, error: 'Campaign creation failed' });

  // Budget lives at the CAMPAIGN level (CBO) above — do NOT also set it on the
  // ad set, or Meta rejects the request. optimization_goal LEAD_GENERATION needs
  // a promoted_object (page + lead form); the Graph adapter downgrades to
  // LINK_CLICKS when none is supplied so the demo publish still succeeds.
  const adsetId = await run('adset', 'create_ad_set', {
    campaign_id: campaignId, name: `${name} — Ad Set`,
    targeting: buildTargeting(targeting),
    billing_event: 'IMPRESSIONS', optimization_goal: 'LEAD_GENERATION',
    status: 'PAUSED', start_time, end_time,
  });
  if (!adsetId) return res.status(502).json({ success: false, steps, campaign_id: campaignId, error: 'Ad set creation failed' });

  const creativeId = await run('creative', 'create_ad_creative', {
    name: `${name} — Creative`, title: creative.headline, body: creative.primary_text,
    link_url: creative.link_url, image_hash: creative.image_hash, video_id: creative.video_id,
    call_to_action_type: creative.cta || 'LEARN_MORE',
  });
  if (!creativeId) return res.status(502).json({ success: false, steps, campaign_id: campaignId, adset_id: adsetId, error: 'Creative creation failed' });

  const adId = await run('ad', 'create_ad', {
    adset_id: adsetId, name: `${name} — Ad`, creative: { creative_id: creativeId }, status: 'PAUSED',
  });

  res.json({
    success: !!adId, steps,
    campaign_id: campaignId, adset_id: adsetId, creative_id: creativeId, ad_id: adId,
  });
});

// Pause campaign
router.post('/campaigns/pause', withOrg, async (req, res) => {
  if (!req.metaConn) return res.status(424).json({ error: 'Meta not connected' });
  const { campaign_id, confirmed } = req.body;
  if (!campaign_id) return res.status(400).json({ error: 'campaign_id required' });

  if (!confirmed) {
    return res.json({ requires_confirmation: true, message: `Pause campaign ${campaign_id}?` });
  }

  const result = await executeMetaTool(
    'update_campaign', { campaign_id, status: 'PAUSED' },
    req.metaConn.access_token, req.metaConn.ad_account_id
  );
  res.json({ success: result.success, data: result.data, error: result.error });
});

// List campaigns (simple)
router.post('/campaigns/list', withOrg, async (req, res) => {
  if (!req.metaConn) return res.status(424).json({ error: 'Meta not connected', connect_url: `/auth/meta?org_id=${req.orgId}` });
  const result = await executeMetaTool(
    'list_campaigns', { status_filter: req.body.status || 'ALL', limit: 30 },
    req.metaConn.access_token, req.metaConn.ad_account_id
  );
  if (!result.success) return res.status(500).json({ error: result.error });
  try { res.json({ success: true, campaigns: JSON.parse(result.data).data || [] }); }
  catch { res.json({ success: true, raw: result.data }); }
});

// ════════════════════════════════════════════
// MODULE 05 — LEAD SCRAPER
// ════════════════════════════════════════════

router.get('/leads/list', withOrg, (req, res) => {
  const status = req.query.status || 'All';
  const leads  = getLeads(req.orgId, status, 200);
  const stats  = getLeadStats(req.orgId);
  res.json({ success: true, leads, stats });
});

router.post('/leads/update-status', withOrg, (req, res) => {
  const { lead_id, status } = req.body;
  if (!lead_id || !status) return res.status(400).json({ error: 'lead_id and status required' });
  const validStatuses = ['New', 'Contacted', 'Follow-up', 'Converted', 'Dead'];
  if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  updateLeadStatus(req.orgId, lead_id, status);
  res.json({ success: true });
});

router.post('/leads/add', withOrg, (req, res) => {
  const { name, phone, email, source, source_campaign, platform } = req.body;
  if (!phone && !email) return res.status(400).json({ error: 'phone or email required' });
  const lead = saveLead({ org_id: req.orgId, name, phone, email, source: source || 'manual', source_campaign, platform: platform || 'manual' });
  res.json({ success: true, lead });
});

// Excel export
router.get('/leads/export', withOrg, async (req, res) => {
  try {
    const XLSX = require('xlsx');
    const leads = getLeads(req.orgId, null, 5000);

    const rows = leads.map(l => ({
      'Name':           l.name || '',
      'Phone':          l.phone || '',
      'Email':          l.email || '',
      'Source':         l.source || '',
      'Campaign':       l.source_campaign || '',
      'Platform':       l.platform || '',
      'Status':         l.status || '',
      'Assigned To':    l.assigned_to || '',
      'Company':        l.company || '',
      'Duplicate':      l.is_duplicate ? 'Yes' : 'No',
      'Captured At':    l.captured_at || '',
    }));

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);

    // Column widths
    ws['!cols'] = [
      {wch:20},{wch:15},{wch:25},{wch:15},{wch:25},
      {wch:10},{wch:12},{wch:20},{wch:20},{wch:10},{wch:20},
    ];

    XLSX.utils.book_append_sheet(wb, ws, 'Leads');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Disposition', `attachment; filename="leads_${req.orgId}_${Date.now()}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Meta webhook verification handshake — echo the challenge ONLY when the
// verify token matches ours (set META_WEBHOOK_VERIFY_TOKEN in .env).
router.get('/leads/webhook/meta', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const expected = process.env.META_WEBHOOK_VERIFY_TOKEN;
  if (mode === 'subscribe' && expected && token === expected) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Map Meta lead-form field_data into our lead columns.
function mapLeadFields(fieldData = []) {
  const out = { name: null, phone: null, email: null, company: null };
  for (const f of fieldData) {
    const key = String(f.name || '').toLowerCase();
    const val = Array.isArray(f.values) ? f.values[0] : f.values;
    if (!val) continue;
    if (key.includes('email')) out.email = val;
    else if (key.includes('phone') || key.includes('mobile')) out.phone = val;
    else if (key.includes('company') || key.includes('organization')) out.company = val;
    else if (key.includes('name') && !out.name) out.name = val;
  }
  return out;
}

// Fetch the actual lead details for a leadgen_id using the org's Meta token.
async function fetchLeadDetails(leadgenId, accessToken) {
  const url = `https://graph.facebook.com/v19.0/${encodeURIComponent(leadgenId)}` +
    `?fields=field_data,ad_id,campaign_id,created_time&access_token=${encodeURIComponent(accessToken)}`;
  const r = await fetch(url);
  const data = await r.json();
  if (data.error) throw new Error(data.error.message);
  return data;
}

router.post('/leads/webhook/meta', async (req, res) => {
  // Verify the payload signature before trusting anything in the body.
  const sigHeader = req.get('x-hub-signature-256') || '';
  const secret = process.env.META_APP_SECRET;
  if (!secret || !req.rawBody) return res.sendStatus(403);
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
  const ok = sigHeader.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(sigHeader), Buffer.from(expected));
  if (!ok) return res.sendStatus(403);

  // Acknowledge fast (Meta retries on non-200); process asynchronously.
  res.sendStatus(200);

  try {
    const { entry } = req.body || {};
    if (!Array.isArray(entry)) return;

    for (const e of entry) {
      const pageId = e.id; // Facebook PAGE id, not our org id
      const orgId = getOrgIdByFacebookPage(pageId);
      if (!orgId) {
        console.warn(`[meta-webhook] no org connected for page ${pageId} — lead dropped`);
        continue;
      }
      const conn = getMetaConnection(orgId);
      if (!conn?.access_token) {
        console.warn(`[meta-webhook] org ${orgId} has no Meta token — lead dropped`);
        continue;
      }
      for (const change of e.changes || []) {
        if (change.field !== 'leadgen') continue;
        const { leadgen_id, ad_id, campaign_id } = change.value || {};
        if (!leadgen_id) continue;
        try {
          const details = await fetchLeadDetails(leadgen_id, conn.access_token);
          const fields = mapLeadFields(details.field_data);
          saveLead({
            org_id: orgId,
            id: leadgen_id,
            source: 'meta_lead_ad',
            source_ad_id: ad_id || details.ad_id,
            source_campaign: campaign_id || details.campaign_id,
            platform: 'meta',
            ...fields,
          });
          console.log(`[meta-webhook] lead ${leadgen_id} saved for org ${orgId}`);
        } catch (err) {
          console.error(`[meta-webhook] failed to fetch lead ${leadgen_id}: ${err.message}`);
        }
      }
    }
  } catch (err) {
    console.error('[meta-webhook] processing error:', err.message);
  }
});

// ════════════════════════════════════════════
// MODULE 06 — SOCIAL MEDIA HUB
// ════════════════════════════════════════════

router.post('/social/metrics', withOrg, async (req, res) => {
  const metrics = { platforms: [] };

  // Facebook Page metrics via meta-mcp
  if (req.metaConn) {
    try {
      const pageResult = await executeMetaTool(
        'get_account_info', {},
        req.metaConn.access_token, req.metaConn.ad_account_id
      );

      if (pageResult.success) {
        let pageData = {};
        try { pageData = JSON.parse(pageResult.data); } catch {}

        metrics.platforms.push({
          platform: 'Facebook',
          icon: 'fb',
          connected: true,
          followers: pageData.fan_count || pageData.followers_count || 0,
          posts_30d: pageData.posts_count || 0,
          avg_reach: pageData.weekly_total_reached || 0,
          engagement: pageData.engagement?.count || 0,
          color: '#1877F2',
        });
      }
    } catch (err) {
      metrics.platforms.push({ platform: 'Facebook', icon: 'fb', connected: true, error: err.message, color: '#1877F2' });
    }
  } else {
    metrics.platforms.push({ platform: 'Facebook', icon: 'fb', connected: false, color: '#1877F2' });
  }

  // Instagram (via Meta connection)
  metrics.platforms.push({
    platform: 'Instagram',
    icon: 'ig',
    connected: !!req.metaConn,
    followers: 0,
    note: 'Requires Instagram Business Account linked to Meta',
    color: '#E4405F',
  });

  // Other platforms — show as not connected (future integration)
  [
    { platform: 'LinkedIn', icon: 'li', color: '#0A66C2' },
    { platform: 'YouTube',  icon: 'yt', color: '#FF0000' },
    { platform: 'Twitter/X', icon: 'tw', color: '#000000' },
  ].forEach(p => metrics.platforms.push({ ...p, connected: false, followers: 0 }));

  res.json({ success: true, ...metrics });
});

// ════════════════════════════════════════════
// COMPETITORS
// ════════════════════════════════════════════

router.post('/competitors/ad-library', withOrg, async (req, res) => {
  if (!req.metaConn) return res.status(424).json({ error: 'Meta not connected', connect_url: `/auth/meta?org_id=${req.orgId}` });
  const { search_terms, country } = req.body;
  if (!search_terms) return res.status(400).json({ error: 'search_terms required' });

  const result = await executeMetaTool(
    'search_ads_archive', {
      search_terms, ad_reached_countries: [country || 'IN'],
      ad_type: 'ALL',
      fields: 'id,ad_creative_body,ad_creative_link_caption,page_name,ad_snapshot_url,spend,impressions',
      limit: req.body.limit || 10,
    },
    req.metaConn.access_token, req.metaConn.ad_account_id
  );

  if (!result.success) return res.status(500).json({ error: result.error });
  try { res.json({ success: true, ads: JSON.parse(result.data) }); }
  catch { res.json({ success: true, raw: result.data }); }
});

router.post('/competitors/web-search', withOrg, async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'query required' });
  const result = await searchWeb(query, req.body.max_results || 8);
  res.json({ success: result.success, ...result });
});

router.post('/competitors/scrape', withOrg, async (req, res) => {
  const { url, extract } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const result = await scrapeWebsite(url, extract || 'all');
    res.json({ success: result.success, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/competitors/analyse', withOrg, async (req, res) => {
  const { competitor_name, location } = req.body;
  if (!competitor_name) return res.status(400).json({ error: 'competitor_name required' });
  try {
    const result = await runAnalyst(req.orgId,
      `Analyse the competitor "${competitor_name}" in ${location || 'India'}. Search the web for their current ads, offers, and pricing. Visit their website to extract exact pricing. Give a detailed competitive analysis.`,
      ['search_web', 'scrape_website', 'search_ad_library']
    );
    res.json({ success: true, analysis: result.answer, tools_used: result.toolsUsed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Keep backward-compatible campaigns/insights endpoint
router.post('/campaigns/insights', withOrg, async (req, res) => {
  if (!req.metaConn) return res.status(424).json({ error: 'Meta not connected' });
  const result = await executeMetaTool(
    'get_insights',
    {
      date_preset: req.body.date_preset || 'last_7d',
      fields: req.body.fields || 'campaign_name,spend,impressions,clicks,ctr,cpc,actions',
      level: 'campaign',
    },
    req.metaConn.access_token,
    req.metaConn.ad_account_id
  );
  if (!result.success) return res.status(500).json({ error: result.error });
  try { res.json({ success: true, insights: JSON.parse(result.data) }); }
  catch { res.json({ success: true, raw: result.data }); }
});

module.exports = router;
