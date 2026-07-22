/**
 * Apply supabase/migrations/*.sql in order against SUPABASE_DB_URL.
 * Usage: node -r dotenv/config scripts/apply-migrations.js
 */
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

async function main() {
  const raw = process.env.SUPABASE_DB_URL;
  if (!raw) throw new Error('SUPABASE_DB_URL not set (check .env)');
  // Drop the sslmode query param — pg v9 reads it as verify-full and rejects
  // Supabase's cert chain. We set ssl explicitly below instead.
  const connectionString = raw.split('?')[0];

  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log('Connected to Postgres.');

  const dir = path.join(__dirname, '..', 'supabase', 'migrations');
  const only = process.argv[2]; // optional: apply just this one file
  const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => !only || f === only)
    .sort();
  if (only && files.length === 0) throw new Error(`Migration file not found: ${only}`);

  for (const f of files) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    process.stdout.write(`Applying ${f} ... `);
    try {
      await client.query(sql);
      console.log('OK');
    } catch (err) {
      if (/already exists|duplicate/i.test(err.message)) {
        console.log(`skipped (${err.message})`);
      } else {
        console.error(`FAILED\n  ${err.message}`);
        await client.end();
        process.exit(1);
      }
    }
  }

  await client.end();
  console.log('All migrations applied.');
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
