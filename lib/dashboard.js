/**
 * Unified dashboard aggregation (spec §7). Combines the Ad Manager's own leads
 * with the shared telecaller call-quality data (lead_analysis) and, when Meta is
 * connected, live ad insights — one org-scoped snapshot.
 */
const { getServiceClient } = require('./supabase');
const { getMetaConnection } = require('./connections');
const { executeMetaTool } = require('./services/metaGraph');

const sb = () => getServiceClient();

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

module.exports = { dashboardSummary };
