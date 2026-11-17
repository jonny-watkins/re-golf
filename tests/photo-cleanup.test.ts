import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cleanupPhotos } from '../server/photo-cleanup';

test('failed storage deletion retains queue and a later cleanup retries successfully', async () => {
  let fail = true;
  let queued = true;
  let attempts = 0;
  const db = {
    rpc: async () => ({ error: null }),
    from: () => ({
      select: () => ({ order: () => ({ limit: async () => ({ data: queued ? [{ path: 'fixture/photo.webp' }] : [], error: null }) }) }),
      delete: () => ({ in: async () => { queued = false; return { error: null }; } }),
    }),
    storage: { from: () => ({ remove: async () => { attempts++; return { error: fail ? new Error('Unavailable') : null }; } }) },
  } as unknown as SupabaseClient;
  await assert.rejects(cleanupPhotos(db), /queue retained/);
  assert.equal(queued, true);
  fail = false;
  assert.equal(await cleanupPhotos(db), 1);
  assert.equal(queued, false);
  assert.equal(attempts, 2);
  assert.equal(await cleanupPhotos(db), 0);
});
