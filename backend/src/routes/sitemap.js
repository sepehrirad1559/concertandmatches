import express from 'express';
import { pool } from '../index.js';
import { mergeEventsAcrossSources } from './events.js';
import { topArtistCityCombos, guideSlugify } from './guides.js';
import { discoverArtists, discoverCities, discoverVenues, LEAGUE_DEFS, discoverTeams } from '../services/seoEngine.js';
import { ACTIVE_SOURCES } from '../config/sourceVisibility.js';
import { appendPricedOnlyFilter } from '../config/priceVisibility.js';

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
    // TEMPORARY (see config/sourceVisibility.js): don't keep advertising
    // hidden-source events to search engines while they're hidden on-site.
    // PERMANENT (see config/priceVisibility.js): same for sold-out/unpriced
    // events — never worth a crawl budget slot or a search-result click that
    // leads to "Price TBA".
    let sitemapWhere = 'WHERE date >= NOW()';
    sitemapWhere = appendPricedOnlyFilter(sitemapWhere);
    const sitemapParams = [];
    if (ACTIVE_SOURCES) {
      sitemapWhere += ` AND source = ANY($1::text[])`;
      sitemapParams.push(ACTIVE_SOURCES);
    }
    const result = await pool.query(
      `SELECT * FROM events ${sitemapWhere} ORDER BY date ASC LIMIT 8000`,
      sitemapParams
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

    // Programmatic SEO pages (routes/seoPages.js + services/seoEngine.js) —
    // discover* already excludes 'do-not-index' tier candidates, so every
    // URL below is backed by real, currently-listed inventory. Priority is
    // derived from tier so tier1 pages get the strongest internal signal.
    const priorityForTier = (tier) => (tier === 'tier1' ? '0.8' : tier === 'tier2' ? '0.6' : '0.4');
    const seoEntry = (loc, tier) => `  <url>\n    <loc>${xmlEscape(loc)}</loc>\n    <changefreq>daily</changefreq>\n    <priority>${priorityForTier(tier)}</priority>\n  </url>`;

    const [artists, cities, venues, teams] = await Promise.all([
      discoverArtists({ limit: 2000 }).catch(() => []),
      discoverCities({ limit: 2000 }).catch(() => []),
      discoverVenues({ limit: 2000 }).catch(() => []),
      discoverTeams({ limit: 2000 }).catch(() => []),
    ]);

    // A handful of fixed, always-worth-including league pages — listed
    // first among the SEO entries (and given the same tier1 priority as
    // the highest-value dynamic pages) so a global truncation below can
    // never starve them out the way it did before this fix (a large
    // cities/venues/teams batch was pushing these 6 URLs past the cap).
    const leagueEntries = Object.keys(LEAGUE_DEFS).map((slug) => seoEntry(`${SITE_ORIGIN}/leagues/${slug}`, 'tier1'));

    // Sort each dynamic set tier1-first so if a cap ever does truncate,
    // the highest-opportunity pages are the ones kept.
    const tierRank = { tier1: 0, tier2: 1, tier3: 2 };
    const byTier = (a, b) => (tierRank[a.tier] ?? 3) - (tierRank[b.tier] ?? 3);

    const artistEntries = [...artists].sort(byTier).map((a) => seoEntry(`${SITE_ORIGIN}/artists/${a.slug}`, a.tier));
    const cityEntries = [...cities].sort(byTier).flatMap((c) => ['events', 'concerts', 'sports'].map((v) => seoEntry(`${SITE_ORIGIN}/cities/${c.slug}/${v}`, c.tier)));
    const venueEntries = [...venues].sort(byTier).map((v) => seoEntry(`${SITE_ORIGIN}/venues/${v.slug}`, v.tier));
    const teamEntries = [...teams].sort(byTier).map((t) => seoEntry(`${SITE_ORIGIN}/teams/${t.slug}`, t.tier));

    // Comfortably under the 50,000-URL sitemap protocol limit even with
    // every entity type at its own individual query cap (2000 each for
    // artists/venues/teams, 2000 cities x3 variants) plus the event and
    // guide entries above.
    const SEO_SITEMAP_CAP = 45000;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[...urlEntries, ...guideEntries, ...leagueEntries, ...artistEntries, ...cityEntries, ...venueEntries, ...teamEntries].slice(0, SEO_SITEMAP_CAP).join('\n')}\n</urlset>\n`;

    res.set('Content-Type', 'application/xml');
    res.send(xml);
  } catch (error) {
    console.error('Error generating sitemap:', error);
    res.status(500).set('Content-Type', 'text/plain').send('Failed to generate sitemap');
  }
});

export default router;
