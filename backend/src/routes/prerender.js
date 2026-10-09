import express from 'express';
import { getMergedEventById } from './events.js';
import { slugify as entitySlugify } from '../services/seoEngine.js';

const router = express.Router();

// Real SSR for event pages (2026-10-09 rewrite — see git history for the
// original bot-only "dynamic rendering" version this replaced).
//
// The old approach routed ONLY bot User-Agents here via a Vercel Routing
// Middleware (middleware.mjs) conditional rewrite; real humans/Googlebot's
// JS-executing crawl still got the bare index.html SPA shell, which only
// gets correct per-event title/meta/JSON-LD after client-side hydration.
// That middleware DOES execute (confirmed by its own in-file history), but
// proved repeatedly fragile across several real incidents: bot User-Agent
// strings it didn't recognize (e.g. Google-InspectionTool) silently fell
// through to the SPA; a silent fetch failure with no visible logs on this
// Vercel plan was indistinguishable from "not a bot"; and the CDN cached
// whichever response (bot or human) happened to be generated first for a
// given /event/:id path and served it to everyone after, bot or not, until
// a no-store header was added. Each of those took a live GSC Test-Live-URL
// cycle to even diagnose. Rather than keep patching a UA-branching proxy
// with that failure history, this routes every visitor through the exact
// same code path — no UA check left to get out of sync with reality.
//
// Fix: vercel.json now rewrites EVERY visit to /event/:id-:slug to this
// route unconditionally — bot or human, no UA branching, no middleware
// dependency — exactly like guide/artist/city/venue/team pages already do
// via their own plain rewrites to seoPages.js. The difference from those
// pages: this route fetches the site's own live index.html (cached 5 min)
// and reuses its real <script>/<link> tags for the built JS/CSS bundle,
// then swaps in the real per-event <title>/meta/canonical/OG/Twitter/
// JSON-LD and seeds #root with a static summary of the event. Because
// main.tsx calls ReactDOM.createRoot(...).render(...) — not hydrateRoot —
// React simply replaces that seeded content once the bundle loads, so
// human visitors still get the full live-price/buy-ticket SPA exactly as
// before, just with a correct, real first paint. A crawler that doesn't
// execute JS (most link-preview bots, some simple crawlers) sees the
// static summary and never knows the difference.
let cachedShell = null;
let cachedShellAt = 0;
const SHELL_CACHE_MS = 5 * 60 * 1000;
async function getLiveShell() {
  if (cachedShell && Date.now() - cachedShellAt < SHELL_CACHE_MS) return cachedShell;
  const r = await fetch('https://www.concertandmatches.com/');
  if (!r.ok) throw new Error(`Shell fetch failed: ${r.status}`);
  const html = await r.text();
  cachedShell = html;
  cachedShellAt = Date.now();
  return html;
}

// Strips the homepage-specific title/meta/canonical/JSON-LD from a fetched
// shell so the per-event versions can be inserted in their place without
// leaving duplicate <title>/<meta>/<script> tags in the response (which
// would confuse crawlers about which value is authoritative).
function stripGenericHead(html) {
  return html
    .replace(/<title>[\s\S]*?<\/title>/i, '')
    .replace(/<meta\s+name="description"[^>]*>/i, '')
    .replace(/<link\s+rel="canonical"[^>]*>/i, '')
    .replace(/<meta\s+property="og:[^"]*"[^>]*>\s*/gi, '')
    .replace(/<meta\s+name="twitter:[^"]*"[^>]*>\s*/gi, '')
    .replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>\s*/gi, '');
}

function xmlEscape(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function slugify(text) {
  return (text || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'event';
}

// Maps this codebase's stored `country` value (a full name like 'USA'/
// 'Canada'/'United Kingdom', or occasionally a bare ISO code when
// Ticketmaster didn't supply a country name — see storeEvent in
// services/ticketmaster.js) to the ISO 3166-1 alpha-2 code schema.org's
// addressCountry expects. Was previously hardcoded to `=== 'Canada' ? 'CA'
// : 'US'`, which silently mislabeled every non-US/Canadian event as US once
// worldwide sync was added (2026-09-26). Not exhaustive — covers the
// markets Ticketmaster's Discovery API actually serves — but falls back to
// a 2-letter value already looking like a code, or omits the field
// entirely, rather than ever guessing wrong.
const COUNTRY_NAME_TO_ISO = {
  'USA': 'US', 'United States': 'US', 'United States of America': 'US',
  'Canada': 'CA', 'Mexico': 'MX', 'United Kingdom': 'GB', 'Ireland': 'IE',
  'Australia': 'AU', 'New Zealand': 'NZ', 'Germany': 'DE', 'Netherlands': 'NL',
  'Belgium': 'BE', 'Sweden': 'SE', 'Poland': 'PL', 'Austria': 'AT',
  'Spain': 'ES', 'France': 'FR', 'Italy': 'IT', 'Singapore': 'SG',
  'Japan': 'JP', 'South Africa': 'ZA', 'Switzerland': 'CH', 'Denmark': 'DK',
  'Norway': 'NO', 'Finland': 'FI', 'Portugal': 'PT',
};
function toIsoCountryCode(country) {
  if (!country) return undefined;
  if (COUNTRY_NAME_TO_ISO[country]) return COUNTRY_NAME_TO_ISO[country];
  if (/^[A-Za-z]{2}$/.test(country)) return country.toUpperCase();
  return undefined;
}

function formatDate(dateStr) {
  if (!dateStr) return 'Date TBA';
  try {
    return new Date(dateStr).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  } catch {
    return String(dateStr);
  }
}

router.get('/event/:pathParam', async (req, res) => {
  try {
    const match = /^(\d+)/.exec(req.params.pathParam || '');
    if (!match) return res.status(400).send('Invalid event id');
    const id = match[1];

    const event = await getMergedEventById(id);
    if (!event) {
      res.status(404).set('Content-Type', 'text/html').send('<!doctype html><html><head><title>Event not found — ConcertAndMatches</title></head><body><p>This event could not be found. It may have been removed.</p></body></html>');
      return;
    }

    // Title/meta tuning (2026-10-09): the prior title/description never
    // included the city or starting price. Both are proven higher-CTR
    // signals already used elsewhere in this codebase (routes/guides.js's
    // "starting from $X" pattern) — a searcher typing "[artist] tickets
    // [city]" or comparison-shopping on price sees neither in the old
    // copy, even when the data is already on hand for every event with at
    // least one priced offer. City is included only when known; price only
    // when at least one offer has a real min_price, so this never
    // fabricates a number.
    const offers = Array.isArray(event.offers) ? event.offers : [];
    const pricedOffers = offers.filter((o) => o.min_price != null);
    const startingPrice = pricedOffers.length > 0
      ? Math.min(...pricedOffers.map((o) => Number(o.min_price)))
      : null;

    const title = `${event.title} Tickets${event.city ? ` in ${event.city}` : ''} — ${formatDate(event.date)} | ConcertAndMatches`;
    const description = `Get tickets for ${event.title}${event.venue_name ? ` at ${event.venue_name}` : ''}${event.city ? ` in ${event.city}` : ''} on ${formatDate(event.date)}.${startingPrice != null ? ` Prices start at $${startingPrice.toFixed(0)}.` : ''} Listed from multiple authorized sellers.`;
    const slug = slugify(`${event.title || event.artist_name || 'event'}-${event.city || ''}`);
    const url = `https://www.concertandmatches.com/event/${event.id}-${slug}`;
    const offersForLd = offers
      .filter((o) => o.min_price != null)
      .map((o) => ({
        '@type': 'Offer',
        price: Number(o.min_price).toFixed(2),
        priceCurrency: o.currency || 'USD',
        availability: 'https://schema.org/InStock',
        url,
      }));

    // Approximate end time — none of the active sources (TicketNetwork
    // above all) carry a real end time, and Google's Event structured-data
    // check flags a missing endDate. Three hours is a reasonable default
    // for a single concert/game/show; guarded so an invalid/missing
    // event.date can't produce an "Invalid Date" string in the output.
    const startDateObj = new Date(event.date);
    const endDateIso = Number.isNaN(startDateObj.getTime())
      ? undefined
      : new Date(startDateObj.getTime() + 3 * 60 * 60 * 1000).toISOString();

    // Offer.validFrom — when this listing became available to buy. No
    // source captures a real on-sale date, so the row's own updated_at
    // (when it was last synced) is the closest honest proxy: a real
    // timestamp rather than a fabricated one, and satisfies the field
    // Google flags as missing.
    const validFromIso = event.updated_at
      ? new Date(event.updated_at).toISOString()
      : new Date().toISOString();
    const offersForLdWithValidFrom = offersForLd.map((o) => ({ ...o, validFrom: validFromIso }));

    const jsonLd = {
      '@context': 'https://schema.org',
      '@type': 'Event',
      name: event.title,
      description,
      startDate: event.date,
      ...(endDateIso ? { endDate: endDateIso } : {}),
      eventStatus: 'https://schema.org/EventScheduled',
      ...(event.image_url ? { image: [event.image_url] } : {}),
      location: {
        '@type': 'Place',
        name: event.venue_name || undefined,
        address: {
          '@type': 'PostalAddress',
          addressLocality: event.city || undefined,
          addressRegion: event.state || undefined,
          ...(toIsoCountryCode(event.country) ? { addressCountry: toIsoCountryCode(event.country) } : {}),
        },
      },
      // performer: artist_name when a source gave us one; otherwise the
      // event's own title is the closest honest stand-in (common for
      // TicketNetwork sports/theater listings with no separate artist
      // field) — better than omitting the field Google flags as missing.
      performer: { '@type': 'PerformingGroup', name: event.artist_name || event.title },
      // organizer: no source captures a real promoter/organizer, so the
      // venue (which does host/organize the event in the broad sense) is
      // used as a reasonable stand-in, falling back to the site itself
      // only when even a venue name is missing.
      organizer: event.venue_name
        ? { '@type': 'Organization', name: event.venue_name }
        : { '@type': 'Organization', name: 'ConcertAndMatches', url: 'https://www.concertandmatches.com/' },
      ...(offersForLdWithValidFrom.length > 0 ? { offers: offersForLdWithValidFrom } : {}),
    };

    const offersHtml = offers.length > 0
      ? `<ul>${offers.map((o) => `<li>${xmlEscape(o.source)}${o.min_price != null ? `: from $${Number(o.min_price).toFixed(0)}` : ''}</li>`).join('')}</ul>`
      : '<p>No confirmed ticket seller yet — check back soon.</p>';

    // Internal links up to the hub/collection pages (seoPages.js) — this
    // event page previously had none at all, just a self-link, which left
    // the ~15k individual event pages as crawl dead-ends with no path back
    // into /artists, /cities, /venues. Each target page (getArtistPage/
    // getCityPage/getVenuePage in seoEngine.js) is itself gated by an
    // inventory/score "tier" so not every artist/city/venue clears the bar
    // for its own page — these links can occasionally 404. That 404 is a
    // clean, noindex page (seoPages.js: notFoundPage()), not a broken
    // experience, and re-querying discoverArtists/discoverCities/
    // discoverVenues (each scans up to 2000 scored rows) on every single
    // event-page render to pre-validate every link would be a real cost for
    // a soft benefit — so this accepts the occasional dead link rather than
    // paying that tax on every page view.
    const relatedLinks = [];
    if (event.artist_name) {
      relatedLinks.push(`<a href="/artists/${xmlEscape(entitySlugify(event.artist_name))}">More ${xmlEscape(event.artist_name)} tickets</a>`);
    }
    if (event.city) {
      const citySlug = entitySlugify(`${event.city}-${event.state || ''}`);
      relatedLinks.push(`<a href="/cities/${xmlEscape(citySlug)}/events">More events in ${xmlEscape(event.city)}${event.state ? `, ${xmlEscape(event.state)}` : ''}</a>`);
    }
    if (event.venue_name) {
      const venueSlug = entitySlugify(`${event.venue_name}-${event.city || ''}`);
      relatedLinks.push(`<a href="/venues/${xmlEscape(venueSlug)}">More events at ${xmlEscape(event.venue_name)}</a>`);
    }
    const breadcrumbHtml = `<nav aria-label="breadcrumb"><p><a href="/">Home</a>${event.city ? ` &raquo; <a href="/cities/${xmlEscape(entitySlugify(`${event.city}-${event.state || ''}`))}/events">${xmlEscape(event.city)}${event.state ? `, ${xmlEscape(event.state)}` : ''}</a>` : ''} &raquo; ${xmlEscape(event.title)}</p></nav>`;
    const relatedLinksHtml = relatedLinks.length > 0
      ? `<h2>Related</h2><ul>${relatedLinks.map((l) => `<li>${l}</li>`).join('')}</ul>`
      : '';

    const eventHeadTags = `<title>${xmlEscape(title)}</title>
<meta name="description" content="${xmlEscape(description)}" />
<link rel="canonical" href="${xmlEscape(url)}" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="ConcertAndMatches" />
<meta property="og:title" content="${xmlEscape(title)}" />
<meta property="og:description" content="${xmlEscape(description)}" />
<meta property="og:url" content="${xmlEscape(url)}" />
<meta property="og:image" content="${xmlEscape(event.image_url || 'https://www.concertandmatches.com/og-image.png')}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${xmlEscape(title)}" />
<meta name="twitter:description" content="${xmlEscape(description)}" />
<meta name="twitter:image" content="${xmlEscape(event.image_url || 'https://www.concertandmatches.com/og-image.png')}" />
<meta name="robots" content="index, follow" />
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
</head>`;

    const rootContent = `${breadcrumbHtml}
<h1>${xmlEscape(event.title)}</h1>
${event.artist_name ? `<p>${xmlEscape(event.artist_name)}</p>` : ''}
<p>Date: ${xmlEscape(formatDate(event.date))}</p>
<p>Location: ${xmlEscape(event.venue_name || '')}${event.city ? `, ${xmlEscape(event.city)}` : ''}${event.state ? `, ${xmlEscape(event.state)}` : ''}</p>
<h2>Ticket Sellers</h2>
${offersHtml}
${relatedLinksHtml}`;

    let html;
    try {
      const shell = await getLiveShell();
      const strippedShell = stripGenericHead(shell);
      // Insert our tags right before the shell's own </head>, and seed
      // #root with the static summary so a non-JS crawler still has real
      // content even if it ignores the <script> tag entirely.
      html = strippedShell
        .replace('</head>', eventHeadTags)
        .replace('<div id="root"></div>', `<div id="root">${rootContent}</div>`);
      // Belt-and-braces: if either expected anchor wasn't found (a future
      // index.html edit changes its shape), fall back below rather than
      // silently shipping a malformed page.
      if (!html.includes('<title>') || !html.includes('id="root"')) throw new Error('Shell merge anchors not found');
    } catch (shellError) {
      // Live-shell fetch/merge failed (Vercel hiccup, index.html shape
      // changed, etc.) — fall back to the original bare static page rather
      // than failing the request. Worse for humans (no live SPA) but still
      // fully correct for SEO, and self-heals next cache cycle.
      console.error('Prerender shell merge failed, falling back to static-only page:', shellError.message);
      html = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
${eventHeadTags}
<body>
${rootContent}
<p><a href="${xmlEscape(url)}">View live prices and buy tickets on ConcertAndMatches</a></p>
</body>
</html>`;
    }

    res.set('Content-Type', 'text/html');
    res.send(html);
  } catch (error) {
    console.error('Prerender failed:', error);
    res.status(500).send('Failed to render event page');
  }
});

export default router;
