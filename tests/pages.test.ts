import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { listingHtml, listingPages, type ListingSummary } from '../server/pages';

const template = `<!doctype html><html><head>
  <meta name="description" content="Buy and sell pre-loved golf clubs.">
  <title>Relofted — Better clubs, back in play</title>
</head><body></body></html>`;
const listing: ListingSummary = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'G430 "Max" <10K>',
  brand: 'Ping',
  category: 'Drivers',
  condition: 'Very good',
  price_pence: 22500,
  location: 'Leeds',
  description: 'Costs $& less than new.\n\n' + 'Lovely club. '.repeat(30),
  listing_photos: [
    { id: 'photo-b', position: 1 },
    { id: 'photo-a', position: 0 },
  ],
};

test('a listing page carries its own title, description and link preview, safely escaped', () => {
  const html = listingHtml(template, listing, 'https://relofted.example');
  assert.match(html, /<title>Ping G430 &quot;Max&quot; &lt;10K&gt; — £225 \| Relofted<\/title>/);
  assert.match(html, /<meta property="og:url" content="https:\/\/relofted.example\/listing\/11111111-/);
  // The main photo (position 0) is the preview image.
  assert.match(html, /<meta property="og:image" content="https:\/\/relofted.example\/api\/photos\/photo-a">/);
  // "$&" in a listing must not be read as a replacement pattern, and long text is shortened.
  const description = /<meta name="description" content="([^"]*)">/.exec(html)![1];
  assert.ok(description.startsWith('Very good · Drivers · Leeds. Costs $&amp; less than new. Lovely club.'));
  assert.ok(description.endsWith('…') && description.length < 200, description);
  assert.equal(html.match(/<title>/g)!.length, 1);
  assert.ok(!html.includes('<10K>'));
  // Without photos the logo is used, and odd pence are kept.
  const plain = listingHtml(template, { ...listing, listing_photos: [], price_pence: 22550 }, 'https://x.example');
  assert.match(plain, /og:image" content="https:\/\/x.example\/relofted-icon.png"/);
  assert.match(plain, /— £225\.50 \|/);
});

test('listing addresses serve the app; only listings on sale are described and indexable', async () => {
  const asked: string[] = [];
  // A stand-in for the database: answers the two queries the pages make.
  const db = () =>
    ({
      from: () => {
        const query: Record<string, unknown> = {};
        let id = '';
        Object.assign(query, {
          select: () => query,
          order: () => query,
          eq: (column: string, value: string) => {
            if (column === 'id') id = value;
            return query;
          },
          limit: async () => ({ data: [{ id: listing.id, updated_at: '2026-11-19T10:00:00Z' }] }),
          maybeSingle: async () => {
            asked.push(id);
            if (id.startsWith('2')) throw new Error('database unavailable');
            return { data: id === listing.id ? listing : null };
          },
        });
        return query;
      },
    }) as unknown as SupabaseClient;
  const app = express();
  listingPages(app, db, 'https://relofted.example', () => template);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const found = await fetch(`${url}/listing/${listing.id}`);
    assert.equal(found.status, 200);
    assert.equal(found.headers.get('x-robots-tag'), null);
    assert.match(await found.text(), /<title>Ping G430/);
    // Sold or removed, a database failure, and a malformed address all get the plain app page.
    for (const id of ['33333333-3333-4333-8333-333333333333', '22222222-2222-4222-8222-222222222222', 'nonsense']) {
      const page = await fetch(`${url}/listing/${id}`);
      assert.equal(page.status, 200);
      assert.equal(page.headers.get('x-robots-tag'), 'noindex');
      assert.match(await page.text(), /<title>Relofted — /);
    }
    assert.ok(!asked.includes('nonsense'), 'a malformed id never reaches the database');
    const sitemap = await (await fetch(`${url}/sitemap.xml`)).text();
    assert.ok(
      sitemap.includes(`<loc>https://relofted.example/listing/${listing.id}</loc><lastmod>2026-11-19</lastmod>`),
    );
    assert.ok(sitemap.includes('<loc>https://relofted.example/terms.html</loc>'));
    assert.match(await (await fetch(`${url}/robots.txt`)).text(), /Sitemap: https:\/\/relofted.example\/sitemap.xml/);
  } finally {
    server.close();
  }
});
