import express from 'express';
import { pool } from '../index.js';
import { mergeEventsAcrossSources } from './events.js';
import { topArtistCityCombos, guideSlugify } from './guides.js';

const router = express.Router();

// Mounted at the app root (not under /api) so it can be reached at
// GET /sitemap.xml directly — the path search engines actually check.

function slugify(text) {
  return (text || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'event';
}

function xmlEscape(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Real, per-event URLs (spec §12, §20-22) — one <url> per deduplicated
// event card, matching exactly what a customer sees on the site (not one
// entry per raw source row). Only future events are listed — a sitemap
// full of concerts that already happened doesn't help discovery and just
// dilutes crawl budget. Capped well under the 50,000-URL sitemap protocol
// limit; the site currently has a few thousand events, so this isn't a
// real constraint today.
const SITEMAP_URL_CAP = 5000;
const SITE_ORIGIN = 'https://www.concertandmatches.com';

router.get('/sitemap.xml', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM events WHERE date >= NOW() ORDER BY date ASC LIMIT 8000`
    );
    const merged = mergeEventsAcrossSources(result.rows).slice(0, SITEMAP_URL_CAP);

    const urlEntries = merged.map((event) => {
      const slug = slugify(`${event.title || event.artist_name || 'event'}-${event.city || ''}`);
      const loc = `${SITE_ORIGIN}/event/${event.id}-${slug}`;
      const lastmodSource = event.updated_at || event.date || new Date();
      const lastmod = new Date(lastmodSource).toISOString();
      return `  <url>\n    <loc>${xmlEscape(loc)}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`;
    });

    // Evergreen artist+city guide pages (see routes/guides.js) — worth a
    // higher changefreq than per-event pages since their content (the list
    // of upcoming shows/prices for that artist in that city) shifts as
    // often as sync jobs run, not just once around one show's date.
    const combos = await topArtistCityCombos();
    const guideEntries = combos.map((c) => {
      const loc = `${SITE_ORIGIN}/guide/${guideSlugify(c.artist_name)}-tickets-${guideSlugify(c.city)}`;
      return `  <url>\n    <loc>${xmlEscape(loc)}</loc>\n    <changefreq>daily</changefreq>\n  </url>`;
    });

    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[...urlEntries, ...guideEntries].join('\n')}\n</urlset>\n`;

    res.set('Content-Type', 'application/xml');
    res.send(xml);
  } catch (error) {
    console.error('Error generating sitemap:', error);
    res.status(500).set('Content-Type', 'text/plain').send('Failed to generate sitemap');
  }
});

export default router;
