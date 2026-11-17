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
  app.use(helmet.contentSecurityPolicy({ directives: {
    defaultSrc: ["'self'"], scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    connectSrc: ["'self'", ...(config.supabaseUrl ? [config.supabaseUrl] : [])],
    imgSrc: ["'self'", 'data:', 'blob:'], objectSrc: ["'none'"],
    upgradeInsecureRequests: config.origin.startsWith('https:') ? [] : null,
  } }));
  app.use(express.static(resolve('dist/client')));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
}
const server = app.listen(config.port, config.host, () => {
  console.log(`Re-Golf: ${config.origin}`);
  console.log(config.supabaseUrl ? 'Supabase configured. Apply the migration before using listings.' : 'Setup needed: follow SETUP.md to connect accounts and saved listings.');
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
