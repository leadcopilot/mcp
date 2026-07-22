/**
 * Auto monthly report (spec §8). Gemini writes a founder-ready summary grounded
 * ONLY in the real aggregated numbers — no invented data.
 */
const { dashboardSummary } = require('./dashboard');
const { getOrgKnowledge } = require('./org');
const { checkAlerts } = require('./roiMonitor');
const { geminiText } = require('./ai/geminiClient');

async function monthlyReport(orgId) {
  const [k, data, alerts] = await Promise.all([
    getOrgKnowledge(orgId), dashboardSummary(orgId), checkAlerts(orgId),
  ]);
  const sys = 'You are the LeadPilot Ad Manager. Write a concise monthly performance report for the founder, grounded ONLY in the provided data — never invent numbers. Sections: Executive Summary, Lead Performance, Call Quality, Wasted-Spend / Alerts, Recommendations for next month.';
  const prompt = `Business: ${k?.business_name || 'Unknown'} (${k?.industry || ''})\nData: ${JSON.stringify(data)}\nROI alerts this period: ${JSON.stringify(alerts.alerts)}`;
  const report = await geminiText([{ role: 'system', content: sys }, { role: 'user', content: prompt }], { maxTokens: 2000 });
  return { org: k?.business_name, generated_at: new Date().toISOString(), data, alerts: alerts.alerts, report };
}

module.exports = { monthlyReport };
