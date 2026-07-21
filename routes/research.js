/**
 * Deep Research routes — proxy to the BI Research Agent sidecar (Python, port 8000).
 *
 * The sidecar owns job execution state (its own jobs.db), logs, output files,
 * and the RAG knowledge stores. This router adds the org layer on top:
 * every job started here is recorded in research_jobs so orgs only see
 * their own jobs.
 */

const express = require('express');
const router  = express.Router();

const research = require('../lib/services/researchClient');
const { checkOrgToken } = require('../lib/authz');
const {
  getOrg,
  saveResearchJob, getResearchJob, getResearchJobsForOrg,
} = require('../lib/db');

// Namespace a company key to its org so RAG stores are isolated per tenant.
const orgKey = (orgId, companyUrl) => `${orgId}::${companyUrl}`;
const stripOrgKey = (orgId, key) =>
  key && key.startsWith(`${orgId}::`) ? key.slice(orgId.length + 2) : key;

// ── Middleware ────────────────────────────────────────────────
function withOrg(req, res, next) {
  const orgId = req.body?.org_id || req.query?.org_id;
  if (!orgId) return res.status(400).json({ error: 'org_id required' });
  const org = getOrg(orgId);
  if (!org) return res.status(404).json({ error: `Organisation "${orgId}" not found. Create it first.` });
  if (!checkOrgToken(req, org)) {
    return res.status(401).json({ error: 'Unauthorized: missing or invalid org token' });
  }
  req.orgId = orgId;
  req.org   = org;
  next();
}

// Job must exist in research_jobs and belong to the requesting org.
function withOwnedJob(req, res, next) {
  const job = getResearchJob(req.params.jobId);
  if (!job || job.org_id !== req.orgId) {
    return res.status(404).json({ error: 'Job not found for this organisation' });
  }
  req.researchJob = job;
  next();
}

// ── Start jobs ────────────────────────────────────────────────

router.post('/jobs/report', withOrg, async (req, res) => {
  const { company_url, audience } = req.body;
  if (!company_url) return res.status(400).json({ error: 'company_url required' });

  const topic = (audience || '').trim() || company_url;
  const mkey = orgKey(req.orgId, company_url);
  const result = await research.createReportJob({ topic, memory_key: mkey });
  if (!result.success) return res.status(502).json({ error: result.error });

  saveResearchJob({ id: result.job_id, orgId: req.orgId, jobType: 'report', memoryKey: mkey, label: topic });
  res.json({ success: true, job_id: result.job_id });
});

router.post('/jobs/leads', withOrg, async (req, res) => {
  const { company_url, audience, count, location, radius_km } = req.body;
  if (!company_url) return res.status(400).json({ error: 'company_url required' });

  const mkey = orgKey(req.orgId, company_url);
  const result = await research.createLeadsJob({
    company_url,
    audience: audience || '',
    count: Number(count) || 150,
    memory_key: mkey,
    location: (location || '').trim(),
    radius_km: Number(radius_km) || 80,
  });
  if (!result.success) return res.status(502).json({ error: result.error });

  saveResearchJob({ id: result.job_id, orgId: req.orgId, jobType: 'leads', memoryKey: mkey, label: company_url });
  res.json({ success: true, job_id: result.job_id });
});

router.post('/jobs/profile', withOrg, async (req, res) => {
  const { company_url } = req.body;
  if (!company_url) return res.status(400).json({ error: 'company_url required' });

  const mkey = orgKey(req.orgId, company_url);
  const result = await research.createProfileJob({ company_name_or_url: company_url, memory_key: mkey });
  if (!result.success) return res.status(502).json({ error: result.error });

  saveResearchJob({ id: result.job_id, orgId: req.orgId, jobType: 'profile', memoryKey: mkey, label: company_url });
  res.json({ success: true, job_id: result.job_id });
});

// ── Poll jobs ─────────────────────────────────────────────────

router.get('/jobs', withOrg, async (req, res) => {
  const owned = getResearchJobsForOrg(req.orgId);
  if (owned.length === 0) return res.json({ success: true, jobs: [] });

  const result = await research.listAllJobs();
  if (!result.success) return res.status(502).json({ error: result.error });

  const byId = new Map((result.items || []).map(j => [j.id, j]));
  const jobs = owned.map(o => {
    const p = byId.get(o.id) || {};
    return {
      id: o.id,
      job_type: o.job_type,
      memory_key: stripOrgKey(req.orgId, o.memory_key),
      label: o.label,
      status: p.status || 'unknown',
      result_files: typeof p.result_files === 'string' ? JSON.parse(p.result_files) : (p.result_files || null),
      created_at: p.created_at || o.created_at,
    };
  });
  res.json({ success: true, jobs });
});

router.get('/jobs/:jobId', withOrg, withOwnedJob, async (req, res) => {
  const result = await research.getJob(req.params.jobId);
  if (!result.success) return res.status(502).json({ error: result.error });

  res.json({
    success: true,
    job: {
      id: result.id,
      job_type: req.researchJob.job_type,
      memory_key: stripOrgKey(req.orgId, req.researchJob.memory_key),
      label: req.researchJob.label,
      status: result.status,
      result_files: result.result_files || null,
      created_at: result.created_at,
    },
  });
});

router.get('/jobs/:jobId/log', withOrg, withOwnedJob, async (req, res) => {
  const result = await research.getJobLog(req.params.jobId);
  if (!result.success) return res.status(502).type('text/plain').send(result.error);
  res.type('text/plain').send(result.log);
});

// ── RAG knowledge stores ──────────────────────────────────────

router.get('/companies', withOrg, async (req, res) => {
  const result = await research.listCompanies();
  if (!result.success) return res.status(502).json({ error: result.error });

  const prefix = `${req.orgId}::`;
  // Only surface stores that belong to this org, with the org prefix stripped.
  const companies = (result.items || [])
    .filter(c => typeof c.company_key === 'string' && c.company_key.startsWith(prefix))
    .map(c => ({ ...c, company_key: stripOrgKey(req.orgId, c.company_key), owned: true }));
  res.json({ success: true, companies });
});

router.post('/ask', withOrg, async (req, res) => {
  const { company, question } = req.body;
  if (!company || !question?.trim()) {
    return res.status(400).json({ error: 'company and question required' });
  }

  // Ownership: the org may only ask about a company it actually researched.
  const mkey = orgKey(req.orgId, company);
  const owned = getResearchJobsForOrg(req.orgId).some(j => j.memory_key === mkey);
  if (!owned) return res.status(404).json({ error: 'No knowledge base for this company in your organisation' });

  const result = await research.ask(mkey, question.trim());
  if (!result.success) return res.status(502).json({ error: result.error });
  res.json({ success: true, answer: result.answer, chunks_used: result.chunks_used, company });
});

// ── Downloads ─────────────────────────────────────────────────

router.get('/download', withOrg, async (req, res) => {
  const { path } = req.query;
  if (!path) return res.status(400).json({ error: 'path required' });

  // Ownership: the requested path must be a result file of one of this org's jobs.
  const ownedIds = new Set(getResearchJobsForOrg(req.orgId).map(j => j.id));
  const all = await research.listAllJobs();
  if (!all.success) return res.status(502).json({ error: all.error });
  const allowed = new Set();
  for (const j of (all.items || [])) {
    if (!ownedIds.has(j.id)) continue;
    let files = j.result_files;
    if (typeof files === 'string') { try { files = JSON.parse(files); } catch { files = null; } }
    if (files && typeof files === 'object') {
      for (const v of Object.values(files)) if (typeof v === 'string') allowed.add(v);
    }
  }
  if (!allowed.has(path)) {
    return res.status(403).json({ error: 'Forbidden: file does not belong to your organisation' });
  }

  try {
    const upstream = await research.downloadFile(path);
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: `Download failed (${upstream.status})` });
    }
    const type = upstream.headers.get('content-type');
    const disposition = upstream.headers.get('content-disposition');
    if (type) res.set('Content-Type', type);
    if (disposition) res.set('Content-Disposition', disposition);
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    res.status(502).json({ error: `Research service unreachable: ${err.message}` });
  }
});

module.exports = router;
