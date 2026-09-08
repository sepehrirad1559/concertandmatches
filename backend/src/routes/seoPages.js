import express from 'express';
import {
  discoverArtists, getArtistPage,
  discoverCities, getCityPage,
  discoverVenues, getVenuePage,
  LEAGUE_DEFS, getLeaguePage,
  discoverTeams, getTeamPage,
  slugify as citySlugify,
} from '../services/seoEngine.js';

const router = express.Router();

// Server-rendered programmatic SEO pages — same pattern as routes/guides.js
// (raw HTML, not the React SPA): dynamic title/meta/canonical/OG/Twitter/
// JSON-LD, real inventory only, graceful 404 instead of a thin empty page.
// Every entity here comes from seoEngine.js, which scores/tiers candidates
// against real `events` table + `click_events` signals — see that file's
// header comment for the full honest-data-source disclosure. Pages whose
// tier is 'do-not-index' never reach this file at all (discover* functions
// already filter them out), so there's no keyword-to-inventory mismatch by
// construction.

const SITE_ORIGIN = 'https://www.concertandmatches.com';

function xmlEscape(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(dateStr) {
  if (!dateStr) return 'Date TBA';
  try {
    return new Date(dateStr).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  } catch {
    return String(dateStr);
  }
}

function slugifyForEvent(event) {
  return String(event.title || event.artist_name || 'event')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'event';
}

function notFoundPage(label) {
  return `<!doctype html><html><head><title>Page not found — ConcertAndMatches.com</title><meta name="robots" content="noindex"></head><body><p>${xmlEscape(label)} We don't have a live page for that right now.</p><p><a href="/">Back to ConcertAndMatches.com</a></p></body></html>`;
}

// Renders the shared event-list table used by every detail page below —
// same columns/format as guides.js so the pattern stays consistent site-wide.
function eventRows(events) {
  return events.map((e) => {
    const eventUrl = `${SITE_ORIGIN}/event/${e.id}-${xmlEscape(slugifyForEvent(e))}`;
    const priced = e.offers.filter((o) => o.min_price != null).sort((a, b) => Number(a.min_price) - Number(b.min_price));
    const offerList = priced.map((o) => `${xmlEscape(o.source)}: $${Number(o.min_price).toFixed(0)}`).join(' · ');
    return `<tr>
      <td>${xmlEscape(formatDate(e.date))}</td>
      <td>${xmlEscape(e.title || e.artist_name || '')}</td>
      <td>${xmlEscape(e.venue_name || '')}</td>
      <td>${xmlEscape(e.city || '')}${e.state ? `, ${xmlEscape(e.state)}` : ''}</td>
      <td>${offerList || 'Price TBA'}</td>
      <td><a href="${eventUrl}">Details →</a></td>
    </tr>`;
  }).join('');
}

function cheapestPrice(events) {
  const priced = events.filter((e) => e.best_price != null);
  if (priced.length === 0) return null;
  return priced.reduce((a, b) => (Number(a.best_price) <= Number(b.best_price) ? a : b)).best_price;
}

// Renders real Google Autocomplete completions (see
// backend/data/search-patterns.json — a dated, hand-pulled snapshot, not a
// live call and not AI-generated) for the small subset of entities this
// snapshot covers. Omitted entirely when there's no confirmed data for this
// page — never backfilled with invented phrases, since the whole point is
// that every phrase shown here is something a real searcher actually typed.
function confirmedSearchesSection(confirmedSearches) {
  if (!confirmedSearches || confirmedSearches.length === 0) return '';
  const items = confirmedSearches.slice(0, 8).map((s) => `<li>${xmlEscape(s)}</li>`).join('');
  return `<h2>How people search for this</h2>
<p>Real search phrases people use (from Google's own autocomplete data):</p>
<ul>${items}</ul>`;
}

function pageShell({ title, description, url, h1, intro, bodyHtml, jsonLd, breadcrumbHtml }) {
  return `<!doctype html>
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
<meta property="og:image" content="${SITE_ORIGIN}/og-image.png" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${xmlEscape(title)}" />
<meta name="twitter:description" content="${xmlEscape(description)}" />
<meta name="twitter:image" content="${SITE_ORIGIN}/og-image.png" />
${jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>` : ''}
</head>
<body>
${breadcrumbHtml || ''}
<h1>${xmlEscape(h1)}</h1>
<p>${xmlEscape(intro)}</p>
${bodyHtml}
<p><a href="/">Back to ConcertAndMatches.com</a></p>
</body>
</html>`;
}

function breadcrumb(items) {
  // items: [{label, href?}] — last item has no href (current page)
  const parts = items.map((it) => it.href ? `<a href="${xmlEscape(it.href)}">${xmlEscape(it.label)}</a>` : xmlEscape(it.label));
  return `<nav aria-label="breadcrumb"><p>${parts.join(' &raquo; ')}</p></nav>`;
}

// ---------------------------------------------------------------------
// Artists
// ---------------------------------------------------------------------

router.get('/artists', async (req, res) => {
  try {
    const artists = await discoverArtists({ limit: 1000 });
    const items = artists.map((a) => `<li><a href="/artists/${xmlEscape(a.slug)}">${xmlEscape(a.artistName)}</a> — ${a.eventCount} upcoming show${a.eventCount === 1 ? '' : 's'}${a.cityCount > 1 ? ` in ${a.cityCount} cities` : ''}</li>`).join('');
    const html = pageShell({
      title: 'Artists With Tickets Available | ConcertAndMatches.com',
      description: `Browse ${artists.length} artists with real, currently listed upcoming shows and ticket prices from multiple sellers.`,
      url: `${SITE_ORIGIN}/artists`,
      h1: 'Artists with tickets available',
      intro: `${artists.length} artists currently have upcoming shows listed with real ticket availability.`,
      bodyHtml: `<ul>${items}</ul>`,
    });
    res.set('Content-Type', 'text/html').send(html);
  } catch (error) {
    console.error('Artists index failed:', error);
    res.status(500).send('Failed to generate artists index');
  }
});

router.get('/artists/:slug', async (req, res) => {
  try {
    const page = await getArtistPage(req.params.slug);
    if (!page || page.events.length === 0) {
      res.status(404).set('Content-Type', 'text/html').send(notFoundPage('Artist not found.'));
      return;
    }
    const cheapest = cheapestPrice(page.events);
    const cityMap = new Map();
    for (const e of page.events) {
      if (!e.city) continue;
      const key = `${e.city}|${e.state || ''}`;
      if (!cityMap.has(key)) cityMap.set(key, { city: e.city, state: e.state });
    }
    const cityList = [...cityMap.values()];
    const title = `${page.artistName} Tickets — Upcoming Shows & Prices | ConcertAndMatches.com`;
    const cityNames = cityList.map((c) => c.city);
    const description = cheapest != null
      ? `${page.events.length} upcoming ${page.artistName} show${page.events.length === 1 ? '' : 's'}${cityNames.length ? ` in ${cityNames.slice(0, 3).join(', ')}${cityNames.length > 3 ? ' and more' : ''}` : ''}. Compare prices across sellers, starting from $${Number(cheapest).toFixed(0)}.`
      : `${page.events.length} upcoming ${page.artistName} show${page.events.length === 1 ? '' : 's'}. See dates, venues, and ticket availability.`;
    const url = `${SITE_ORIGIN}/artists/${xmlEscape(req.params.slug)}`;
    const jsonLd = { '@context': 'https://schema.org', '@type': 'CollectionPage', name: title, description, url };
    const cityLinks = cityList.slice(0, 12).map((c) => `<li><a href="/cities/${xmlEscape(citySlugify(`${c.city}-${c.state || ''}`))}/concerts">${xmlEscape(c.city)}${c.state ? `, ${xmlEscape(c.state)}` : ''}</a></li>`).join('');
    const html = pageShell({
      title, description, url,
      h1: `${page.artistName} tickets`,
      intro: description,
      breadcrumbHtml: breadcrumb([{ label: 'Artists', href: '/artists' }, { label: page.artistName }]),
      bodyHtml: `<table><thead><tr><th>Date</th><th>Show</th><th>Venue</th><th>City</th><th>Prices by seller</th><th></th></tr></thead><tbody>${eventRows(page.events)}</tbody></table>
      ${cityLinks ? `<h2>Cities on this tour</h2><ul>${cityLinks}</ul>` : ''}
      ${confirmedSearchesSection(page.confirmedSearches)}
      <p>Prices update as sellers change theirs — confirm the final price on the seller's site before buying.</p>`,
      jsonLd,
    });
    res.set('Content-Type', 'text/html').send(html);
  } catch (error) {
    console.error('Artist page failed:', error);
    res.status(500).send('Failed to generate artist page');
  }
});

// ---------------------------------------------------------------------
// Cities
// ---------------------------------------------------------------------

const CITY_VARIANT_LABEL = { events: 'Events', concerts: 'Concerts', sports: 'Sports Events' };

router.get('/cities', async (req, res) => {
  try {
    const cities = await discoverCities({ limit: 1000 });
    const items = cities.map((c) => `<li><a href="/cities/${xmlEscape(c.slug)}/events">${xmlEscape(c.city)}${c.state ? `, ${xmlEscape(c.state)}` : ''}</a> — ${c.eventCount} upcoming event${c.eventCount === 1 ? '' : 's'}</li>`).join('');
    const html = pageShell({
      title: 'Events by City | ConcertAndMatches.com',
      description: `Browse upcoming concerts and sports events in ${cities.length} cities with real, currently listed ticket availability.`,
      url: `${SITE_ORIGIN}/cities`,
      h1: 'Events by city',
      intro: `${cities.length} cities currently have upcoming events listed.`,
      bodyHtml: `<ul>${items}</ul>`,
    });
    res.set('Content-Type', 'text/html').send(html);
  } catch (error) {
    console.error('Cities index failed:', error);
    res.status(500).send('Failed to generate cities index');
  }
});

async function renderCityVariant(req, res, variant) {
  try {
    const page = await getCityPage(req.params.slug, variant);
    if (!page || page.events.length === 0) {
      res.status(404).set('Content-Type', 'text/html').send(notFoundPage(`No ${variant} found for that city.`));
      return;
    }
    const cheapest = cheapestPrice(page.events);
    const label = CITY_VARIANT_LABEL[variant];
    const place = `${page.city}${page.state ? `, ${page.state}` : ''}`;
    const title = `${label} in ${place} — Tickets & Prices | ConcertAndMatches.com`;
    const description = cheapest != null
      ? `${page.events.length} upcoming ${variant === 'events' ? 'events' : variant} in ${place}. Compare prices across sellers, starting from $${Number(cheapest).toFixed(0)}.`
      : `${page.events.length} upcoming ${variant === 'events' ? 'events' : variant} in ${place}. See dates, venues, and ticket availability.`;
    const url = `${SITE_ORIGIN}/cities/${xmlEscape(req.params.slug)}/${variant}`;
    const jsonLd = { '@context': 'https://schema.org', '@type': 'CollectionPage', name: title, description, url };
    const otherVariants = CITY_VARIANTS_LIST.filter((v) => v !== variant)
      .map((v) => `<a href="/cities/${xmlEscape(req.params.slug)}/${v}">${CITY_VARIANT_LABEL[v]} in ${xmlEscape(page.city)}</a>`)
      .join(' · ');
    const html = pageShell({
      title, description, url,
      h1: `${label} in ${place}`,
      intro: description,
      breadcrumbHtml: breadcrumb([{ label: 'Cities', href: '/cities' }, { label: place }]),
      bodyHtml: `<table><thead><tr><th>Date</th><th>Event</th><th>Venue</th><th>City</th><th>Prices by seller</th><th></th></tr></thead><tbody>${eventRows(page.events)}</tbody></table>
      ${otherVariants ? `<p>${otherVariants}</p>` : ''}
      ${confirmedSearchesSection(page.confirmedSearches)}
      <p>Prices update as sellers change theirs — confirm the final price on the seller's site before buying.</p>`,
      jsonLd,
    });
    res.set('Content-Type', 'text/html').send(html);
  } catch (error) {
    console.error(`City ${variant} page failed:`, error);
    res.status(500).send(`Failed to generate city ${variant} page`);
  }
}

const CITY_VARIANTS_LIST = ['events', 'concerts', 'sports'];
router.get('/cities/:slug/events', (req, res) => renderCityVariant(req, res, 'events'));
router.get('/cities/:slug/concerts', (req, res) => renderCityVariant(req, res, 'concerts'));
router.get('/cities/:slug/sports', (req, res) => renderCityVariant(req, res, 'sports'));

// ---------------------------------------------------------------------
// Venues
// ---------------------------------------------------------------------

router.get('/venues', async (req, res) => {
  try {
    const venues = await discoverVenues({ limit: 1000 });
    const items = venues.map((v) => `<li><a href="/venues/${xmlEscape(v.slug)}">${xmlEscape(v.venueName)}</a> — ${xmlEscape(v.city || '')}${v.state ? `, ${xmlEscape(v.state)}` : ''} (${v.eventCount} upcoming)</li>`).join('');
    const html = pageShell({
      title: 'Venues With Upcoming Events | ConcertAndMatches.com',
      description: `Browse ${venues.length} venues with real, currently listed upcoming events and ticket availability.`,
      url: `${SITE_ORIGIN}/venues`,
      h1: 'Venues with upcoming events',
      intro: `${venues.length} venues currently have upcoming events listed.`,
      bodyHtml: `<ul>${items}</ul>`,
    });
    res.set('Content-Type', 'text/html').send(html);
  } catch (error) {
    console.error('Venues index failed:', error);
    res.status(500).send('Failed to generate venues index');
  }
});

router.get('/venues/:slug', async (req, res) => {
  try {
    const page = await getVenuePage(req.params.slug);
    if (!page || page.events.length === 0) {
      res.status(404).set('Content-Type', 'text/html').send(notFoundPage('Venue not found.'));
      return;
    }
    const cheapest = cheapestPrice(page.events);
    const place = `${page.city}${page.state ? `, ${page.state}` : ''}`;
    const title = `${page.venueName} Tickets & Events (${place}) | ConcertAndMatches.com`;
    const description = cheapest != null
      ? `${page.events.length} upcoming event${page.events.length === 1 ? '' : 's'} at ${page.venueName} in ${place}. Compare prices, starting from $${Number(cheapest).toFixed(0)}.`
      : `${page.events.length} upcoming event${page.events.length === 1 ? '' : 's'} at ${page.venueName} in ${place}. See dates and ticket availability.`;
    const url = `${SITE_ORIGIN}/venues/${xmlEscape(req.params.slug)}`;
    const jsonLd = { '@context': 'https://schema.org', '@type': 'CollectionPage', name: title, description, url };
    const html = pageShell({
      title, description, url,
      h1: `${page.venueName} — ${place}`,
      intro: description,
      breadcrumbHtml: breadcrumb([{ label: 'Venues', href: '/venues' }, { label: page.venueName }]),
      bodyHtml: `<table><thead><tr><th>Date</th><th>Event</th><th>Venue</th><th>City</th><th>Prices by seller</th><th></th></tr></thead><tbody>${eventRows(page.events)}</tbody></table>
      <p><a href="/cities/${xmlEscape(citySlugify(`${page.city || ''}-${page.state || ''}`))}/events">More events in ${xmlEscape(page.city || '')}</a></p>
      <p>Prices update as sellers change theirs — confirm the final price on the seller's site before buying.</p>`,
      jsonLd,
    });
    res.set('Content-Type', 'text/html').send(html);
  } catch (error) {
    console.error('Venue page failed:', error);
    res.status(500).send('Failed to generate venue page');
  }
});

// ---------------------------------------------------------------------
// Leagues / top-level categories
// ---------------------------------------------------------------------

router.get('/leagues', async (req, res) => {
  const items = Object.entries(LEAGUE_DEFS).map(([slug, def]) => `<li><a href="/leagues/${xmlEscape(slug)}">${xmlEscape(def.label)}</a></li>`).join('');
  const html = pageShell({
    title: 'Leagues & Categories | ConcertAndMatches.com',
    description: 'Browse tickets by league or category: NFL, NBA, NCAA Football, concerts, theater, and comedy.',
    url: `${SITE_ORIGIN}/leagues`,
    h1: 'Browse by league or category',
    intro: 'Pick a league or category to see all currently listed upcoming events.',
    bodyHtml: `<ul>${items}</ul>`,
  });
  res.set('Content-Type', 'text/html').send(html);
});

router.get('/leagues/:slug', async (req, res) => {
  try {
    const page = await getLeaguePage(req.params.slug);
    if (!page || page.events.length === 0) {
      res.status(404).set('Content-Type', 'text/html').send(notFoundPage('League or category not found.'));
      return;
    }
    const cheapest = cheapestPrice(page.events);
    const title = `${page.label} Tickets — Upcoming Games & Events | ConcertAndMatches.com`;
    const description = cheapest != null
      ? `${page.eventCount} upcoming ${page.label} event${page.eventCount === 1 ? '' : 's'}. Compare prices across sellers, starting from $${Number(cheapest).toFixed(0)}.`
      : `${page.eventCount} upcoming ${page.label} event${page.eventCount === 1 ? '' : 's'}. See dates, venues, and ticket availability.`;
    const url = `${SITE_ORIGIN}/leagues/${xmlEscape(req.params.slug)}`;
    const jsonLd = { '@context': 'https://schema.org', '@type': 'CollectionPage', name: title, description, url };
    const leagueCityMap = new Map();
    for (const e of page.events) {
      if (!e.city) continue;
      const key = `${e.city}|${e.state || ''}`;
      if (!leagueCityMap.has(key)) leagueCityMap.set(key, { city: e.city, state: e.state });
    }
    const cityLinks = [...leagueCityMap.values()].slice(0, 12)
      .map((c) => `<li><a href="/cities/${xmlEscape(citySlugify(`${c.city}-${c.state || ''}`))}/events">${xmlEscape(c.city)}${c.state ? `, ${xmlEscape(c.state)}` : ''}</a></li>`).join('');
    const html = pageShell({
      title, description, url,
      h1: `${page.label} tickets`,
      intro: description,
      breadcrumbHtml: breadcrumb([{ label: 'Leagues', href: '/leagues' }, { label: page.label }]),
      bodyHtml: `<table><thead><tr><th>Date</th><th>Event</th><th>Venue</th><th>City</th><th>Prices by seller</th><th></th></tr></thead><tbody>${eventRows(page.events.slice(0, 300))}</tbody></table>
      ${cityLinks ? `<h2>Cities with ${xmlEscape(page.label)} events</h2><ul>${cityLinks}</ul>` : ''}
      ${confirmedSearchesSection(page.confirmedSearches)}
      <p>Prices update as sellers change theirs — confirm the final price on the seller's site before buying.</p>`,
      jsonLd,
    });
    res.set('Content-Type', 'text/html').send(html);
  } catch (error) {
    console.error('League page failed:', error);
    res.status(500).send('Failed to generate league page');
  }
});

// ---------------------------------------------------------------------
// Teams (best-effort, see seoEngine.js discoverTeams for the heuristic)
// ---------------------------------------------------------------------

router.get('/teams', async (req, res) => {
  try {
    const teams = await discoverTeams({ limit: 1000 });
    const items = teams.map((t) => `<li><a href="/teams/${xmlEscape(t.slug)}">${xmlEscape(t.name)}</a> — ${t.eventCount} upcoming game${t.eventCount === 1 ? '' : 's'}</li>`).join('');
    const html = pageShell({
      title: 'Teams With Upcoming Games | ConcertAndMatches.com',
      description: `Browse ${teams.length} teams with real, currently listed upcoming games and ticket availability.`,
      url: `${SITE_ORIGIN}/teams`,
      h1: 'Teams with upcoming games',
      intro: `${teams.length} teams currently have upcoming games listed. Team names are extracted from matchup listings and may occasionally be imprecise.`,
      bodyHtml: `<ul>${items}</ul>`,
    });
    res.set('Content-Type', 'text/html').send(html);
  } catch (error) {
    console.error('Teams index failed:', error);
    res.status(500).send('Failed to generate teams index');
  }
});

router.get('/teams/:slug', async (req, res) => {
  try {
    const page = await getTeamPage(req.params.slug);
    if (!page || page.events.length === 0) {
      res.status(404).set('Content-Type', 'text/html').send(notFoundPage('Team not found.'));
      return;
    }
    const cheapest = cheapestPrice(page.events);
    const title = `${page.name} Tickets — Upcoming Games & Prices | ConcertAndMatches.com`;
    const description = cheapest != null
      ? `${page.events.length} upcoming ${page.name} game${page.events.length === 1 ? '' : 's'}. Compare prices across sellers, starting from $${Number(cheapest).toFixed(0)}.`
      : `${page.events.length} upcoming ${page.name} game${page.events.length === 1 ? '' : 's'}. See dates, venues, and ticket availability.`;
    const url = `${SITE_ORIGIN}/teams/${xmlEscape(req.params.slug)}`;
    const jsonLd = { '@context': 'https://schema.org', '@type': 'CollectionPage', name: title, description, url };
    const html = pageShell({
      title, description, url,
      h1: `${page.name} tickets`,
      intro: description,
      breadcrumbHtml: breadcrumb([{ label: 'Teams', href: '/teams' }, { label: page.name }]),
      bodyHtml: `<table><thead><tr><th>Date</th><th>Matchup</th><th>Venue</th><th>City</th><th>Prices by seller</th><th></th></tr></thead><tbody>${eventRows(page.events)}</tbody></table>
      <p>Team names on this page are extracted from matchup listings (e.g. "Team A at Team B") and may occasionally be imprecise.</p>
      ${confirmedSearchesSection(page.confirmedSearches)}
      <p>Prices update as sellers change theirs — confirm the final price on the seller's site before buying.</p>`,
      jsonLd,
    });
    res.set('Content-Type', 'text/html').send(html);
  } catch (error) {
    console.error('Team page failed:', error);
    res.status(500).send('Failed to generate team page');
  }
});

export default router;
