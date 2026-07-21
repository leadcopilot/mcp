/**
 * Tool definitions for the AI Analyst.
 *
 * These are the tools Claude/Gemini sees and can call.
 * Each tool maps to a real action — Meta API, Google API, Tavily, or Playwright.
 *
 * Based on LeadPilot blueprint Section 8 — MCP Integration.
 */

const META_TOOLS = [
  {
    name: 'list_campaigns',
    description: 'List all Meta (Facebook/Instagram) ad campaigns for this organisation. Shows campaign name, status, objective, budget, and performance.',
    parameters: {
      type: 'object',
      properties: {
        status_filter: {
          type: 'string',
          description: 'Filter by status: ACTIVE, PAUSED, ARCHIVED, or ALL',
          enum: ['ACTIVE', 'PAUSED', 'ARCHIVED', 'ALL'],
        },
        limit: {
          type: 'number',
          description: 'Maximum number of campaigns to return (default 10)',
        },
      },
    },
    mcpTool: 'list_campaigns',
  },
  {
    name: 'get_campaign_insights',
    description: 'Get performance metrics for Meta campaigns: spend, impressions, clicks, CTR, CPL, ROAS, leads. Essential for the Unified Ad Tracker.',
    parameters: {
      type: 'object',
      properties: {
        campaign_id: {
          type: 'string',
          description: 'Campaign ID to get insights for (optional — omit for account-level)',
        },
        date_preset: {
          type: 'string',
          description: 'Time range: today, yesterday, last_7d, last_30d, this_month',
          enum: ['today', 'yesterday', 'last_7d', 'last_30d', 'this_month'],
        },
      },
    },
    mcpTool: 'get_insights',
  },
  {
    name: 'search_ad_library',
    description: 'Search the Facebook Ad Library for competitor ads. Find what competitors are running, their messaging, offers, and creative approaches. Used for Competitor Intelligence.',
    parameters: {
      type: 'object',
      properties: {
        search_terms: {
          type: 'string',
          description: 'Keywords to search for in ads (e.g. "cosmetic surgery Hyderabad")',
        },
        country: {
          type: 'string',
          description: 'Country code to search in (e.g. IN for India)',
        },
        ad_type: {
          type: 'string',
          description: 'Type of ads to search',
          enum: ['ALL', 'POLITICAL_AND_ISSUE_ADS'],
        },
        limit: {
          type: 'number',
          description: 'Number of results to return',
        },
      },
      required: ['search_terms'],
    },
    mcpTool: 'search_ads_archive',
  },
  {
    name: 'get_meta_leads',
    description: 'Get leads captured from Meta Lead Ads for this organisation. Shows lead name, phone, email, source campaign, and capture date.',
    parameters: {
      type: 'object',
      properties: {
        form_id: {
          type: 'string',
          description: 'Lead form ID to fetch from (optional)',
        },
        limit: {
          type: 'number',
          description: 'Number of leads to return',
        },
      },
    },
    mcpTool: 'get_leads',
  },
  {
    name: 'create_campaign',
    description: 'Create a new Meta ad campaign. IMPORTANT: This is a write operation. Always confirm with the user before executing. Show them the campaign details and wait for explicit approval.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Campaign name',
        },
        objective: {
          type: 'string',
          description: 'Campaign objective',
          enum: ['LEAD_GENERATION', 'TRAFFIC', 'CONVERSIONS', 'BRAND_AWARENESS', 'REACH'],
        },
        status: {
          type: 'string',
          description: 'Initial status — always start with PAUSED for safety',
          enum: ['PAUSED', 'ACTIVE'],
        },
        daily_budget: {
          type: 'number',
          description: 'Daily budget in smallest currency unit (e.g. paise for INR)',
        },
      },
      required: ['name', 'objective'],
    },
    mcpTool: 'create_campaign',
    isWriteOperation: true,
  },
  {
    name: 'pause_campaign',
    description: 'Pause a Meta campaign. WRITE OPERATION — confirm with user first. Show which campaign will be paused and its current spend.',
    parameters: {
      type: 'object',
      properties: {
        campaign_id: {
          type: 'string',
          description: 'Campaign ID to pause',
        },
      },
      required: ['campaign_id'],
    },
    mcpTool: 'update_campaign',
    isWriteOperation: true,
  },
  {
    name: 'get_ad_account_info',
    description: 'Get Meta ad account information: account name, currency, timezone, spend limit, account status.',
    parameters: {
      type: 'object',
      properties: {},
    },
    mcpTool: 'get_account_info',
  },
  {
    name: 'search_interests',
    description: 'Search for Meta targeting interests based on keywords. Used for audience building in campaign creation.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Interest to search for (e.g. "cosmetic surgery", "real estate")',
        },
      },
      required: ['query'],
    },
    mcpTool: 'search_interests',
  },
  {
    name: 'get_custom_audiences',
    description: 'List custom audiences available in the Meta ad account. Used for retargeting campaigns.',
    parameters: {
      type: 'object',
      properties: {},
    },
    mcpTool: 'get_custom_audiences',
  },
  {
    name: 'get_ad_sets',
    description: 'List ad sets (with budget, optimization goal, targeting, status) for the account or a specific campaign. Use to find which ad sets are wasting budget.',
    parameters: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string', description: 'Optional — limit to one campaign' },
        limit: { type: 'number', description: 'Max ad sets to return' },
      },
    },
    mcpTool: 'get_ad_sets',
  },
  {
    name: 'get_ads',
    description: 'List individual ads (with status and creative) for the account or a specific ad set. Use to compare creatives and find best/worst performers (pair with get_campaign_insights at ad level).',
    parameters: {
      type: 'object',
      properties: {
        adset_id: { type: 'string', description: 'Optional — limit to one ad set' },
        limit: { type: 'number', description: 'Max ads to return' },
      },
    },
    mcpTool: 'get_ads',
  },
  {
    name: 'get_ad_creatives',
    description: 'List ad creatives in the account (headline, body, image, CTA). Use to compare creative approaches.',
    parameters: { type: 'object', properties: { limit: { type: 'number' } } },
    mcpTool: 'get_ad_creatives',
  },
  {
    name: 'update_ad_set',
    description: 'Update an ad set — change budget, targeting, schedule, or pause/resume it. WRITE OPERATION: confirm with the user first.',
    parameters: {
      type: 'object',
      properties: {
        adset_id: { type: 'string', description: 'Ad set ID to update' },
        status: { type: 'string', enum: ['ACTIVE', 'PAUSED'], description: 'Pause or resume' },
        daily_budget: { type: 'number', description: 'New daily budget in smallest currency unit' },
      },
      required: ['adset_id'],
    },
    mcpTool: 'update_ad_set',
    isWriteOperation: true,
  },
  {
    name: 'delivery_check',
    description: 'Diagnose why a campaign, ad set, or ad is not spending/delivering. Returns delivery status and issue reasons.',
    parameters: {
      type: 'object',
      properties: {
        object_id: { type: 'string', description: 'Campaign, ad set, or ad ID to diagnose' },
      },
      required: ['object_id'],
    },
    mcpTool: 'delivery_check',
  },
  {
    name: 'create_lookalike_audience',
    description: 'Create a lookalike audience from an existing source audience (e.g. from your best leads) to find similar new prospects. WRITE OPERATION: confirm first.',
    parameters: {
      type: 'object',
      properties: {
        source_audience_id: { type: 'string', description: 'Source custom-audience ID to model from' },
        country: { type: 'string', description: 'Country code (e.g. IN)' },
        ratio: { type: 'number', description: 'Similarity 0.01–0.10 (1%–10%)' },
        name: { type: 'string' },
      },
      required: ['source_audience_id'],
    },
    mcpTool: 'create_lookalike_audience',
    isWriteOperation: true,
  },
  {
    name: 'create_custom_audience',
    description: 'Create a custom audience, optionally seeding it with your captured leads (emails/phones are hashed before upload). Use to retarget leads or as a lookalike source. WRITE OPERATION: confirm first.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['name'],
    },
    mcpTool: 'create_custom_audience',
    isWriteOperation: true,
  },
];

const GOOGLE_TOOLS = [
  {
    name: 'list_google_campaigns',
    description: 'List all Google Ads campaigns for this organisation with performance metrics.',
    parameters: {
      type: 'object',
      properties: {
        customer_id: {
          type: 'string',
          description: 'Google Ads customer ID',
        },
      },
    },
    mcpTool: 'search_search',
    mcpArgs: (args) => ({
      customer_id: args.customer_id,
      query: 'SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.ctr FROM campaign WHERE segments.date DURING LAST_30_DAYS',
    }),
  },
  {
    name: 'get_keyword_ideas',
    description: 'Get keyword ideas, search volumes, and CPC estimates for Google Ads. Used in Keyword Research module.',
    parameters: {
      type: 'object',
      properties: {
        seed_keywords: {
          type: 'array',
          items: { type: 'string' },
          description: 'Seed keywords to expand from',
        },
        country: {
          type: 'string',
          description: 'Country code (e.g. IN)',
        },
      },
      required: ['seed_keywords'],
    },
    mcpTool: 'search_search',
    mcpArgs: (args) => ({
      query: `SELECT keyword_view.resource_name, ad_group_criterion.keyword.text, metrics.search_volume FROM keyword_view`,
    }),
  },
];

const TAVILY_TOOLS = [
  {
    name: 'search_web',
    description: 'Search the live web for competitor information, market pricing, industry news. Returns current search results. Used for Competitor Intelligence.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query (e.g. "cosmetic surgery clinics Hyderabad offers 2026")',
        },
        max_results: {
          type: 'number',
          description: 'Number of results to return (default 5)',
        },
      },
      required: ['query'],
    },
  },
];

const PLAYWRIGHT_TOOLS = [
  {
    name: 'scrape_website',
    description: 'Visit a specific website URL and extract its full content. Used to read competitor pricing, offers, services, and USPs directly from their website.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Full URL to visit (e.g. https://oliva.in/services)',
        },
        extract: {
          type: 'string',
          description: 'What to extract: all, pricing, services, contact',
          enum: ['all', 'pricing', 'services', 'contact'],
        },
      },
      required: ['url'],
    },
  },
];

const RESEARCH_TOOLS = [
  {
    name: 'list_research_companies',
    description: 'List companies/leads/competitors that already have a deep-research knowledge base built by the Deep Research module. Returns each company\'s key, display name, and what research exists (report/leads/profile). Call this first to find the right company key before ask_research_knowledge_base.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'ask_research_knowledge_base',
    description: 'Answer a question about a specific company/competitor/lead using its stored deep-research knowledge base. Answers are grounded in real researched data and cite sources — prefer this over live web search when a knowledge base exists for the company. Use list_research_companies first to find the correct company key.',
    parameters: {
      type: 'object',
      properties: {
        company: {
          type: 'string',
          description: 'The company_key from list_research_companies (usually the researched URL)',
        },
        question: {
          type: 'string',
          description: 'The question to answer from the knowledge base',
        },
      },
      required: ['company', 'question'],
    },
  },
];

// Convert our tool definitions to Gemini's function calling format
function toGeminiTools(toolList) {
  return toolList.map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters || { type: 'object', properties: {} },
  }));
}

// Convert our tool definitions to Groq's OpenAI-compatible format
function toGroqTools(toolList) {
  return toolList.map(tool => {
    const schema = tool.parameters || { type: 'object', properties: {} };
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: simplifyForGroq(schema),
      },
    };
  });
}

// Groq does not support anyOf unions — flatten them
function simplifyForGroq(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (schema.anyOf) {
    const nonNull = schema.anyOf.find(s => s.type !== 'null');
    return simplifyForGroq(nonNull || schema.anyOf[0]);
  }
  const result = { ...schema };
  if (result.properties) {
    result.properties = Object.fromEntries(
      Object.entries(result.properties).map(([k, v]) => [k, simplifyForGroq(v)])
    );
  }
  if (result.items) result.items = simplifyForGroq(result.items);
  return result;
}

function getAllToolDefs() {
  return [...META_TOOLS, ...GOOGLE_TOOLS, ...TAVILY_TOOLS, ...PLAYWRIGHT_TOOLS, ...RESEARCH_TOOLS];
}

function getToolDef(name) {
  return getAllToolDefs().find(t => t.name === name);
}

module.exports = {
  META_TOOLS,
  GOOGLE_TOOLS,
  TAVILY_TOOLS,
  PLAYWRIGHT_TOOLS,
  RESEARCH_TOOLS,
  toGeminiTools,
  toGroqTools,
  getAllToolDefs,
  getToolDef,
};
