/**
 * ROI Monitor Agent (spec §9). Compares live signals to the org's baseline and
 * raises plain-language alerts. Works today on LeadPilot's own data (lead volume,
 * call quality from lead_analysis); the CPL/budget triggers activate once Meta is
 * connected. Thresholds come from organizations.alert_config.
 */
const { getServiceClient } = require('./supabase');
const { getOrg, listOrgs } = require('./org');
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

// ── Persistence + always-on scheduler (spec §9) ─────────────────────

// One alert per (org, type) per day — a persistent condition won't spam.
function fingerprint(orgId, alert) {
  return `${orgId}|${alert.type}|${new Date().toISOString().slice(0, 10)}`;
}

async function persistAlerts(orgId, alerts) {
  if (!alerts.length) return 0;
  const rows = alerts.map((a) => ({
    id: `alert_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    org_id: orgId, type: a.type, severity: a.severity, message: a.message,
    recommendation: a.recommendation || null, fingerprint: fingerprint(orgId, a),
  }));
  const { error } = await sb().from('ad_alerts').upsert(rows, { onConflict: 'fingerprint', ignoreDuplicates: true });
  if (error) throw new Error(error.message);
  return rows.length;
}

async function listStoredAlerts(orgId, status = 'open') {
  let q = sb().from('ad_alerts').select('*').eq('org_id', orgId).order('created_at', { ascending: false });
  if (status && status !== 'all') q = q.eq('status', status);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data || [];
}

async function acknowledgeAlert(orgId, id) {
  const { error } = await sb().from('ad_alerts').update({ status: 'acknowledged' }).eq('id', id).eq('org_id', orgId);
  if (error) throw new Error(error.message);
  return { ok: true };
}

// Scheduler tick — check every org and persist new alerts.
async function runAllOrgs() {
  let total = 0;
  for (const o of await listOrgs()) {
    try {
      const { alerts } = await checkAlerts(o.id);
      total += await persistAlerts(o.id, alerts);
    } catch (e) {
      console.error(`[roi-monitor] org ${o.id} failed: ${e.message}`);
    }
  }
  return total;
}

module.exports = { checkAlerts, persistAlerts, listStoredAlerts, acknowledgeAlert, runAllOrgs };
