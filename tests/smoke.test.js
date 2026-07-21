import { describe, it, expect } from 'vitest';

describe('toolchain', () => {
  it('runs vitest', () => {
    expect(1 + 1).toBe(2);
  });
  it('loads @supabase/supabase-js', async () => {
    const mod = await import('@supabase/supabase-js');
    expect(typeof mod.createClient).toBe('function');
  });
});
