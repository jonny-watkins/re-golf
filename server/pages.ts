import type { Express } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';

// Each listing has its own address, /listing/<id>, so it can be shared and found by search
// engines. The page is the same single-page app; the server only fills in the title, the
// description and the link-preview tags, because messaging apps and crawlers do not run scripts.

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const pounds = (pence: number) => '£' + (pence / 100).toFixed(2).replace(/\.00$/, '');

export type ListingSummary = {
  id: string;
  name: string;
  brand: string;
  category: string;
  condition: string;
  price_pence: number;
  location: string;
  description: string;
  listing_photos?: { id: string; position: number }[];
};

/** The app page with this listing's title, description and link-preview tags in its head. */
export function listingHtml(template: string, listing: ListingSummary, origin: string) {
  const title = `${listing.brand} ${listing.name} — ${pounds(listing.price_pence)} | Relofted`;
  const summary = `${listing.condition} · ${listing.category} · ${listing.location}.`;
  const text = listing.description.replace(/\s+/g, ' ').trim();
  const description = `${summary} ${text.length > 150 ? text.slice(0, 149) + '…' : text}`.trim();
  const url = `${origin}/listing/${listing.id}`;
  const photo = [...(listing.listing_photos || [])].sort((a, b) => a.position - b.position)[0];
  const image = photo ? `${origin}/api/photos/${photo.id}` : `${origin}/relofted-icon.png`;
  const tags = [
    `<link rel="canonical" href="${escapeHtml(url)}">`,
    `<meta property="og:type" content="product">`,
    `<meta property="og:site_name" content="Relofted">`,
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:description" content="${escapeHtml(description)}">`,
    `<meta property="og:url" content="${escapeHtml(url)}">`,
    `<meta property="og:image" content="${escapeHtml(image)}">`,
    `<meta name="twitter:card" content="${photo ? 'summary_large_image' : 'summary'}">`,
  ].join('\n  ');
  // Replacement functions, so "$" in a listing's text is never read as a pattern.
  return template
    .replace(/<title>[^<]*<\/title>/, () => `<title>${escapeHtml(title)}</title>`)
    .replace(
      /<meta name="description" content="[^"]*">/,
      () => `<meta name="description" content="${escapeHtml(description)}">`,
    )
    .replace('</head>', () => `  ${tags}\n</head>`);
}

/**
 * Serves /listing/<id>, /sitemap.xml and /robots.txt. `template` returns the built app page.
 * A listing that is not on sale (or any failure) gets the plain app page, which then tells the
 * visitor the item is no longer available.
 */
export function listingPages(app: Express, db: (() => SupabaseClient) | null, origin: string, template: () => string) {
  app.get('/listing/:id', async (req, res) => {
    let html = template();
    let found = false;
    try {
      if (db && uuid.test(req.params.id)) {
        const { data } = await db()
          .from('listings')
          .select('id,name,brand,category,condition,price_pence,location,description,listing_photos(id,position)')
          .eq('id', req.params.id)
          .eq('status', 'active')
          .maybeSingle();
        if (data) {
          html = listingHtml(html, data as ListingSummary, origin);
          found = true;
        }
      }
    } catch {
      /* Fall through to the plain page. */
    }
    // Sold and removed listings should drop out of search results.
    if (!found) res.set('X-Robots-Tag', 'noindex');
    res.set('Cache-Control', 'no-cache');
    res.type('html').send(html);
  });

  app.get('/sitemap.xml', async (_req, res) => {
    let ids: { id: string; updated_at: string }[] = [];
    try {
      if (db)
        ids =
          (
            await db()
              .from('listings')
              .select('id,updated_at')
              .eq('status', 'active')
              .order('created_at', { ascending: false })
              .limit(5000)
          ).data || [];
    } catch {
      /* An empty sitemap is better than an error page. */
    }
    const pages = [
      `<url><loc>${origin}/</loc></url>`,
      ...['buyer-protection', 'terms', 'privacy'].map(page => `<url><loc>${origin}/${page}.html</loc></url>`),
      ...ids.map(
        row =>
          `<url><loc>${origin}/listing/${row.id}</loc><lastmod>${escapeHtml(String(row.updated_at).slice(0, 10))}</lastmod></url>`,
      ),
    ];
    res.set('Cache-Control', 'public, max-age=3600');
    res
      .type('application/xml')
      .send(
        `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages.join('\n')}\n</urlset>\n`,
      );
  });

  app.get('/robots.txt', (_req, res) => {
    res.type('text/plain').send(`User-agent: *\nDisallow: /api/\nSitemap: ${origin}/sitemap.xml\n`);
  });
}
