/**
 * AI Runner — the brain of the LeadPilot pipeline.
 *
 * Tries Gemini first (free, fast, great tool calling).
 * Falls back to Groq automatically if Gemini is unavailable.
 *
 * Also builds the system prompt from the organisation's knowledge base
 * so every AI response is contextually accurate for that specific client.
 */

const { runGemini } = require('./gemini');
const { runGroq }   = require('./groq');
const { executeMetaTool, executeGoogleTool } = require('../mcp/manager');
const { searchWeb } = require('../services/tavily');
const { scrapeWebsite } = require('../services/scraper');
const researchClient = require('../services/researchClient');
const { getMetaConnection, getGoogleConnection, getKnowledge } = require('../db');
const { getAllToolDefs, getToolDef } = require('../mcp/tools');

// Errors that mean Gemini itself is down (not a tool error)
const GEMINI_UNAVAILABLE_CODES = [429, 503, 500, 502, 504];

/**
 * Build a system prompt from the organisation's knowledge base.
 * This makes the AI aware of what this specific client does.
 */
function buildSystemPrompt(orgId, knowledge) {
  const base = `You are the AI Analyst for LeadPilot, an AI-powered ad management platform.
You help ad managers analyse campaigns, research competitors, and optimise performance.

IMPORTANT RULES:
1. Always use tools to fetch real data. Never answer from memory alone.
2. For write operations (create/pause campaign, set budget) — show the user exactly what will happen and WAIT for confirmation before executing.
3. Copy exact values (IDs, names, numbers) from tool results — never paraphrase.
4. If a tool fails, explain the error honestly and suggest a fix.
5. Always present data in a clear, actionable format with actual names, numbers, and specifics.

RESEARCH BEHAVIOUR — THIS IS CRITICAL:
- When asked about competitors, pricing, or market data:
  a. First use search_web to find relevant pages.
  b. Then AUTOMATICALLY use scrape_website on the most relevant URL(s) to extract actual company names, prices, and details.
  c. DO NOT stop at listing page titles or URLs — the user wants ACTUAL DATA.
  d. DO NOT ask "would you like me to scrape?" — just scrape and return the results.
- Give concrete answers: company names, prices in ₹, phone numbers, specific details.
- If one URL doesn't give enough data, scrape another one from the search results.
- Never say "I found some lists, explore them" — extract the data FROM those lists and present it directly.

DEEP RESEARCH KNOWLEDGE BASES:
- Some companies/competitors/leads have already been deep-researched via the Deep Research module. Those knowledge bases are grounded, cited, and richer than a live scrape.
- When asked about a specific company, competitor, or lead: FIRST call list_research_companies to check for a matching knowledge base (match by name or URL). If one exists, use ask_research_knowledge_base to answer — prefer it over search_web/scrape_website.
- If no knowledge base matches, fall back to the search_web → scrape_website flow above, and mention that the user can run the company through the Deep Research module for a persistent, citable knowledge base.
- If ask_research_knowledge_base says no knowledge store exists or has no matching content, relay that honestly — NEVER invent an answer as if it came from the knowledge base.`;

  if (!knowledge) return base;

  // Map scraped fields correctly — enrichOrganisation() returns services_mentioned,
  // headings, prices_found, contact, and summary_text
  const services = knowledge.services
    || knowledge.services_mentioned
    || knowledge.headings
    || [];

  const prices = knowledge.prices_found || [];
  const phones = knowledge.contact?.phones || [];
  const emails = knowledge.contact?.emails || [];

  const orgContext = `

ORGANISATION CONTEXT (scraped from their website):
Business:       ${knowledge.business_name || 'Unknown'}
Website:        ${knowledge.website || 'Unknown'}
Industry:       ${knowledge.industry || 'Unknown'}
Description:    ${knowledge.meta_description || 'Not available'}
Services/Products: ${Array.isArray(services) ? services.slice(0, 10).join(', ') : services || 'Unknown'}
Prices found:   ${prices.length > 0 ? prices.join(', ') : 'None detected'}
Phone numbers:  ${phones.length > 0 ? phones.join(', ') : 'Not found'}
Email contacts: ${emails.length > 0 ? emails.join(', ') : 'Not found'}
Target Audience: ${knowledge.target_audience || 'Unknown — infer from context above'}
Competitors:    ${Array.isArray(knowledge.competitors) ? knowledge.competitors.join(', ') : knowledge.competitors || 'Unknown — use web search to find them'}
${knowledge.summary_text ? `\nWebsite content summary:\n${knowledge.summary_text.substring(0, 800)}` : ''}

Use ALL of the above context to make every AI response specific to this business.
Do NOT ask questions whose answers are already in this context.`;

  return base + orgContext;
}

/**
 * The tool executor — called by the AI when it wants to use a tool.
 * Routes each tool call to the right service with the right org's credentials.
 */
async function makeToolExecutor(orgId) {
  const metaConn   = getMetaConnection(orgId);
  const googleConn = getGoogleConnection(orgId);

  return async function executeTool(toolName, args) {
    const toolDef = getToolDef(toolName);
    if (!toolDef) {
      return `Unknown tool: ${toolName}`;
    }

    // ── Meta tools ─────────────────────────────────────────────────────────
    if (['list_campaigns', 'get_campaign_insights', 'search_ad_library',
         'get_meta_leads', 'create_campaign', 'pause_campaign',
         'get_ad_account_info', 'search_interests', 'get_custom_audiences'].includes(toolName)) {

      if (!metaConn) {
        return `This organisation has not connected their Meta account yet. Ask them to visit /auth/meta?org_id=${orgId} to connect.`;
      }

      // Map our tool name to the MCP server's tool name
      const mcpToolName = toolDef.mcpTool || toolName;

      // Special handling for pause_campaign
      let mcpArgs = toolDef.mcpArgs ? toolDef.mcpArgs(args) : args;
      if (toolName === 'pause_campaign') {
        mcpArgs = { campaign_id: args.campaign_id, status: 'PAUSED' };
      }

      const result = await executeMetaTool(
        mcpToolName,
        mcpArgs,
        metaConn.access_token,
        metaConn.ad_account_id
      );

      return result.success ? result.data : `Meta API error: ${result.error}`;
    }

    // ── Google tools ────────────────────────────────────────────────────────
    if (['list_google_campaigns', 'get_keyword_ideas'].includes(toolName)) {
      if (!googleConn) {
        return `This organisation has not connected their Google Ads account yet.`;
      }

      const mcpArgs = toolDef.mcpArgs ? toolDef.mcpArgs(args) : args;
      const result = await executeGoogleTool(
        toolDef.mcpTool || toolName,
        { ...mcpArgs, customer_id: googleConn.customer_id },
        googleConn.refresh_token,
        googleConn.customer_id
      );

      return result.success ? result.data : `Google Ads error: ${result.error}`;
    }

    // ── Tavily web search ───────────────────────────────────────────────────
    if (toolName === 'search_web') {
      const result = await searchWeb(args.query, args.max_results || 5);
      if (!result.success) return `Tavily search error: ${result.error}`;

      const formatted = [
        result.answer ? `Summary: ${result.answer}\n` : '',
        'Search Results:',
        ...result.results.map((r, i) =>
          `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.content?.substring(0, 300)}...`
        ),
      ].join('\n');

      return formatted;
    }

    // ── Playwright website scraper ──────────────────────────────────────────
    if (toolName === 'scrape_website') {
      const result = await scrapeWebsite(args.url, args.extract || 'all');
      if (!result.success) return `Scraping error for ${args.url}: ${result.error}`;

      const formatted = [
        `Website: ${result.url}`,
        `Title: ${result.title}`,
        result.meta_description ? `Description: ${result.meta_description}` : '',
        result.headings?.length ? `\nMain headings:\n${result.headings.slice(0, 10).map(h => `- ${h}`).join('\n')}` : '',
        result.prices_found?.length ? `\nPricing found: ${result.prices_found.join(', ')}` : '',
        result.pricing_context?.length ? `\nPricing context:\n${result.pricing_context.slice(0, 5).map(p => `- ${p}`).join('\n')}` : '',
        result.full_text ? `\nPage content (excerpt):\n${result.full_text.substring(0, 1000)}` : '',
      ].filter(Boolean).join('\n');

      return formatted;
    }

    // ── Deep Research knowledge bases (Python sidecar) ──────────────────────
    if (toolName === 'list_research_companies') {
      const result = await researchClient.listCompanies();
      if (!result.success) return `Deep Research service error: ${result.error}`;

      const companies = result.items || [];
      if (companies.length === 0) {
        return 'No deep-research knowledge bases exist yet. The user can create one from the Deep Research module by submitting a company URL.';
      }
      return [
        'Available deep-research knowledge bases:',
        ...companies.map(c =>
          `- company key: "${c.company_key}" — ${c.display_name} (${c.chunk_count} chunks from: ${(c.doc_types || []).join(', ')}; updated ${c.updated_at})`
        ),
      ].join('\n');
    }

    if (toolName === 'ask_research_knowledge_base') {
      const result = await researchClient.ask(args.company, args.question);
      if (!result.success) return `Deep Research service error: ${result.error}`;

      const sources = (result.chunks_used || [])
        .map(c => `[#${c.id}] (${c.doc_type} — ${c.source_file})`)
        .join(', ');
      return [
        `Knowledge base answer for ${result.company}:`,
        result.answer,
        sources ? `\nSources: ${sources}` : '',
      ].filter(Boolean).join('\n');
    }

    return `Tool "${toolName}" not implemented`;
  };
}

/**
 * Main entry point — run the AI Analyst for an organisation.
 */
async function runAnalyst(orgId, userQuery, toolNames = null) {
  const knowledge = getKnowledge(orgId);
  const systemPrompt = buildSystemPrompt(orgId, knowledge);

  // Use specified tools or all tools
  const allTools = getAllToolDefs();
  const toolDefs = toolNames
    ? allTools.filter(t => toolNames.includes(t.name))
    : allTools;

  const executeTool = await makeToolExecutor(orgId);

  console.log(`\n=== AI Analyst for org=${orgId} ===`);
  console.log(`[runner] query: "${userQuery}"`);
  console.log(`[runner] tools available: ${toolDefs.map(t => t.name).join(', ')}`);

  // Try Gemini first
  try {
    console.log('[runner] trying Gemini...');
    const result = await runGemini(systemPrompt, userQuery, toolDefs, executeTool);
    console.log(`[runner] Gemini succeeded. Tools used: ${result.toolsUsed.join(', ') || 'none'}`);
    return { ...result, model: 'gemini-2.5-flash' };
  } catch (err) {
    const isUnavailable = GEMINI_UNAVAILABLE_CODES.some(code =>
      err.message.includes(String(code))
    ) || err.message.includes('429') || err.message.includes('quota') || err.message.includes('rate');

    if (!isUnavailable) {
      console.error('[runner] Gemini error (not availability issue):', err.message);
      throw err;
    }

    console.log(`[runner] Gemini unavailable (${err.message}). Falling back to Groq...`);
  }

  if (process.env.OPENROUTER_API_KEY) {
    console.log('[runner] Attempting OpenRouter (free models)...');
    try {
      const { runOpenRouter } = require('./openrouter');
      const result = await runOpenRouter(systemPrompt, userQuery, toolDefs, executeTool);
      console.log(`[runner] OpenRouter succeeded. Tools used: ${result.toolsUsed.join(', ') || 'none'}`);
      return { ...result, model: `openrouter/${result.model}` };
    } catch (err) {
      console.error('[runner] OpenRouter failed:', err.message);
      if (!process.env.GROQ_API_KEY) throw err; // Only throw if we have nothing else to try
    }
  }

  if (!process.env.GROQ_API_KEY) {
    throw new Error('Gemini is unavailable and neither GROQ_API_KEY nor OPENROUTER_API_KEY is set.');
  }

  // Try Groq with tools first
  try {
    const result = await runGroq(systemPrompt, userQuery, toolDefs, executeTool);
    console.log(`[runner] Groq succeeded. Tools used: ${result.toolsUsed.join(', ') || 'none'}`);
    return { ...result, model: 'groq/llama-3.3-70b' };
  } catch (err) {
    const isToolError = err.message.includes('tool_use_failed') ||
                        err.message.includes('tool_use') ||
                        err.message.includes('Failed to call a function');

    if (!isToolError) throw err;

    // Groq tool_use_failed — retry without tools using plain reasoning
    console.warn('[runner] Groq tool_use_failed — retrying without tools (plain mode)...');
    const result = await runGroq(systemPrompt, userQuery, [], executeTool);
    console.log('[runner] Groq plain mode succeeded.');
    return { ...result, model: 'groq/llama-3.3-70b (no-tools)' };
  }
}

module.exports = { runAnalyst, makeToolExecutor };
