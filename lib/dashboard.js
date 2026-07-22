/**
 * Unified dashboard aggregation (spec §7). Combines the Ad Manager's own leads
 * with the shared telecaller call-quality data (lead_analysis) and, when Meta is
 * connected, live ad insights — one org-scoped snapshot.
 */
const { getServiceClient } = require('./supabase');
const { getMetaConnection } = require('./connections');
const { executeMetaTool } = require('./services/metaGraph');

const sb = () => getServiceClient();
const DAY = 24 * 60 * 60 * 1000;

async function dashboardSummary(orgId) {
  // Lead funnel (Supabase)
  const { data: leadsData } = await sb().from('leads')
    .select('status,pipeline_stage,deal_value,closed_at').eq('org_id', orgId);
  const leads = leadsData || [];
  const byStatus = {};
  const byStage = {};
  for (const l of leads) {
    if (l.status) byStatus[l.status] = (byStatus[l.status] || 0) + 1;
    if (l.pipeline_stage) byStage[l.pipeline_stage] = (byStage[l.pipeline_stage] || 0) + 1;
  }
  const closedRevenue = leads.filter((l) => l.closed_at).reduce((s, l) => s + (l.deal_value || 0), 0);

  // Call quality (shared lead_analysis — telecaller AI scoring)
  const { data: laData } = await sb().from('lead_analysis')
    .select('lead_verdict,bant_score').eq('org_id', orgId);
  const la = laData || [];
  const byVerdict = {};
  for (const a of la) if (a.lead_verdict) byVerdict[a.lead_verdict] = (byVerdict[a.lead_verdict] || 0) + 1;
  const avgBant = la.length ? Math.round(la.reduce((s, a) => s + (a.bant_score || 0), 0) / la.length) : null;

  // Ad insights (Meta, only if connected)
  let ads = { connected: false };
  const conn = await getMetaConnection(orgId);
  if (conn) {
    const r = await executeMetaTool('get_insights', { date_preset: 'last_30d' }, conn.access_token, conn.ad_account_id);
    ads = r.success ? { connected: true, insights: r.data } : { connected: true, error: r.error };
  }

  return {
    leads: { total: leads.length, by_status: byStatus, by_pipeline_stage: byStage, closed_won_revenue: closedRevenue },
    call_quality: { analysed: la.length, by_verdict: byVerdict, avg_bant_score: avgBant },
    ads,
  };
}

// ── Drill-down views (spec §7) ──────────────────────────────────────

// Funnel: leads → analysed calls → qualified (Hot/Warm) → booked (Closed Won).
// (Impressions/clicks need Meta; they attach once connected.)
async function funnel(orgId) {
  const { data: leads } = await sb().from('leads').select('pipeline_stage,closed_at').eq('org_id', orgId);
  const { data: la } = await sb().from('lead_analysis').select('lead_verdict').eq('org_id', orgId);
  const L = leads || [];
  const A = la || [];
  return {
    leads: L.length,
    calls_analysed: A.length,
    qualified: A.filter((a) => a.lead_verdict === 'Hot' || a.lead_verdict === 'Warm').length,
    booked: L.filter((l) => l.closed_at || l.pipeline_stage === 'Closed Won').length,
  };
}

// Per-telecaller cross-reference: lead load + conversions.
async function byTelecaller(orgId) {
  const { data: leads } = await sb().from('leads').select('assigned_to,closed_at,pipeline_stage').eq('org_id', orgId);
  const { data: users } = await sb().from('users').select('id,name').eq('org_id', orgId);
  const nameOf = Object.fromEntries((users || []).map((u) => [u.id, u.name]));
  const map = {};
  for (const l of leads || []) {
    const key = l.assigned_to || 'unassigned';
    map[key] = map[key] || { leads: 0, converted: 0 };
    map[key].leads += 1;
    if (l.closed_at || l.pipeline_stage === 'Closed Won') map[key].converted += 1;
  }
  return Object.entries(map).map(([id, v]) => ({ telecaller: nameOf[id] || id, ...v }));
}

// Weekly lead-quality trend from lead_analysis.
async function qualityTrend(orgId, weeks = 6) {
  const { data: la } = await sb().from('lead_analysis').select('bant_score,created_at').eq('org_id', orgId);
  const A = la || [];
  const now = Date.now();
  const out = [];
  for (let w = weeks - 1; w >= 0; w -= 1) {
    const start = now - (w + 1) * 7 * DAY;
    const end = now - w * 7 * DAY;
    const wk = A.filter((a) => { const t = new Date(a.created_at).getTime(); return t >= start && t < end; });
    out.push({
      weeks_ago: w,
      count: wk.length,
      avg_bant: wk.length ? Math.round(wk.reduce((s, a) => s + (a.bant_score || 0), 0) / wk.length) : null,
    });
  }
  return out;
}

async function dashboardDetail(orgId) {
  const [f, t, q] = await Promise.all([funnel(orgId), byTelecaller(orgId), qualityTrend(orgId)]);
  return { funnel: f, by_telecaller: t, quality_trend: q };
}

module.exports = { dashboardSummary, dashboardDetail, funnel, byTelecaller, qualityTrend };
