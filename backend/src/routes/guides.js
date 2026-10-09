import express from 'express';
import { pool } from '../index.js';
import { mergeEventsAcrossSources } from './events.js';

const router = express.Router();

// Real, server-rendered "evergreen" SEO landing pages: one per
// artist+city combo that actually has upcoming, multi-source events —
// e.g. /guide/beyonce-tickets-denver. Unlike a per-event page (which is
// only useful for the ~2 weeks before that one show), these target the
// kind of search query a buyer actually types ("cheapest [artist]
// tickets [city]") and stay relevant across an artist's whole tour, so
// they're worth Google spending crawl budget/ranking signal on in a way
// thin auto-generated per-event pages aren't.
//
// Critically, every number/date/link on these pages comes straight from
// the same `events` table the rest of the site uses — nothing here is
// hand-written filler copy. A combo with zero upcoming events simply
// doesn't get a page (see topArtistCityCombos below), so there's no
// thin/empty content for Google to penalize.

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

function formatDate(dateStr) {
  if (!dateStr) return 'Date TBA';
  try {
    return new Date(dateStr).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  } catch {
    return String(dateStr);
  }
}

function eventSlug(event) {
  return slugify(`${event.title || event.artist_name || 'event'}-${event.city || ''}`);
}

// Artist+city combos worth a dedicated guide page: at least one upcoming
// event with a real price from at least one non-official, confirmed
// seller. Used to require 2+ distinct sources (a real price to compare)
// but the site's own catalog moved to being carried almost entirely by a
// single source (TicketNetwork) after Ticketmaster/SeatGeek were dropped
// as active sources — see sourceVisibility.js — so a 2-source floor left
// this whole page system dormant (0 live guides) against the real
// inventory. Lowered to 1+ (2026-10-06, user decision) to match the
// site's current "list events fast" positioning rather than "compare
// prices" — see eventsForArtistCity's render logic below for how the
// page copy itself adapts between the single- and multi-seller cases.
//
// ROOT CAUSE (found 2026-09-11) of this returning 0 combos, permanently,
// no matter how much inventory the site had: this used to GROUP BY the
// raw `events.artist_name` string and require an EXACT match across rows
// to count as "the same artist" for the >= 2-source check. That's much
// stricter than how the rest of the site already decides two rows are the
// same real event — routes/events.js's live merge and
// services/canonicalize.js's rebuild both use utils/matching.js's
// isSameEvent, a fuzzy title/venue/date matcher specifically built to
// survive naming differences between sources (accents, "Theatre" vs
// "Theater", stopwords, etc.) — and TicketNetwork's events (see
// services/ticketnetwork.js) don't populate artist_name at all, so they
// could never contribute a second source under the old exact-match query
// even when the SAME show was genuinely listed on both.
//
// Fix: read from canonical_events/ticket_offers (services/canonicalize.js)
// instead of raw `events` — that's the table already built by running the
// real isSameEvent matching once per rebuild (POST /admin/canonicalize/
// rebuild, also run automatically after every scheduled discovery sync),
// so "2 distinct sources for the same artist+city" here means 2 sources
// that were ALREADY confirmed to be the same real-world show, not just 2
// rows that happen to spell the artist's name identically.
//
// Capped generously below the sitemap limit; re-derived live on every
// request rather than cached, since the whole point is that this always
// reflects real current inventory.
async function topArtistCityCombos(limit = 300) {
  // t.price IS NOT NULL is required IN THE WHERE CLAUSE (not just checked
  // later when rendering) — without it, two sources can both list the same
  // canonical event with neither having a price yet, which satisfies
  // "2 distinct sources" here but leaves eventsForArtistCity's own
  // has-a-price filter with nothing to show, 404-ing a combo this query
  // just told the index page/sitemap was live. Filtering here keeps this
  // list and what eventsForArtistCity actually renders in sync.
  const result = await pool.query(`
    SELECT ce.artist_name, ce.city, ce.state,
           COUNT(DISTINCT p.name) AS source_count, COUNT(*) AS row_count
    FROM canonical_events ce
    JOIN ticket_offers t ON t.canonical_event_id = ce.id
    JOIN providers p ON p.id = t.provider_id
    WHERE ce.event_date >= NOW()
      AND ce.artist_name IS NOT NULL AND ce.artist_name != ''
      AND ce.city IS NOT NULL AND ce.city != ''
      AND p.name != 'official'
      AND t.price IS NOT NULL
    GROUP BY ce.artist_name, ce.city, ce.state
    HAVING COUNT(DISTINCT p.name) >= 1
    ORDER BY source_count DESC, row_count DESC
    LIMIT $1
  `, [limit]);
  return result.rows;
}

// Finds the raw `events` rows behind every canonical event for this
// artist+city (already fuzzy cross-source matched — see
// topArtistCityCombos above) via ticket_offers.source_event_row_id, then
// merges them the same way the live site does. This replaces the old
// exact `events.artist_name = $1` lookup, which would miss legitimate
// group members whose raw artist_name differs (or is NULL, as with every
// TicketNetwork row) from whichever spelling this artist+city pair is
// keyed by.
async function eventsForArtistCity(artistName, city) {
  const canonicalRows = await pool.query(
    `SELECT id FROM canonical_events WHERE artist_name = $1 AND city = $2 AND event_date >= NOW()`,
    [artistName, city],
  );
  const canonicalIds = canonicalRows.rows.map((r) => r.id);
  if (canonicalIds.length === 0) return [];

  const offerRows = await pool.query(
    `SELECT DISTINCT source_event_row_id FROM ticket_offers
     WHERE canonical_event_id = ANY($1) AND source_event_row_id IS NOT NULL`,
    [canonicalIds],
  );
  const eventRowIds = offerRows.rows.map((r) => r.source_event_row_id);
  if (eventRowIds.length === 0) return [];

  const result = await pool.query(
    `SELECT * FROM events WHERE id = ANY($1) AND date >= NOW() ORDER BY date ASC LIMIT 200`,
    [eventRowIds],
  );
  return mergeEventsAcrossSources(result.rows).filter((e) => e.offers.some((o) => o.min_price != null));
}

// GET /guide  — index of all live guide pages, for internal linking (the
// homepage/nav should link here too) and so it's crawlable without
// needing the full combo list baked into the sitemap.
router.get('/guide', async (req, res) => {
  try {
    const combos = await topArtistCityCombos();
    const items = combos.map((c) => {
      const slug = `${slugify(c.artist_name)}-tickets-${slugify(c.city)}`;
      return `<li><a href="/guide/${xmlEscape(slug)}">${xmlEscape(c.artist_name)} tickets in ${xmlEscape(c.city)}${c.state ? `, ${xmlEscape(c.state)}` : ''}</a></li>`;
    });
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>Ticket Guides by Artist & City | ConcertAndMatches</title>
<meta name="description" content="Find tickets, prices, and show dates for upcoming concerts, sports, and theater, organized by artist and city." />
<link rel="canonical" href="https://www.concertandmatches.com/guide" />
</head>
<body>
<h1>Ticket guides</h1>
<p>${items.length} artist/city guides, generated from currently listed shows with at least one confirmed ticket seller.</p>
<ul>${items.join('')}</ul>
<p><a href="/">Back to ConcertAndMatches</a></p>
</body>
</html>`;
    res.set('Content-Type', 'text/html');
    res.send(html);
  } catch (error) {
    console.error('Guide index failed:', error);
    res.status(500).send('Failed to generate guide index');
  }
});

// GET /guide/:slug — a single artist+city guide page, e.g.
// /guide/beyonce-tickets-denver. The slug is parsed by re-slugifying
// every real combo and matching against it (small dataset, cheap) rather
// than trying to invert slugify() — keeps this in sync with the index
// above by construction instead of by convention.
router.get('/guide/:slug', async (req, res) => {
  try {
    const requested = req.params.slug;
    const combos = await topArtistCityCombos();
    const match = combos.find((c) => `${slugify(c.artist_name)}-tickets-${slugify(c.city)}` === requested);

    if (!match) {
      res.status(404).set('Content-Type', 'text/html').send('<!doctype html><html><head><title>Guide not found — ConcertAndMatches</title></head><body><p>We don\'t have a live guide for that artist/city yet. <a href="/guide">See all guides</a>.</p></body></html>');
      return;
    }

    const events = await eventsForArtistCity(match.artist_name, match.city);
    if (events.length === 0) {
      // The combo query and this query can race with a sync job between
      // requests (events selling out / a source dropping below 2 sellers).
      // Fail to a clean 404 rather than rendering an empty, thin page.
      res.status(404).set('Content-Type', 'text/html').send('<!doctype html><html><head><title>Guide not found — ConcertAndMatches</title></head><body><p>This guide is no longer live. <a href="/guide">See all guides</a>.</p></body></html>');
      return;
    }

    const cheapest = events.reduce((a, b) => (Number(a.best_price ?? Infinity) <= Number(b.best_price ?? Infinity) ? a : b));
    const url = `https://www.concertandmatches.com/guide/${xmlEscape(requested)}`;

    // Multi- vs. single-seller wording (added 2026-10-06, alongside
    // lowering topArtistCityCombos' source floor to 1+): with the catalog
    // now carried almost entirely by one source (TicketNetwork), most
    // guide pages have exactly one seller — saying "compare prices" on a
    // page with one price is actively misleading, so every place that
    // used to assume 2+ sellers now branches on the real count instead.
    const sourceNames = [...new Set(events.flatMap((e) => e.offers.filter((o) => o.min_price != null).map((o) => o.source)))];
    const isMultiSource = sourceNames.length >= 2;

    const title = isMultiSource
      ? `Cheapest ${match.artist_name} Tickets in ${match.city}${match.state ? `, ${match.state}` : ''} — Compare Prices | ConcertAndMatches`
      : `${match.artist_name} Tickets in ${match.city}${match.state ? `, ${match.state}` : ''} — Dates & Prices | ConcertAndMatches`;
    const description = isMultiSource
      ? `Compare live ${match.artist_name} ticket prices in ${match.city} across every confirmed seller. ${events.length} upcoming show${events.length === 1 ? '' : 's'}, starting from $${Number(cheapest.best_price).toFixed(0)}.`
      : `${match.artist_name} ticket prices and dates in ${match.city}. ${events.length} upcoming show${events.length === 1 ? '' : 's'}, starting from $${Number(cheapest.best_price).toFixed(0)}.`;

    // FAQ block (added 2026-10-06) — every answer is computed straight from
    // the same `events` data rendered in the table above, nothing
    // hand-written. The point is to add real, unique, indexable text per
    // page: this site's pages were showing an average Google search
    // position of ~31 (page 3-4) per Search Console, and a guide page
    // whose only content is a results table has very little for Google to
    // match a long-tail question query against. A direct Q&A for the
    // queries buyers actually type ("how much are X tickets in Y", "where
    // can I buy X tickets in Y", "when is X playing in Y next") gives
    // those queries real text to match, without inventing any copy —
    // every number below already exists elsewhere on this same page.
    const nextShow = events[0];
    const soonestDate = formatDate(nextShow.date);
    const highestPrice = events.reduce(
      (max, e) => Math.max(max, ...e.offers.filter((o) => o.min_price != null).map((o) => Number(o.min_price))),
      Number(cheapest.best_price)
    );
    const faqs = [
      {
        q: `How much are ${match.artist_name} tickets in ${match.city}?`,
        a: `Prices currently start around $${Number(cheapest.best_price).toFixed(0)}${highestPrice > Number(cheapest.best_price) ? ` and go up to about $${highestPrice.toFixed(0)} depending on seller and seat` : ''}, based on live listings from ${sourceNames.length} confirmed seller${sourceNames.length === 1 ? '' : 's'}.`,
      },
      {
        q: `When is ${match.artist_name} next playing in ${match.city}?`,
        a: `The next confirmed date is ${soonestDate}${nextShow.venue_name ? ` at ${nextShow.venue_name}` : ''}.${events.length > 1 ? ` There ${events.length - 1 === 1 ? 'is' : 'are'} ${events.length - 1} more upcoming show${events.length - 1 === 1 ? '' : 's'} listed below.` : ''}`,
      },
      {
        q: `Where can I buy ${match.artist_name} tickets in ${match.city}?`,
        a: isMultiSource
          ? `This page compares live listings from ${sourceNames.join(', ')}. ConcertAndMatches links you through to buy directly on the seller's own site — we don't sell tickets ourselves.`
          : `This page lists live availability from ${sourceNames[0] || 'a confirmed seller'}. ConcertAndMatches links you through to buy directly on the seller's own site — we don't sell tickets ourselves.`,
      },
    ];
    const faqJsonLd = {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: faqs.map((f) => ({
        '@type': 'Question',
        name: f.q,
        acceptedAnswer: { '@type': 'Answer', text: f.a },
      })),
    };
    const faqHtml = faqs.map((f) => `<h2>${xmlEscape(f.q)}</h2><p>${xmlEscape(f.a)}</p>`).join('\n');

    const rows = events.map((e) => {
      const eventUrl = `https://www.concertandmatches.com/event/${e.id}-${eventSlug(e)}`;
      const offerList = e.offers
        .filter((o) => o.min_price != null)
        .sort((a, b) => Number(a.min_price) - Number(b.min_price))
        .map((o) => `${xmlEscape(o.source)}: $${Number(o.min_price).toFixed(0)}`)
        .join(' · ');
      return `<tr>
        <td>${xmlEscape(formatDate(e.date))}</td>
        <td>${xmlEscape(e.venue_name || '')}</td>
        <td>${offerList || '—'}</td>
        <td><a href="${xmlEscape(eventUrl)}">Compare &amp; buy →</a></td>
      </tr>`;
    }).join('');

    const jsonLd = {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: title,
      description,
      url,
    };

    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>${xmlEscape(title)}</title>
<meta name="description" content="${xmlEscape(description)}" />
<link rel="canonical" href="${xmlEscape(url)}" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="ConcertAndMatches" />
<meta property="og:title" content="${xmlEscape(title)}" />
<meta property="og:description" content="${xmlEscape(description)}" />
<meta property="og:url" content="${xmlEscape(url)}" />
<meta property="og:image" content="https://www.concertandmatches.com/og-image.png" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${xmlEscape(title)}" />
<meta name="twitter:description" content="${xmlEscape(description)}" />
<meta name="twitter:image" content="https://www.concertandmatches.com/og-image.png" />
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<script type="application/ld+json">${JSON.stringify(faqJsonLd)}</script>
</head>
<body>
<h1>${xmlEscape(match.artist_name)} tickets in ${xmlEscape(match.city)}${match.state ? `, ${xmlEscape(match.state)}` : ''}</h1>
<p>${xmlEscape(description)}</p>
<table>
<thead><tr><th>Date</th><th>Venue</th><th>Prices by seller</th><th></th></tr></thead>
<tbody>${rows}</tbody>
</table>
<p>Prices update as sellers change theirs — always confirm the final price on the seller's site before buying. ConcertAndMatches doesn't sell tickets directly; we list availability from authorized sellers and link you through to buy.</p>
${faqHtml}
<p><a href="/artists/${xmlEscape(slugify(match.artist_name))}">All ${xmlEscape(match.artist_name)} tickets</a> · <a href="/cities/${xmlEscape(slugify(`${match.city}-${match.state || ''}`))}/concerts">All concerts in ${xmlEscape(match.city)}</a> · <a href="/guide">See all price guides</a> · <a href="/">Back to ConcertAndMatches</a></p>
</body>
</html>`;

    res.set('Content-Type', 'text/html');
    res.send(html);
  } catch (error) {
    console.error('Guide page failed:', error);
    res.status(500).send('Failed to generate guide page');
  }
});

export { topArtistCityCombos, slugify as guideSlugify };
export default router;
