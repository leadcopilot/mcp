/**
 * AI Analyst (spec §4) — plain-language Q&A grounded in the org's knowledge base.
 * Tools (Meta campaign data, competitor web search) are passed in by the caller as
 * they come online; with no tools it answers from the org profile alone.
 */
const { getOrgKnowledge } = require('../org');
const { geminiToolLoop } = require('./geminiClient');

function buildSystemPrompt(k) {
  return `You are the LeadPilot Ad Manager AI Analyst. You help an ad manager understand campaigns, competitors, and marketing for THIS specific business. Ground every answer in the business profile below. Be concrete and concise; if you lack the data to answer, say so plainly instead of guessing.\n\nBUSINESS PROFILE:\n${JSON.stringify(k, null, 2)}`;
}

async function runAnalyst(orgId, query, { tools = [], executeTool } = {}) {
  if (!query) throw new Error('query is required');
  const k = await getOrgKnowledge(orgId);
  const exec = executeTool || (async () => 'No tool available.');
  const { answer, toolsUsed } = await geminiToolLoop(
    [{ role: 'system', content: buildSystemPrompt(k) }, { role: 'user', content: query }],
    tools, exec,
  );
  return { answer, tools_used: toolsUsed };
}

module.exports = { runAnalyst, buildSystemPrompt };
