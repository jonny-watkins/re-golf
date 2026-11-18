import express, { type ErrorRequestHandler, type Request } from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { categories, conditions, listingColumns, listingInput, maxPhotoBytes } from '../shared/listings.js';
import { normalisePhoto } from './images.js';
import type { AppConfig } from './config.js';
import { socialRoutes } from './social.js';
import { HttpError } from './errors.js';
import { orderRoutes, paymentWebhook, settleOrders } from './orders.js';
import { stripePayments, type Payments } from './payments.js';
import { adminRoutes } from './admin.js';
import { searchFilters } from './search.js';
import { accountRoutes } from './account.js';
import { resendSender, sendPendingEmails, type EmailSender } from './email.js';
import { runRetention } from './retention.js';
import { timingSafeEqual, createHash } from 'node:crypto';

export type ClientFactory = (token?: string) => SupabaseClient;
/** Work the server repeats on a timer. Each is safe to run at any time and more than once. */
export type BackgroundJobs = {
  settleOrders?: () => Promise<Record<string, number>>;
  sendEmails?: () => Promise<{ sent: number; dropped: number; failed: number }>;
  cleanUp?: () => Promise<Record<string, number>>;
};
export function createApp(
  config: AppConfig,
  clientOverride?: ClientFactory,
  storageOverride?: SupabaseClient,
  paymentsOverride?: Payments,
  emailOverride?: EmailSender,
) {
  const app = express();
  const jobs: BackgroundJobs = {};
  app.disable('x-powered-by');
  // Trust only the configured number of hops, never arbitrary forwarded headers.
  app.set('trust proxy', config.trustProxyHops);
  // Render's health probe is public; all application content requires preview access.
  if (config.previewPassword)
    app.use((req, res, next) => {
      res.set('X-Robots-Tag', 'noindex, nofollow');
      if (req.path === '/api/health' && req.method === 'GET') {
        res.json({ status: 'ok' });
        return;
      }
      // The payment provider cannot supply the preview password; its requests are verified by signature instead.
      if (req.path === '/api/stripe/webhook' && req.method === 'POST') {
        next();
        return;
      }
      // A separate header/cookie is needed for API calls, whose Authorization header carries the Supabase JWT.
      const supplied = req.headers.cookie
        ?.split(';')
        .map(value => value.trim())
        .find(value => value.startsWith('relofted_preview='))
        ?.slice('relofted_preview='.length);
      const expected = createHash('sha256').update(config.previewPassword).digest('hex');
      if (
        supplied &&
        /^[a-f0-9]{64}$/.test(supplied) &&
        timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
      ) {
        next();
        return;
      }
      const authorization = req.get('authorization') || '';
      const basic = authorization.startsWith('Basic ') ? Buffer.from(authorization.slice(6), 'base64').toString() : '';
      const valid = timingSafeEqual(
        createHash('sha256').update(basic).digest(),
        createHash('sha256').update(`preview:${config.previewPassword}`).digest(),
      );
      if (valid) {
        res.cookie('relofted_preview', expected, {
          httpOnly: true,
          secure: config.origin.startsWith('https:'),
          sameSite: 'lax',
          maxAge: 8 * 60 * 60 * 1000,
          path: '/',
        });
        next();
        return;
      }
      res.set('Cache-Control', 'no-store');
      res.set('WWW-Authenticate', 'Basic realm="Relofted private preview", charset="UTF-8"');
      res
        .status(401)
        .send('Private development preview. Enter the preview access details supplied by the project owner.');
    });
  app.use(
    helmet({
      // Vite development uses inline scripts. Production has a stricter policy below.
      contentSecurityPolicy: false,
      strictTransportSecurity: config.origin.startsWith('https:'),
    }),
  );
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  const configured = Boolean(config.supabaseUrl && config.publishableKey);
  const storageAdmin =
    storageOverride ||
    (config.secretKey
      ? createClient(config.supabaseUrl, config.secretKey, {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        })
      : null);
  const payments = storageAdmin
    ? paymentsOverride ||
      (config.stripeSecretKey
        ? stripePayments(config.stripeSecretKey, config.stripeWebhookSecret, config.stripeConnectWebhookSecret)
        : null)
    : null;
  // Before the rate limiter and JSON parser: provider retries must not be throttled, and the signature covers the raw body.
  if (payments && storageAdmin) {
    paymentWebhook(app, storageAdmin, payments);
    jobs.settleOrders = () => settleOrders(storageAdmin, payments);
  }
  app.use(
    '/api',
    rateLimit({
      windowMs: 60_000,
      limit: 120,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      skip: req => req.path === '/health' || req.path === '/stripe/webhook',
      message: { error: 'Too many requests. Please try again in a minute.' },
    }),
  );
  app.use('/api', express.json({ limit: '16kb' }));
  app.use('/api', (req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.get('origin') && req.get('origin') !== config.origin) {
        res.status(403).json({ error: 'This request came from an unexpected site.' });
        return;
      }
      const photoUpload = req.method === 'POST' && /^\/listings\/[a-f0-9-]+\/photos$/i.test(req.path);
      if (!req.is('application/json') && !(photoUpload && req.is('application/octet-stream'))) {
        res.status(415).json({ error: 'Send application/json.' });
        return;
      }
    }
    next();
  });
  const client: ClientFactory =
    clientOverride ||
    (token =>
      createClient(config.supabaseUrl, config.publishableKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
      }));

  // Keep the foundation preview usable while the additive migration awaits application.
  let schemaCheck: { until: number; ready: Promise<boolean> } | undefined;
  async function detailsReady() {
    if (!configured) return false;
    if (!schemaCheck || schemaCheck.until < Date.now()) {
      schemaCheck = {
        until: Date.now() + 10_000,
        ready: (async () => {
          const { error } = await client()
            .from('listings')
            .select('handedness,shaft_flex,loft,listing_photos(id)')
            .limit(0);
          return !error;
        })(),
      };
    }
    return schemaCheck.ready;
  }
  const basicColumns =
    'id,seller_id,name,brand,category,condition,price_pence,location,description,status,created_at,updated_at';
  async function columns() {
    return (await detailsReady()) ? listingColumns : basicColumns;
  }
  async function compatibleInput(body: unknown) {
    const input = listingInput.parse(body);
    if (await detailsReady()) return input;
    const { handedness, shaft_flex, loft, ...basic } = input;
    if (handedness !== null || shaft_flex !== null || loft !== null)
      throw new HttpError(503, 'Golf details are awaiting setup. Please try again after the database update.');
    return basic;
  }
  // Buyer fee settings for showing fee-inclusive prices. Null until payments and the settings function exist.
  let pricing: { until: number; value: Promise<Record<string, unknown> | null> } | undefined;
  function buyerPricing() {
    if (!payments || !storageAdmin) return null;
    if (!pricing || pricing.until < Date.now()) {
      pricing = {
        until: Date.now() + 60_000,
        value: (async () => {
          const { data, error } = await storageAdmin.rpc('marketplace_settings');
          if (error || !data) return null;
          const s = data as Record<string, unknown>;
          return {
            checkoutOpen: s.checkout_enabled,
            feeFixedPence: s.fee_fixed_pence,
            feeBps: s.fee_bps,
            deliveryPence: s.delivery_pence,
            holdHours: s.hold_hours,
          };
        })(),
      };
    }
    return pricing.value;
  }
  app.get('/api/config', async (_req, res) => {
    const listingDetailsEnabled = await detailsReady();
    res.json({
      configured,
      supabaseUrl: config.supabaseUrl,
      publishableKey: config.publishableKey,
      listingDetailsEnabled,
      photosEnabled: Boolean(storageAdmin) && listingDetailsEnabled,
      paymentsEnabled: Boolean(payments),
      pricing: await buyerPricing(),
    });
  });
  app.get('/api/health', (_req, res) => res.json({ status: 'ok', configured }));
  app.use('/api', (_req, res, next) => {
    if (!configured) {
      res
        .status(503)
        .json({ error: 'Accounts and saved listings are not connected yet. Follow SETUP.md to connect Supabase.' });
      return;
    }
    next();
  });

  async function authenticated(req: Request) {
    const match = /^Bearer (\S+)$/.exec(req.get('authorization') || '');
    if (!match) throw new HttpError(401, 'Please sign in to continue.');
    const db = client(match[1]);
    const { data, error } = await db.auth.getUser(match[1]);
    if (error || !data.user) throw new HttpError(401, 'Your session has expired. Please sign in again.');
    if (!data.user.email_confirmed_at) throw new HttpError(403, 'Confirm your email before managing listings.');
    return { db, user: data.user };
  }

  const paging = z
    .object({
      page: z.coerce.number().int().min(1).max(10000).default(1),
      q: z.string().trim().max(100).default(''),
      category: z.enum(categories).optional(),
      condition: z.enum(conditions).optional(),
      max_price: z.coerce.number().int().min(1).max(20000).optional(), // whole pounds
    })
    .strict();
  app.get('/api/listings', async (req, res) => {
    const { page, q, category, condition, max_price } = paging.parse(req.query);
    let query = client()
      .from('listings')
      .select(await columns(), { count: 'exact' })
      .eq('status', 'active');
    if (category) query = query.eq('category', category);
    if (condition) query = query.eq('condition', condition);
    if (max_price) query = query.lte('price_pence', max_price * 100);
    for (const filter of searchFilters(q)) query = query.or(filter);
    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .order('id')
      .range((page - 1) * 24, page * 24 - 1);
    if (error) throw new HttpError(503, 'Listings could not be loaded. Check the database setup or try again.');
    res.json({ listings: data, total: count, page });
  });
  app.get('/api/me/listings', async (req, res) => {
    const { db, user } = await authenticated(req);
    const { page, q, category, condition, max_price } = paging.parse(req.query);
    let query = db
      .from('listings')
      .select(await columns(), { count: 'exact' })
      .eq('seller_id', user.id);
    if (category) query = query.eq('category', category);
    if (condition) query = query.eq('condition', condition);
    if (max_price) query = query.lte('price_pence', max_price * 100);
    for (const filter of searchFilters(q)) query = query.or(filter);
    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .order('id')
      .range((page - 1) * 24, page * 24 - 1);
    if (error) throw new HttpError(503, 'Your listings could not be loaded. Please try again.');
    res.json({ listings: data, total: count, page });
  });
  app.post('/api/listings', async (req, res) => {
    const { db, user } = await authenticated(req);
    const input = await compatibleInput(req.body);
    const { data, error } = await db
      .from('listings')
      .insert({ ...input, seller_id: user.id })
      .select(await columns())
      .single();
    if (error) throw new HttpError(503, 'Your listing could not be saved. Please try again.');
    res.status(201).json({ listing: data });
  });
  app.put('/api/listings/:id', async (req, res) => {
    const { db, user } = await authenticated(req);
    const id = z.uuid().parse(req.params.id);
    const input = await compatibleInput(req.body);
    const { data, error } = await db
      .from('listings')
      .update(input)
      .eq('id', id)
      .eq('seller_id', user.id)
      .eq('status', 'active')
      .select(await columns())
      .maybeSingle();
    if (error) throw new HttpError(503, 'Your listing could not be updated. Please try again.');
    if (!data) throw new HttpError(404, 'This active listing was not found in your account.');
    res.json({ listing: data });
  });
  app.post('/api/listings/:id/archive', async (req, res) => {
    const { db, user } = await authenticated(req);
    const id = z.uuid().parse(req.params.id);
    z.object({}).strict().parse(req.body);
    const { data, error } = await db
      .from('listings')
      .update({ status: 'archived' })
      .eq('id', id)
      .eq('seller_id', user.id)
      .select(await columns())
      .maybeSingle();
    if (error) throw new HttpError(503, 'Your listing could not be archived. Please try again.');
    if (!data) throw new HttpError(404, 'This listing was not found in your account.');
    res.json({ listing: data });
  });

  async function photoOwner(req: Request) {
    const { db, user } = await authenticated(req);
    const id = z.uuid().parse(req.params.id);
    const { data, error } = await db
      .from('listings')
      .select('id')
      .eq('id', id)
      .eq('seller_id', user.id)
      .eq('status', 'active')
      .maybeSingle();
    if (error) throw new HttpError(503, 'Could not check the listing. Please try again.');
    if (!data) throw new HttpError(404, 'This active listing was not found in your account.');
    if (!storageAdmin)
      throw new HttpError(503, 'Photo storage is not connected yet. Your listing details can still be saved.');
    return { id, user };
  }
  async function photoAction(id: string, seller: string, photo: string | null, action: string) {
    const { data, error } = await storageAdmin!.rpc('manage_listing_photo', {
      p_listing: id,
      p_seller: seller,
      p_photo: photo,
      p_action: action,
    });
    if (error) {
      if (error.code === '23514') throw new HttpError(409, 'You can add up to six photos.');
      if (['42501', 'P0002'].includes(error.code))
        throw new HttpError(404, 'This listing or photo is no longer available.');
      throw new HttpError(503, 'The photo could not be saved. Please try again.');
    }
    return data as string;
  }
  const photoLimit = rateLimit({
    windowMs: 60_000,
    limit: 20,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many photo uploads. Please wait a minute.' },
  });
  app.post(
    '/api/listings/:id/photos',
    photoLimit,
    async (req, res, next) => {
      res.locals.owner = await photoOwner(req);
      if (!req.is('application/octet-stream'))
        throw new HttpError(415, 'Send photo bytes as application/octet-stream.');
      next();
    },
    express.raw({ type: 'application/octet-stream', limit: maxPhotoBytes }),
    async (req, res) => {
      const { id, user } = res.locals.owner;
      let bytes: Buffer;
      try {
        bytes = await normalisePhoto(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
      } catch {
        throw new HttpError(400, 'Choose a valid still JPEG, PNG or WebP photo up to 8 MB and 40 megapixels.');
      }
      const photoId = await photoAction(id, user.id, null, 'reserve');
      const path = `${id}/${photoId}.webp`;
      try {
        const { error } = await storageAdmin!.storage
          .from('listing-photos')
          .upload(path, bytes, { contentType: 'image/webp', upsert: false });
        if (error)
          throw new HttpError(503, 'Photo upload failed. Your listing details are saved; try the photo again.');
        await photoAction(id, user.id, photoId, 'complete');
      } catch (error) {
        // A durable pending row remains if compensation fails; the cleanup command retries it.
        try {
          await photoAction(id, user.id, photoId, 'remove');
        } catch {
          /* Pruned after one hour. */
        }
        throw error;
      }
      res.status(201).json({ photo: { id: photoId } });
    },
  );
  for (const action of ['main', 'remove'] as const) {
    app.post(`/api/listings/:id/photos/:photo/${action}`, async (req, res) => {
      const { id, user } = await photoOwner(req);
      const photo = z.uuid().parse(req.params.photo);
      z.object({}).strict().parse(req.body);
      await photoAction(id, user.id, photo, action);
      // Removal becomes invisible immediately; durable cleanup retries storage deletion.
      if (action === 'remove') {
        const path = `${id}/${photo}.webp`;
        const { error } = await storageAdmin!.storage.from('listing-photos').remove([path]);
        if (!error) await storageAdmin!.from('photo_cleanup').delete().eq('path', path);
      }
      res.json({ ok: true });
    });
  }
  app.get('/api/photos/:photo', async (req, res) => {
    const photo = z.uuid().parse(req.params.photo);
    const db = req.get('authorization') ? (await authenticated(req)).db : client();
    const { data, error } = await db
      .from('listing_photos')
      .select('id,listing_id')
      .eq('id', photo)
      .eq('ready', true)
      .maybeSingle();
    if (error) throw new HttpError(503, 'Photos could not be loaded.');
    if (!data) throw new HttpError(404, 'Photo not found.');
    if (!storageAdmin) throw new HttpError(503, 'Photo storage is not connected yet.');
    const result = await storageAdmin.storage.from('listing-photos').download(`${data.listing_id}/${data.id}.webp`);
    if (result.error) throw new HttpError(503, 'Photo could not be loaded. Please try again.');
    res.set('Cache-Control', 'private, max-age=86400');
    res.type('image/webp').send(Buffer.from(await result.data.arrayBuffer()));
  });
  // Public seller reputation. Empty until the reviews migration is applied.
  app.get('/api/sellers/:id/rating', async (req, res) => {
    const id = z.uuid().parse(req.params.id);
    const { data, error } = await client()
      .from('reviews')
      .select('rating,comment,created_at')
      .eq('reviewee_id', id)
      .order('created_at', { ascending: false })
      .limit(200);
    if (error || !data) {
      res.json({ count: 0, average: null, recent: [] });
      return;
    }
    const count = data.length;
    res.json({
      count,
      average: count ? Math.round((data.reduce((sum, row) => sum + row.rating, 0) / count) * 10) / 10 : null,
      recent: data.filter(row => row.comment).slice(0, 5),
    });
  });
  socialRoutes(app, authenticated, columns);
  if (payments && storageAdmin) orderRoutes(app, authenticated, storageAdmin, payments, config.origin);
  if (storageAdmin) {
    accountRoutes(app, authenticated, storageAdmin, payments);
    const sender = emailOverride || (config.emailApiKey ? resendSender(config.emailApiKey, config.emailFrom) : null);
    jobs.cleanUp = () => runRetention(storageAdmin);
    if (sender) jobs.sendEmails = () => sendPendingEmails(storageAdmin, sender, config.origin);
  }
  if (storageAdmin && config.adminEmails.length)
    adminRoutes(app, authenticated, storageAdmin, config.adminEmails, jobs.settleOrders);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found.' }));
  const handleError: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Check the submitted fields.', fields: error.flatten() });
      return;
    }
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    if (error.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'Invalid JSON.' });
      return;
    }
    if (error.type === 'entity.too.large') {
      res.status(413).json({ error: 'Request is too large.' });
      return;
    }
    console.error(
      'Request failed:',
      _req.method,
      _req.path,
      error instanceof Error ? error.stack || error.message : 'Unknown error',
    );
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  };
  app.use(handleError);
  return Object.assign(app, { jobs });
}
