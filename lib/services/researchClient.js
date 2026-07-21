/**
 * Research Client — HTTP client for the BI Research Agent sidecar.
 *
 * The sidecar is the Python FastAPI service (api.py, uvicorn on port 8000)
 * that runs deep research jobs (report / leads / profile) and answers
 * questions from per-company RAG knowledge stores. It runs as a persistent
 * process alongside this server (see start.bat) — everything here is a
 * plain server-to-server fetch, same pattern as the Tavily service.
 */

const BASE = () => process.env.RESEARCH_API_BASE_URL || 'http://localhost:8000';

// Shared secret for the sidecar (optional). When RESEARCH_API_KEY is set the
// sidecar rejects any /api/* request without a matching X-API-Key header.
function authHeaders(extra = {}) {
  const key = process.env.RESEARCH_API_KEY;
  return key ? { ...extra, 'X-API-Key': key } : { ...extra };
}

async function postJson(path, body) {
  try {
    const res = await fetch(`${BASE()}${path}`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { success: false, error: data.detail || `Research API error (${res.status})` };
    }
    return { success: true, ...data };
  } catch (err) {
    return { success: false, error: `Research service unreachable: ${err.message}` };
  }
}

async function getJson(path) {
  try {
    const res = await fetch(`${BASE()}${path}`, { headers: authHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { success: false, error: data.detail || `Research API error (${res.status})` };
    }
    // Python list endpoints return bare arrays — wrap them
    return Array.isArray(data) ? { success: true, items: data } : { success: true, ...data };
  } catch (err) {
    return { success: false, error: `Research service unreachable: ${err.message}` };
  }
}

// ── Jobs ──────────────────────────────────────────────────────────────────────

function createReportJob({ topic, no_pdf = false, memory_key = '' }) {
  return postJson('/api/jobs/report', { topic, no_pdf, memory_key });
}

function createLeadsJob({ company_url, audience = '', count = 150, no_pdf = false, memory_key = '', location = '', radius_km = 80 }) {
  return postJson('/api/jobs/leads', { company_url, audience, count, no_pdf, memory_key, location, radius_km });
}

function createProfileJob({ company_name_or_url, no_pdf = false, memory_key = '' }) {
  return postJson('/api/jobs/profile', { company_name_or_url, no_pdf, memory_key });
}

function listAllJobs() {
  return getJson('/api/jobs');
}

function getJob(jobId) {
  return getJson(`/api/jobs/${encodeURIComponent(jobId)}`);
}

async function getJobLog(jobId) {
  try {
    const res = await fetch(`${BASE()}/api/jobs/${encodeURIComponent(jobId)}/log`, { headers: authHeaders() });
    if (!res.ok) return { success: false, error: `Research API error (${res.status})` };
    return { success: true, log: await res.text() };
  } catch (err) {
    return { success: false, error: `Research service unreachable: ${err.message}` };
  }
}

// ── RAG knowledge stores ──────────────────────────────────────────────────────

function listCompanies() {
  return getJson('/api/companies');
}

function ask(company, question) {
  return postJson('/api/ask', { company, question });
}

// ── Downloads ─────────────────────────────────────────────────────────────────

// Returns the raw fetch Response so the caller can stream/forward headers.
function downloadFile(path) {
  return fetch(`${BASE()}/api/download?path=${encodeURIComponent(path)}`, { headers: authHeaders() });
}

module.exports = {
  createReportJob,
  createLeadsJob,
  createProfileJob,
  listAllJobs,
  getJob,
  getJobLog,
  listCompanies,
  ask,
  downloadFile,
};
