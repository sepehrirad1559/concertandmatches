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
// event, and — the actual value proposition of this site — at least two
// distinct non-official sources so there's a real price to compare.
// Capped generously below the sitemap limit; re-derived live on every
// request rather than cached/precomputed, since the whole point is that
// this always reflects real current inventory.
async function topArtistCityCombos(limit = 300) {
  const result = await pool.query(`
    SELECT artist_name, city, state, COUNT(DISTINCT source) AS source_count, COUNT(*) AS row_count
    FROM events
    WHERE date >= NOW()
      AND artist_name IS NOT NULL AND artist_name != ''
      AND city IS NOT NULL AND city != ''
      AND source != 'official'
    GROUP BY artist_name, city, state
    HAVING COUNT(DISTINCT source) >= 2
    ORDER BY source_count DESC, row_count DESC
    LIMIT $1
  `, [limit]);
  return result.rows;
}

async function eventsForArtistCity(artistName, city) {
  const result = await pool.query(
    `SELECT * FROM events
     WHERE date >= NOW() AND artist_name = $1 AND city = $2
     ORDER BY date ASC
     LIMIT 200`,
    [artistName, city],
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
<title>Ticket Price Guides by Artist & City | ConcertAndMatches.com</title>
<meta name="description" content="Compare ticket prices across every upcoming show with more than one confirmed seller, organized by artist and city." />
<link rel="canonical" href="https://www.concertandmatches.com/guide" />
</head>
<body>
<h1>Ticket price guides</h1>
<p>${items.length} artist/city guides, generated from currently listed shows with more than one confirmed ticket seller.</p>
<ul>${items.join('')}</ul>
<p><a href="/">Back to ConcertAndMatches.com</a></p>
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
      res.status(404).set('Content-Type', 'text/html').send('<!doctype html><html><head><title>Guide not found — ConcertAndMatches.com</title></head><body><p>We don\'t have a live guide for that artist/city yet. <a href="/guide">See all guides</a>.</p></body></html>');
      return;
    }

    const events = await eventsForArtistCity(match.artist_name, match.city);
    if (events.length === 0) {
      // The combo query and this query can race with a sync job between
      // requests (events selling out / a source dropping below 2 sellers).
      // Fail to a clean 404 rather than rendering an empty, thin page.
      res.status(404).set('Content-Type', 'text/html').send('<!doctype html><html><head><title>Guide not found — ConcertAndMatches.com</title></head><body><p>This guide is no longer live. <a href="/guide">See all guides</a>.</p></body></html>');
      return;
    }

    const cheapest = events.reduce((a, b) => (Number(a.best_price ?? Infinity) <= Number(b.best_price ?? Infinity) ? a : b));
    const title = `Cheapest ${match.artist_name} Tickets in ${match.city}${match.state ? `, ${match.state}` : ''} — Compare Prices | ConcertAndMatches.com`;
    const description = `Compare live ${match.artist_name} ticket prices in ${match.city} across every confirmed seller. ${events.length} upcoming show${events.length === 1 ? '' : 's'}, starting from $${Number(cheapest.best_price).toFixed(0)}.`;
    const url = `https://www.concertandmatches.com/guide/${xmlEscape(requested)}`;

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
<meta property="og:site_name" content="ConcertAndMatches.com" />
<meta property="og:title" content="${xmlEscape(title)}" />
<meta property="og:description" content="${xmlEscape(description)}" />
<meta property="og:url" content="${xmlEscape(url)}" />
<meta name="twitter:card" content="summary" />
<meta name="twitter:title" content="${xmlEscape(title)}" />
<meta name="twitter:description" content="${xmlEscape(description)}" />
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
</head>
<body>
<h1>${xmlEscape(match.artist_name)} tickets in ${xmlEscape(match.city)}${match.state ? `, ${xmlEscape(match.state)}` : ''}</h1>
<p>${xmlEscape(description)}</p>
<table>
<thead><tr><th>Date</th><th>Venue</th><th>Prices by seller</th><th></th></tr></thead>
<tbody>${rows}</tbody>
</table>
<p>Prices update as sellers change theirs — always confirm the final price on the seller's site before buying. ConcertAndMatches doesn't sell tickets directly; we compare listings from authorized sellers and link you through to buy.</p>
<p><a href="/guide">See all price guides</a> · <a href="/">Back to ConcertAndMatches.com</a></p>
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
