/**
 * Leads — reads/writes the SHARED LeadPilot `leads` table (same rows the telecaller
 * portal uses). Additive + conflict-safe: adding a lead NEVER overwrites an existing
 * one (the telecaller may own it). Org-scoped in code by the JWT's org_id.
 */
const { getServiceClient } = require('./supabase');
const sb = () => getServiceClient();

function contactKeyFrom(lead) {
  const phone = (lead.phone || '').replace(/\D/g, '');
  if (phone) return phone;
  if (lead.email) return String(lead.email).toLowerCase();
  return `${(lead.name || 'lead').toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`;
}

async function listLeads(orgId, { status = null, limit = 100 } = {}) {
  let q = sb().from('leads').select('*').eq('org_id', orgId)
    .order('created_at', { ascending: false }).limit(limit);
  if (status && status !== 'All') q = q.eq('status', status);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data || [];
}

async function leadStats(orgId) {
  const { data, error } = await sb().from('leads').select('status').eq('org_id', orgId);
  if (error) throw new Error(error.message);
  const rows = data || [];
  const c = (s) => rows.filter((r) => r.status === s).length;
  return { total: rows.length, new: c('new'), contacted: c('contacted'),
    qualified: c('qualified'), converted: c('converted'), lost: c('lost') };
}

async function addLead(orgId, lead) {
  const id = `lead_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const row = {
    id, org_id: orgId, contact_key: contactKeyFrom(lead),
    name: lead.name || null, phone: lead.phone || null,
    source: lead.source || 'meta', reason: lead.reason || null,
    status: 'new', pipeline_stage: 'New',
    // §11 campaign→lead attribution
    source_campaign: lead.source_campaign || null,
    source_ad_id: lead.source_ad_id || null,
    meta_lead_id: lead.meta_lead_id || null,
    platform: lead.platform || null,
  };
  // ignoreDuplicates on the (org_id, contact_key) unique constraint — never clobber
  // a lead the telecaller already owns.
  const { error } = await sb().from('leads').upsert(row, { onConflict: 'org_id,contact_key', ignoreDuplicates: true });
  if (error) throw new Error(error.message);
  return row;
}

async function updateLeadStatus(orgId, leadId, { status, pipeline_stage }) {
  const patch = { updated_at: new Date().toISOString() };
  if (status) patch.status = status;
  if (pipeline_stage) patch.pipeline_stage = pipeline_stage;
  const { error } = await sb().from('leads').update(patch).eq('id', leadId).eq('org_id', orgId);
  if (error) throw new Error(error.message);
  return { ok: true };
}

module.exports = { listLeads, leadStats, addLead, updateLeadStatus };
