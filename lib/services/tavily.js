/**
 * Web Search Service — DuckDuckGo (no API key, no expiry, free forever)
 *
 * Uses DuckDuckGo's Instant Answer API + HTML scraping as fallback.
 * Drop-in replacement for Tavily — same interface, zero configuration.
 *
 * If TAVILY_API_KEY is present and valid, Tavily is used instead (better results).
 * Otherwise falls back to DuckDuckGo automatically.
 */

const TAVILY_API = 'https://api.tavily.com/search';
const DDG_API    = 'https://api.duckduckgo.com/';

// ── DuckDuckGo search (no key needed) ─────────────────────────────────────────
async function searchDuckDuckGo(query, maxResults = 5) {
  console.log(`[duckduckgo] searching: "${query}"`);

  try {
    // DuckDuckGo Instant Answer API
    const params = new URLSearchParams({
      q:       query,
      format:  'json',
      no_html: '1',
      skip_disambig: '1',
    });

    const res  = await fetch(`${DDG_API}?${params}`, {
      headers: { 'User-Agent': 'LeadPilot/1.0' },
    });
    const data = await res.json();

    const results = [];

    // Abstract answer (Wikipedia-style summary)
    if (data.AbstractText) {
      results.push({
        title:   data.Heading || query,
        url:     data.AbstractURL || '',
        content: data.AbstractText,
        score:   1.0,
      });
    }

    // Related topics
    for (const topic of (data.RelatedTopics || [])) {
      if (results.length >= maxResults) break;
      if (topic.Text && topic.FirstURL) {
        results.push({
          title:   topic.Text.split(' - ')[0] || topic.Text,
          url:     topic.FirstURL,
          content: topic.Text,
          score:   0.8,
        });
      }
    }

    // If DDG Instant Answer didn't return enough, use DuckDuckGo HTML search
    if (results.length < 2) {
      const htmlResults = await searchDuckDuckGoHTML(query, maxResults);
      return htmlResults;
    }

    console.log(`[duckduckgo] returned ${results.length} results`);
    return {
      success: true,
      answer:  data.AbstractText || null,
      results,
    };
  } catch (err) {
    console.error('[duckduckgo] search failed:', err.message);
    return { success: false, error: err.message };
  }
}

// DuckDuckGo HTML scraping fallback (richer results)
async function searchDuckDuckGoHTML(query, maxResults = 5) {
  try {
    const params = new URLSearchParams({ q: query, kl: 'in-en' });
    const res = await fetch(`https://html.duckduckgo.com/html/?${params}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LeadPilot/1.0)',
        'Accept':     'text/html',
      },
    });
    const html = await res.text();

    // Extract results with simple regex (no DOM parser needed in Node)
    const results = [];
    const resultRegex = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/g;
    const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>([^<]+)<\/a>/g;

    let match;
    const urls    = [];
    const titles  = [];
    const snippets = [];

    while ((match = resultRegex.exec(html)) !== null) {
      urls.push(match[1]);
      titles.push(match[2]);
    }
    while ((match = snippetRegex.exec(html)) !== null) {
      snippets.push(match[1]);
    }

    for (let i = 0; i < Math.min(titles.length, maxResults); i++) {
      results.push({
        title:   titles[i]?.trim()    || '',
        url:     urls[i]?.trim()      || '',
        content: snippets[i]?.trim()  || titles[i]?.trim() || '',
        score:   1 - (i * 0.1),
      });
    }

    console.log(`[duckduckgo-html] returned ${results.length} results`);
    return { success: true, answer: null, results };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ── Tavily search (if valid key is configured) ────────────────────────────────
async function searchTavily(query, maxResults = 5) {
  const res = await fetch(TAVILY_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.TAVILY_API_KEY,
    },
    body: JSON.stringify({
      query,
      max_results:         maxResults,
      search_depth:        'advanced',
      include_answer:      true,
      include_raw_content: false,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Tavily API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return {
    success: true,
    answer:  data.answer,
    results: (data.results || []).map(r => ({
      title:   r.title,
      url:     r.url,
      content: r.content,
      score:   r.score,
    })),
  };
}

// ── Main export — auto-selects best available provider ────────────────────────
async function searchWeb(query, maxResults = 5) {
  // Try Tavily first if a key is configured
  if (process.env.TAVILY_API_KEY) {
    try {
      console.log(`[search] trying Tavily for: "${query}"`);
      const result = await searchTavily(query, maxResults);
      console.log(`[tavily] returned ${result.results?.length || 0} results`);
      return result;
    } catch (err) {
      console.warn(`[search] Tavily failed (${err.message}), falling back to DuckDuckGo`);
    }
  }

  // Fallback: DuckDuckGo (always works, no key needed)
  return searchDuckDuckGo(query, maxResults);
}

module.exports = { searchWeb };
