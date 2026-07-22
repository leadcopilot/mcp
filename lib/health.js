const { isConfigured, getServiceClient } = require('./supabase');

async function supabaseOk() {
  if (!isConfigured()) return false;
  try {
    const { error } = await getServiceClient().from('organisations').select('id').limit(1);
    return !error;
  } catch { return false; }
}

async function checkHealth() {
  let playwright = false;
  try {
    const { chromium } = require('playwright');
    const fs = require('fs');
    const p = chromium.executablePath();
    playwright = !!(p && fs.existsSync(p));
  } catch {}

  return {
    status: 'ok',
    time: new Date().toISOString(),
    env: {
      supabase: await supabaseOk(),
      gemini: !!(process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY),
      groq: !!process.env.GROQ_API_KEY,
      meta: !!(process.env.META_APP_ID && process.env.META_APP_SECRET),
      google: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_DEVELOPER_TOKEN),
      search: process.env.TAVILY_API_KEY ? 'tavily' : 'duckduckgo',
      playwright,
    },
  };
}

module.exports = { checkHealth };
