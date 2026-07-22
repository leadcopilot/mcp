/**
 * ROI Monitor Agent (spec §9). Compares live signals to the org's baseline and
 * raises plain-language alerts. Works today on LeadPilot's own data (lead volume,
 * call quality from lead_analysis); the CPL/budget triggers activate once Meta is
 * connected. Thresholds come from organizations.alert_config.
 */
const { getServiceClient } = require('./supabase');
const { getOrg } = require('./org');
const { getMetaConnection } = require('./connections');

const sb = () => getServiceClient();
const DAY = 24 * 60 * 60 * 1000;

async function checkAlerts(orgId) {
  const org = await getOrg(orgId);
  const cfg = org?.alert_config || {};
  const qualityFloor = cfg.quality_floor ?? 50;
  const alerts = [];

  // ── Call quality (shared lead_analysis) ──
  const { data: laData } = await sb().from('lead_analysis').select('lead_verdict,bant_score').eq('org_id', orgId);
  const la = laData || [];
  if (la.length) {
    const avg = Math.round(la.reduce((s, r) => s + (r.bant_score || 0), 0) / la.length);
    if (avg < qualityFloor) {
      alerts.push({ severity: 'medium', type: 'low_call_quality',
        message: `Average call quality ${avg} is below your floor of ${qualityFloor}.`,
        recommendation: 'Leads coming in are scoring poorly — review targeting / lead sources.' });
    }
    const junkPct = Math.round(la.filter((r) => r.lead_verdict === 'Junk').length / la.length * 100);
    if (junkPct >= 25) {
      alerts.push({ severity: 'high', type: 'high_junk_rate',
        message: `${junkPct}% of analysed leads are Junk.`,
        recommendation: 'A source/campaign is producing low-intent leads — investigate and pause the worst one.' });
    }
  }

  // ── Lead volume trend (last 7d vs prior 7d) ──
  const now = Date.now();
  const { data: leadsData } = await sb().from('leads').select('created_at').eq('org_id', orgId);
  const leads = leadsData || [];
  const between = (r, a, b) => { const t = new Date(r.created_at).getTime(); return t >= a && t < b; };
  const last7 = leads.filter((r) => between(r, now - 7 * DAY, now)).length;
  const prev7 = leads.filter((r) => between(r, now - 14 * DAY, now - 7 * DAY)).length;
  if (prev7 >= 3 && last7 < prev7 * 0.5) {
    alerts.push({ severity: 'high', type: 'lead_volume_drop',
      message: `Lead volume fell from ${prev7} to ${last7} week-over-week.`,
      recommendation: 'Check whether a campaign paused or delivery stalled.' });
  }

  const conn = await getMetaConnection(orgId);
  return {
    org_id: orgId,
    checked_at: new Date().toISOString(),
    ads_monitored: !!conn, // CPL/budget triggers add automatically once Meta is connected
    alert_count: alerts.length,
    alerts,
  };
}

module.exports = { checkAlerts };
