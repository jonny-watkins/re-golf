import assert from 'node:assert/strict';

/** The only Supabase project the hosted test scripts may touch. They create and delete data and flip settings. */
export const developmentProject = 'ihndsjxwnogyxcixujwv';

/**
 * Refuses to continue unless the configuration points at the development database and
 * Stripe's test mode. Call this before a hosted test script does anything else, so a
 * `.env` that has been pointed at production can never be tested against.
 */
export function assertDevelopmentOnly(config: { supabaseUrl: string; stripeSecretKey?: string }) {
  const project = new URL(config.supabaseUrl).hostname.split('.')[0];
  assert.equal(
    project,
    developmentProject,
    `Hosted tests only run against the development project (${developmentProject}); this configuration points at "${project}".`,
  );
  if (config.stripeSecretKey !== undefined) {
    assert.match(config.stripeSecretKey, /^(sk|rk)_test_/, 'Hosted tests only run with Stripe TEST keys.');
  }
}
