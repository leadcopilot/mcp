import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function fresh() {
  delete require.cache[require.resolve('../lib/supabase.js')];
  return require('../lib/supabase.js');
}

describe('lib/supabase', () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = 'https://otbdjrexiscbxqlcnnvx.supabase.co';
    process.env.SUPABASE_ANON_KEY = 'sb_publishable_test';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_test';
  });

  it('reports configured when url + service key present', () => {
    expect(fresh().isConfigured()).toBe(true);
  });

  it('builds a user client carrying the JWT', () => {
    const { getUserClient } = fresh();
    const client = getUserClient('jwt-abc');
    expect(client).toBeTruthy();
    expect(typeof client.from).toBe('function');
  });

  it('throws when service role key missing', () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(() => fresh().getServiceClient()).toThrow(/SERVICE_ROLE/);
  });
});
