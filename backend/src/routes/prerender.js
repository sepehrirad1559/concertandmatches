import express from 'express';
import { getMergedEventById } from './events.js';

const router = express.Router();

// "Dynamic rendering" for bots (spec §20-22 — real SEO, tackled the rest of
// the way). The frontend is a client-rendered SPA: a human's browser and a
// JS-executing crawler (Googlebot) run the app and see the per-event
// title/meta/JSON-LD that App.jsx sets after fetching the event. A simple
// crawler or link-preview bot (Slackbot, Twitterbot, most others) does NOT
// execute JS, so it only ever sees the generic index.html shell — it would
// never see real per-event content or meta tags.
//
// vercel.json rewrites requests to /event/:id-:slug whose User-Agent looks
// like a known bot to THIS route instead of index.html (real users/
// Googlebot are unaffected — they still get the normal SPA). This returns
// fully-formed static HTML: no JS required to see the real title,
// description, Open Graph/Twitter tags, JSON-LD, and a plain-text summary
// of the event. This is the same "dynamic rendering" pattern Google
// documented as a standard interim solution for JS-heavy sites, and is far
// lower-risk than a full SSR framework migration on a live site.
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

router.get('/event/:pathParam', async (req, res) => {
  try {
    const match = /^(\d+)/.exec(req.params.pathParam || '');
    if (!match) return res.status(400).send('Invalid event id');
    const id = match[1];

    const event = await getMergedEventById(id);
    if (!event) {
      res.status(404).set('Content-Type', 'text/html').send('<!doctype html><html><head><title>Event not found — ConcertAndMatches.com</title></head><body><p>This event could not be found. It may have been removed.</p></body></html>');
      return;
    }

    const title = `${event.title} Tickets — ${formatDate(event.date)} | ConcertAndMatches.com`;
    const description = `Compare ticket prices for ${event.title}${event.venue_name ? ` at ${event.venue_name}` : ''}${event.city ? ` in ${event.city}` : ''} on ${formatDate(event.date)}. See offers from multiple authorized sellers.`;
    const slug = slugify(`${event.title || event.artist_name || 'event'}-${event.city || ''}`);
    const url = `https://www.concertandmatches.com/event/${event.id}-${slug}`;

    const offers = Array.isArray(event.offers) ? event.offers : [];
    const offersForLd = offers
      .filter((o) => o.min_price != null)
      .map((o) => ({
        '@type': 'Offer',
        price: Number(o.min_price).toFixed(2),
        priceCurrency: o.currency || 'USD',
        availability: 'https://schema.org/InStock',
        url,
      }));

    const jsonLd = {
      '@context': 'https://schema.org',
      '@type': 'Event',
      name: event.title,
      startDate: event.date,
      eventStatus: 'https://schema.org/EventScheduled',
      ...(event.image_url ? { image: [event.image_url] } : {}),
      location: {
        '@type': 'Place',
        name: event.venue_name || undefined,
        address: {
          '@type': 'PostalAddress',
          addressLocality: event.city || undefined,
          addressRegion: event.state || undefined,
          addressCountry: event.country === 'Canada' ? 'CA' : 'US',
        },
      },
      ...(event.artist_name ? { performer: { '@type': 'PerformingGroup', name: event.artist_name } } : {}),
      ...(offersForLd.length > 0 ? { offers: offersForLd } : {}),
    };

    const offersHtml = offers.length > 0
      ? `<ul>${offers.map((o) => `<li>${xmlEscape(o.source)}${o.min_price != null ? `: from $${Number(o.min_price).toFixed(0)}` : ''}</li>`).join('')}</ul>`
      : '<p>No confirmed ticket seller yet — check back soon.</p>';

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
${event.image_url ? `<meta property="og:image" content="${xmlEscape(event.image_url)}" />` : ''}
<meta name="twitter:card" content="${event.image_url ? 'summary_large_image' : 'summary'}" />
<meta name="twitter:title" content="${xmlEscape(title)}" />
<meta name="twitter:description" content="${xmlEscape(description)}" />
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
</head>
<body>
<h1>${xmlEscape(event.title)}</h1>
${event.artist_name ? `<p>${xmlEscape(event.artist_name)}</p>` : ''}
<p>Date: ${xmlEscape(formatDate(event.date))}</p>
<p>Location: ${xmlEscape(event.venue_name || '')}${event.city ? `, ${xmlEscape(event.city)}` : ''}${event.state ? `, ${xmlEscape(event.state)}` : ''}</p>
<h2>Ticket Sellers</h2>
${offersHtml}
<p><a href="${xmlEscape(url)}">View live prices and buy tickets on ConcertAndMatches.com</a></p>
</body>
</html>`;

    res.set('Content-Type', 'text/html');
    res.send(html);
  } catch (error) {
    console.error('Prerender failed:', error);
    res.status(500).send('Failed to render event page');
  }
});

export default router;
