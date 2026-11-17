import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCleanupConfig } from '../server/cleanup-config';

test('Render cleanup runs without web origin, preview password or publishable key', () => {
  const config = readCleanupConfig({
    RENDER: 'true',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_STORAGE_SECRET: 'sb_secret_test',
  });
  assert.equal(config.supabaseUrl, 'https://test.supabase.co');
  assert.equal(config.storageSecret, 'sb_secret_test');
});

test('cleanup rejects missing credentials and unsafe destinations without echoing secrets', () => {
  for (const env of [
    {},
    { SUPABASE_URL: 'https://test.supabase.co' },
    { SUPABASE_URL: 'https://attacker.example', SUPABASE_STORAGE_SECRET: 'sb_secret_test' },
    { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_STORAGE_SECRET: 'private-invalid-value' },
  ]) {
    assert.throws(
      () => readCleanupConfig(env),
      error => {
        assert.ok(error instanceof Error);
        assert.equal(error.message.includes('private-invalid-value'), false);
        assert.equal(error.message.includes('sb_secret_test'), false);
        return true;
      },
    );
  }
});
