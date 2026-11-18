import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import { resolve } from 'node:path';
import { createApp } from './app.js';
import { readConfig } from './config.js';

const config = readConfig(process.env);
const app = createApp(config);
const built = import.meta.url.endsWith('/server.js');
if (built) {
  app.use(
    helmet.contentSecurityPolicy({
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: ["'self'", ...(config.supabaseUrl ? [config.supabaseUrl] : [])],
        imgSrc: ["'self'", 'data:', 'blob:'],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: config.origin.startsWith('https:') ? [] : null,
      },
    }),
  );
  app.use(express.static(resolve('dist/client')));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
}
const server = app.listen(config.port, config.host, () => {
  console.log(`Relofted: ${config.origin}`);
  console.log(
    config.supabaseUrl
      ? 'Supabase configured. Apply the migration before using listings.'
      : 'Setup needed: see the README to connect accounts and saved listings.',
  );
});

// Applies order deadlines and performs due refunds and seller payouts. Repeat-safe,
// so running it here avoids needing a separate paid scheduler for a single instance.
const settle = app.jobs.settleOrders;
if (settle) {
  const run = () =>
    settle()
      .then(result => {
        if (Object.values(result).some(Boolean)) console.log('Order settlement:', JSON.stringify(result));
      })
      .catch(error =>
        console.error('Order settlement failed:', error instanceof Error ? error.message : 'Unknown error'),
      );
  setTimeout(run, 15_000).unref();
  setInterval(run, 5 * 60_000).unref();
}

// Queued emails go out once a minute. Nothing is sent until an email provider is configured.
const sendEmails = app.jobs.sendEmails;
if (sendEmails) {
  setInterval(
    () =>
      void sendEmails()
        .then(result => {
          if (result.sent || result.failed) console.log('Emails:', JSON.stringify(result));
        })
        .catch(error => console.error('Email run failed:', error instanceof Error ? error.message : 'Unknown error')),
    60_000,
  ).unref();
}

// Old delivery addresses, sent emails and payment event IDs are removed a few times a day.
const cleanUp = app.jobs.cleanUp;
if (cleanUp) {
  const run = () =>
    void cleanUp()
      .then(result => {
        if (Object.values(result).some(Boolean)) console.log('Clean-up:', JSON.stringify(result));
      })
      .catch(error => console.error('Clean-up failed:', error instanceof Error ? error.message : 'Unknown error'));
  setTimeout(run, 60_000).unref();
  setInterval(run, 6 * 60 * 60_000).unref();
}

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
