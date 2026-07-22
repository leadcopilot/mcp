/**
 * Competitor intelligence (spec §5 / module). Live web search + website scrape +
 * AI analysis grounded in the org's profile. Reuses the existing services.
 */
const { searchWeb } = require('./services/tavily');
const { scrapeWebsite } = require('./services/scraper');
const { getOrgKnowledge } = require('./org');
const { geminiText } = require('./ai/geminiClient');

async function webSearch(query, maxResults = 5) {
  return searchWeb(query, maxResults);
}

async function scrape(url, extract = 'all') {
  return scrapeWebsite(url, extract);
}

async function analyse(orgId, { competitor_name, industry, location } = {}) {
  const k = await getOrgKnowledge(orgId);
  const sys = 'You are a competitive marketing analyst. Compare the named competitor to OUR business using the provided profile. Give concrete angles: positioning, likely offers, and how we should differentiate. Do not invent specific facts you cannot infer.';
  const prompt = `Our business: ${JSON.stringify(k)}\nCompetitor: ${competitor_name} (industry: ${industry || k?.industry || 'unknown'}, location: ${location || 'unknown'})`;
  const analysis = await geminiText([{ role: 'system', content: sys }, { role: 'user', content: prompt }]);
  return { competitor: competitor_name, analysis };
}

module.exports = { webSearch, scrape, analyse };
