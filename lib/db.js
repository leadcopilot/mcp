const Database = require('better-sqlite3');
const path = require('path');
const { encrypt, decrypt, randomToken } = require('./crypto');

const DB_PATH = path.join(__dirname, '..', 'leadpilot.db');
let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
    runMigrations();
  }
  return db;
}

// Idempotent column additions for databases created before a column existed.
function runMigrations() {
  const cols = db.prepare(`PRAGMA table_info(organisations)`).all().map(c => c.name);
  if (!cols.includes('api_token')) {
    db.exec(`ALTER TABLE organisations ADD COLUMN api_token TEXT`);
    // Backfill tokens for any org created before auth existed.
    const orgs = db.prepare(`SELECT id FROM organisations WHERE api_token IS NULL`).all();
    const upd = db.prepare(`UPDATE organisations SET api_token = ? WHERE id = ?`);
    for (const o of orgs) upd.run(randomToken(), o.id);
  }
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS organisations (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      website     TEXT,
      industry    TEXT,
      api_token   TEXT,
      created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS meta_connections (
      org_id          TEXT PRIMARY KEY REFERENCES organisations(id),
      access_token    TEXT NOT NULL,
      ad_account_id   TEXT,
      page_id         TEXT,
      scope           TEXT,
      connected_at    TEXT DEFAULT (datetime('now')),
      expires_at      TEXT
    );

    CREATE TABLE IF NOT EXISTS google_connections (
      org_id            TEXT PRIMARY KEY REFERENCES organisations(id),
      access_token      TEXT,
      refresh_token     TEXT NOT NULL,
      customer_id       TEXT,
      connected_at      TEXT DEFAULT (datetime('now')),
      expires_at        TEXT
    );

    CREATE TABLE IF NOT EXISTS oauth_states (
      state       TEXT PRIMARY KEY,
      org_id      TEXT NOT NULL,
      provider    TEXT NOT NULL,
      created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS org_knowledge (
      org_id      TEXT PRIMARY KEY REFERENCES organisations(id),
      data        TEXT,
      enriched_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS leads (
      id              TEXT PRIMARY KEY,
      org_id          TEXT NOT NULL REFERENCES organisations(id),
      name            TEXT,
      phone           TEXT,
      email           TEXT,
      source          TEXT DEFAULT 'manual',
      source_campaign TEXT,
      source_ad_id    TEXT,
      platform        TEXT DEFAULT 'meta',
      status          TEXT DEFAULT 'New',
      assigned_to     TEXT,
      company         TEXT,
      linkedin_url    TEXT,
      notes           TEXT,
      is_duplicate    INTEGER DEFAULT 0,
      duplicate_of    TEXT,
      captured_at     TEXT DEFAULT (datetime('now')),
      updated_at      TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS campaigns_cache (
      id          TEXT PRIMARY KEY,
      org_id      TEXT NOT NULL,
      platform    TEXT NOT NULL,
      name        TEXT,
      status      TEXT,
      objective   TEXT,
      budget      TEXT,
      spend       REAL,
      impressions INTEGER,
      clicks      INTEGER,
      ctr         REAL,
      cpc         REAL,
      conversions INTEGER,
      roas        REAL,
      reach       INTEGER,
      frequency   REAL,
      cpl         REAL,
      diagnostic  TEXT,
      fetched_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS keywords_cache (
      id          TEXT PRIMARY KEY,
      org_id      TEXT NOT NULL,
      keyword     TEXT NOT NULL,
      volume      INTEGER,
      difficulty  INTEGER,
      cpc_low     REAL,
      cpc_high    REAL,
      intent      TEXT,
      trend       TEXT,
      created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS social_metrics (
      id           TEXT PRIMARY KEY,
      org_id       TEXT NOT NULL,
      platform     TEXT NOT NULL,
      followers    INTEGER,
      posts_30d    INTEGER,
      avg_reach    INTEGER,
      engagement   REAL,
      fetched_at   TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS social_connections (
      id           TEXT PRIMARY KEY,
      org_id       TEXT NOT NULL,
      platform     TEXT NOT NULL,
      access_token TEXT,
      refresh_token TEXT,
      page_id      TEXT,
      page_name    TEXT,
      channel_id   TEXT,
      profile_id   TEXT,
      username     TEXT,
      scope        TEXT,
      expires_at   TEXT,
      connected_at TEXT DEFAULT (datetime('now')),
      UNIQUE(org_id, platform)
    );

    CREATE TABLE IF NOT EXISTS social_metrics_history (
      id           TEXT PRIMARY KEY,
      org_id       TEXT NOT NULL,
      platform     TEXT NOT NULL,
      followers    INTEGER DEFAULT 0,
      posts_30d    INTEGER DEFAULT 0,
      avg_reach    INTEGER DEFAULT 0,
      engagement   REAL DEFAULT 0,
      impressions  INTEGER DEFAULT 0,
      views        INTEGER DEFAULT 0,
      recorded_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS research_jobs (
      id          TEXT PRIMARY KEY,
      org_id      TEXT NOT NULL REFERENCES organisations(id),
      job_type    TEXT NOT NULL,
      memory_key  TEXT NOT NULL,
      label       TEXT,
      created_at  TEXT DEFAULT (datetime('now'))
    );
  `);
}

// ── Organisation ──────────────────────────────────────────────
function createOrg(id, name) {
  getDb().prepare('INSERT OR IGNORE INTO organisations (id, name, api_token) VALUES (?, ?, ?)')
    .run(id, name, randomToken());
  return getOrg(id);
}
function getOrg(id) {
  return getDb().prepare('SELECT * FROM organisations WHERE id = ?').get(id);
}
function listOrgs() {
  return getDb().prepare('SELECT * FROM organisations ORDER BY name').all();
}
function updateOrg(id, fields) {
  const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  getDb().prepare(`UPDATE organisations SET ${sets} WHERE id = ?`).run(...Object.values(fields), id);
}

// ── Meta ─────────────────────────────────────────────────────
function saveMetaConnection(orgId, token, adAccountId, scope, expiresAt) {
  getDb().prepare(`
    INSERT INTO meta_connections (org_id, access_token, ad_account_id, scope, expires_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(org_id) DO UPDATE SET
      access_token = excluded.access_token,
      ad_account_id = excluded.ad_account_id,
      scope = excluded.scope,
      expires_at = excluded.expires_at,
      connected_at = datetime('now')
  `).run(orgId, encrypt(token), adAccountId, scope, expiresAt);
}
function getMetaConnection(orgId) {
  const row = getDb().prepare('SELECT * FROM meta_connections WHERE org_id = ?').get(orgId);
  if (row) row.access_token = decrypt(row.access_token);
  return row;
}

// ── Google ────────────────────────────────────────────────────
function saveGoogleConnection(orgId, accessToken, refreshToken, customerId, expiresAt) {
  getDb().prepare(`
    INSERT INTO google_connections (org_id, access_token, refresh_token, customer_id, expires_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(org_id) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      customer_id = excluded.customer_id,
      expires_at = excluded.expires_at,
      connected_at = datetime('now')
  `).run(orgId, encrypt(accessToken), encrypt(refreshToken), customerId, expiresAt);
}
function getGoogleConnection(orgId) {
  const row = getDb().prepare('SELECT * FROM google_connections WHERE org_id = ?').get(orgId);
  if (row) {
    row.access_token = decrypt(row.access_token);
    row.refresh_token = decrypt(row.refresh_token);
  }
  return row;
}

// ── OAuth state ───────────────────────────────────────────────
function saveOAuthState(state, orgId, provider) {
  getDb().prepare('INSERT INTO oauth_states (state, org_id, provider) VALUES (?, ?, ?)').run(state, orgId, provider);
}
const OAUTH_STATE_TTL_MS = 15 * 60 * 1000; // states expire after 15 minutes
function consumeOAuthState(state) {
  const row = getDb().prepare('SELECT * FROM oauth_states WHERE state = ?').get(state);
  if (row) getDb().prepare('DELETE FROM oauth_states WHERE state = ?').run(state);
  if (!row) return null;
  // Reject stale states (created_at is stored as UTC 'now')
  const age = Date.now() - new Date(row.created_at + 'Z').getTime();
  if (Number.isFinite(age) && age > OAUTH_STATE_TTL_MS) return null;
  return row;
}

// ── Knowledge base ────────────────────────────────────────────
function saveKnowledge(orgId, data) {
  getDb().prepare(`
    INSERT INTO org_knowledge (org_id, data, enriched_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(org_id) DO UPDATE SET data = excluded.data, enriched_at = datetime('now')
  `).run(orgId, JSON.stringify(data));
}
function getKnowledge(orgId) {
  const row = getDb().prepare('SELECT data FROM org_knowledge WHERE org_id = ?').get(orgId);
  return row ? JSON.parse(row.data) : null;
}

// ── Leads ─────────────────────────────────────────────────────
function saveLead(lead) {
  const id = lead.id || `lead_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
  
  // Deduplication check
  const existing = getDb().prepare(`
    SELECT id FROM leads 
    WHERE org_id = ? AND (phone = ? OR (email IS NOT NULL AND email = ?))
    LIMIT 1
  `).get(lead.org_id, lead.phone || '', lead.email || '');

  // Persist the row either way, flagging duplicates instead of dropping them —
  // the spec wants duplicates visible and flagged (with a merge option), and
  // dropping them silently left is_duplicate / stats.duplicates as dead columns.
  const isDuplicate = existing ? 1 : 0;
  const duplicateOf = existing ? existing.id : null;

  getDb().prepare(`
    INSERT OR IGNORE INTO leads
    (id, org_id, name, phone, email, source, source_campaign, source_ad_id, platform, status, company, linkedin_url, is_duplicate, duplicate_of)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'New', ?, ?, ?, ?)
  `).run(id, lead.org_id, lead.name, lead.phone, lead.email,
         lead.source || 'meta', lead.source_campaign, lead.source_ad_id,
         lead.platform || 'meta', lead.company, lead.linkedin_url,
         isDuplicate, duplicateOf);

  return { ...lead, id, is_duplicate: isDuplicate, duplicate_of: duplicateOf };
}

function getLeads(orgId, status = null, limit = 100) {
  if (status && status !== 'All') {
    return getDb().prepare('SELECT * FROM leads WHERE org_id = ? AND status = ? ORDER BY captured_at DESC LIMIT ?')
      .all(orgId, status, limit);
  }
  return getDb().prepare('SELECT * FROM leads WHERE org_id = ? ORDER BY captured_at DESC LIMIT ?')
    .all(orgId, limit);
}

function updateLeadStatus(orgId, leadId, status) {
  getDb().prepare(`UPDATE leads SET status = ?, updated_at = datetime('now') WHERE id = ? AND org_id = ?`)
    .run(status, leadId, orgId);
}

function getLeadStats(orgId) {
  return getDb().prepare(`
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN status='New' THEN 1 ELSE 0 END) as new_count,
      SUM(CASE WHEN status='Contacted' THEN 1 ELSE 0 END) as contacted,
      SUM(CASE WHEN status='Follow-up' THEN 1 ELSE 0 END) as followup,
      SUM(CASE WHEN status='Converted' THEN 1 ELSE 0 END) as converted,
      SUM(CASE WHEN status='Dead' THEN 1 ELSE 0 END) as dead,
      SUM(CASE WHEN is_duplicate=1 THEN 1 ELSE 0 END) as duplicates
    FROM leads WHERE org_id = ?
  `).get(orgId);
}

// ── Campaigns cache ───────────────────────────────────────────
function saveCampaigns(orgId, platform, campaigns) {
  const stmt = getDb().prepare(`
    INSERT INTO campaigns_cache 
    (id, org_id, platform, name, status, objective, budget, spend, impressions, 
     clicks, ctr, cpc, conversions, roas, reach, frequency, cpl, diagnostic, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      status=excluded.status, spend=excluded.spend, impressions=excluded.impressions,
      clicks=excluded.clicks, ctr=excluded.ctr, cpc=excluded.cpc,
      conversions=excluded.conversions, roas=excluded.roas,
      reach=excluded.reach, frequency=excluded.frequency,
      cpl=excluded.cpl, diagnostic=excluded.diagnostic, fetched_at=datetime('now')
  `);
  campaigns.forEach(c => {
    stmt.run(
      c.id || `${orgId}_${platform}_${c.name}`,
      orgId, platform, c.name, c.status, c.objective, c.budget,
      c.spend || 0, c.impressions || 0, c.clicks || 0,
      c.ctr || 0, c.cpc || 0, c.conversions || 0, c.roas || 0,
      c.reach || 0, c.frequency || 0, c.cpl || 0,
      c.diagnostic ? JSON.stringify(c.diagnostic) : null
    );
  });
}

function getCachedCampaigns(orgId) {
  return getDb().prepare('SELECT * FROM campaigns_cache WHERE org_id = ? ORDER BY spend DESC').all(orgId);
}

// ── Keywords cache ────────────────────────────────────────────
function saveKeywords(orgId, keywords) {
  const stmt = getDb().prepare(`
    INSERT OR REPLACE INTO keywords_cache 
    (id, org_id, keyword, volume, difficulty, cpc_low, cpc_high, intent, trend)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  keywords.forEach(k => {
    stmt.run(
      `${orgId}_${k.keyword}`, orgId, k.keyword,
      k.volume, k.difficulty, k.cpc_low, k.cpc_high, k.intent, k.trend
    );
  });
}

function getKeywords(orgId) {
  return getDb().prepare('SELECT * FROM keywords_cache WHERE org_id = ? ORDER BY volume DESC').all(orgId);
}

// ── Social Connections ───────────────────────────────────────
function saveSocialConnection(orgId, platform, fields) {
  fields = { ...fields };
  if ('access_token' in fields) fields.access_token = encrypt(fields.access_token);
  if ('refresh_token' in fields) fields.refresh_token = encrypt(fields.refresh_token);
  const existing = getDb().prepare('SELECT id FROM social_connections WHERE org_id = ? AND platform = ?').get(orgId, platform);
  if (existing) {
    const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
    getDb().prepare(`UPDATE social_connections SET ${sets}, connected_at = datetime('now') WHERE org_id = ? AND platform = ?`)
      .run(...Object.values(fields), orgId, platform);
  } else {
    const id = `${orgId}_${platform}_${Date.now()}`;
    const cols = ['id', 'org_id', 'platform', ...Object.keys(fields)].join(', ');
    const placeholders = Array(Object.keys(fields).length + 3).fill('?').join(', ');
    getDb().prepare(`INSERT INTO social_connections (${cols}) VALUES (${placeholders})`)
      .run(id, orgId, platform, ...Object.values(fields));
  }
}

function decryptSocialRow(row) {
  if (!row) return row;
  row.access_token = decrypt(row.access_token);
  row.refresh_token = decrypt(row.refresh_token);
  return row;
}

function getSocialConnection(orgId, platform) {
  return decryptSocialRow(
    getDb().prepare('SELECT * FROM social_connections WHERE org_id = ? AND platform = ?').get(orgId, platform)
  );
}

function getSocialConnections(orgId) {
  return getDb().prepare('SELECT * FROM social_connections WHERE org_id = ? ORDER BY connected_at DESC')
    .all(orgId).map(decryptSocialRow);
}

function deleteSocialConnection(orgId, platform) {
  getDb().prepare('DELETE FROM social_connections WHERE org_id = ? AND platform = ?').run(orgId, platform);
}

// Map an incoming Facebook page id (webhook entry.id) back to the org that
// connected it. Used to attribute inbound lead-ad submissions correctly.
function getOrgIdByFacebookPage(pageId) {
  const row = getDb().prepare(
    "SELECT org_id FROM social_connections WHERE lower(platform) = 'facebook' AND page_id = ?"
  ).get(String(pageId));
  return row?.org_id || null;
}

// ── Social Metrics History ────────────────────────────────────
function saveSocialMetricsHistory(orgId, platform, metrics) {
  const id = `${orgId}_${platform}_${Date.now()}`;
  getDb().prepare(`
    INSERT INTO social_metrics_history (id, org_id, platform, followers, posts_30d, avg_reach, engagement, impressions, views)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, orgId, platform,
    metrics.followers || 0,
    metrics.posts_30d || 0,
    metrics.avg_reach || metrics.reach || 0,
    metrics.engagement || 0,
    metrics.impressions || 0,
    metrics.views || 0
  );
}

function getSocialMetricsHistory(orgId, platform = null, days = 30) {
  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  if (platform) {
    return getDb().prepare(
      'SELECT * FROM social_metrics_history WHERE org_id = ? AND platform = ? AND recorded_at > ? ORDER BY recorded_at ASC'
    ).all(orgId, platform, since);
  }
  return getDb().prepare(
    'SELECT * FROM social_metrics_history WHERE org_id = ? AND recorded_at > ? ORDER BY platform, recorded_at ASC'
  ).all(orgId, since);
}

// ── Research jobs (BI Research sidecar job ↔ org mapping) ─────
// Job status/logs/results live in the Python sidecar's jobs.db;
// this table only records which org started which job.
function saveResearchJob({ id, orgId, jobType, memoryKey, label }) {
  getDb().prepare(`
    INSERT OR REPLACE INTO research_jobs (id, org_id, job_type, memory_key, label)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, orgId, jobType, memoryKey, label || null);
}

function getResearchJob(id) {
  return getDb().prepare('SELECT * FROM research_jobs WHERE id = ?').get(id);
}

function getResearchJobsForOrg(orgId) {
  return getDb().prepare('SELECT * FROM research_jobs WHERE org_id = ? ORDER BY created_at DESC').all(orgId);
}

module.exports = {
  getDb, createOrg, getOrg, listOrgs, updateOrg,
  saveMetaConnection, getMetaConnection,
  saveGoogleConnection, getGoogleConnection,
  saveOAuthState, consumeOAuthState,
  saveKnowledge, getKnowledge,
  saveLead, getLeads, updateLeadStatus, getLeadStats,
  saveCampaigns, getCachedCampaigns,
  saveKeywords, getKeywords,
  saveSocialConnection, getSocialConnection, getSocialConnections, deleteSocialConnection,
  getOrgIdByFacebookPage,
  saveSocialMetricsHistory, getSocialMetricsHistory,
  saveResearchJob, getResearchJob, getResearchJobsForOrg,
};
