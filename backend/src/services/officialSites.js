import axios from 'axios';
import crypto from 'crypto';
import { pool } from '../index.js';

// Pulls event listings from official sites the user has explicitly added
// (festival, event-organizer, venue, artist, and band websites) — spec
// item: "Obtain offers/prices/URLs/availability... from Official concert
// websites". Unlike Ticketmaster/SeatGeek, there's no single API for
// "official websites" as a category, and scraping arbitrary sites risks
// violating their Terms of Service. So this reads schema.org/JSON-LD
// `Event` structured data instead — the machine-readable markup many
// event/venue/artist sites publish specifically so search engines and
// aggregators (Google's own Rich Results, etc.) can read it. A site that
// doesn't publish this markup simply yields zero events; this deliberately
// does NOT parse arbitrary HTML/DOM content as a fallback.

const JSON_LD_SCRIPT_RE = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

// schema.org event types worth keeping. Matches by substring so
// "MusicEvent", "TheaterEvent", "Festival", "ScreeningEvent", etc. all
// qualify without listing every subtype.
function isEventType(type) {
  if (!type) return false;
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => typeof t === 'string' && /event|festival/i.test(t));
}

// Walks a parsed JSON-LD document (which may be a single object, an array,
// or a @graph wrapper) and collects every node that looks like an Event.
function collectEventNodes(node, out) {
  if (!node) return;
  if (Array.isArray(node)) {
    node.forEach((n) => collectEventNodes(n, out));
    return;
  }
  if (typeof node !== 'object') return;
  if (isEventType(node['@type'])) out.push(node);
  if (Array.isArray(node['@graph'])) collectEventNodes(node['@graph'], out);
}

// Extracts every schema.org Event object embedded in a page's JSON-LD
// <script> blocks. Malformed JSON in one block doesn't abort the others.
export function extractJsonLdEvents(html) {
  const events = [];
  let match;
  JSON_LD_SCRIPT_RE.lastIndex = 0;
  while ((match = JSON_LD_SCRIPT_RE.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      collectEventNodes(parsed, events);
    } catch {
      // Not valid JSON (or not JSON-LD we care about) — skip this block.
    }
  }
  return events;
}

function firstOffer(offers) {
  if (!offers) return null;
  return Array.isArray(offers) ? offers[0] : offers;
}

// Maps a schema.org Event object to the same shape ticketmaster.js/
// seatgeek.js produce, so it can go through the identical storage path.
export function normalizeJsonLdEvent(raw, sourceUrl, category) {
  const title = raw.name || null;
  const startDate = raw.startDate ? new Date(raw.startDate) : null;
  if (!title || !startDate || Number.isNaN(startDate.getTime())) return null;

  const location = raw.location || {};
  const address = location.address || {};
  const venueName = location.name || 'Unknown Venue';
  const city = (typeof address === 'object' ? address.addressLocality : null) || 'Unknown';
  const state = (typeof address === 'object' ? address.addressRegion : null) || 'Unknown';
  const countryRaw = (typeof address === 'object' ? address.addressCountry : null);
  // `typeof null === 'object'` in JS, so a naive typeof check treats an
  // explicit `addressCountry: null` (seen in the wild, e.g. EDC Las Vegas'
  // JSON-LD) as an object and crashes reading `.name` off it. Guard against
  // null explicitly rather than relying on typeof alone.
  const countryCode = countryRaw && typeof countryRaw === 'object' ? countryRaw.name : countryRaw;
  const country = countryCode && /^CA$|canada/i.test(countryCode) ? 'Canada' : 'USA';

  const geo = location.geo || {};
  const latitude = geo.latitude != null ? Number(geo.latitude) : null;
  const longitude = geo.longitude != null ? Number(geo.longitude) : null;

  const offer = firstOffer(raw.offers);
  const rawPrice = offer?.price != null ? parseFloat(offer.price) : (offer?.lowPrice != null ? parseFloat(offer.lowPrice) : null);
  const rawMaxPrice = offer?.highPrice != null ? parseFloat(offer.highPrice) : rawPrice;
  const minPrice = rawPrice != null && rawPrice >= 0 ? rawPrice : null;
  const maxPrice = rawMaxPrice != null && rawMaxPrice >= 0 ? rawMaxPrice : minPrice;

  const performer = Array.isArray(raw.performer) ? raw.performer[0] : raw.performer;
  const artistName = performer?.name || null;

  const eventUrl = raw.url || sourceUrl;
  const image = Array.isArray(raw.image) ? raw.image[0] : raw.image;

  // Stable id derived from the event's own URL when it has one (best case —
  // matches the source's own permalink), else a hash of title+date+venue so
  // re-syncing the same page updates the same row instead of duplicating it.
  const idBasis = raw.url || `${title}|${startDate.toISOString()}|${venueName}`;
  const externalId = `official-${crypto.createHash('sha1').update(idBasis).digest('hex').slice(0, 16)}`;

  return {
    externalId,
    title,
    description: raw.description || '',
    category: category || 'Other',
    date: startDate,
    country,
    state,
    city,
    venueName,
    venueAddress: (typeof address === 'object' ? address.streetAddress : null) || '',
    image: image || null,
    sourceUrl: eventUrl,
    minPrice,
    maxPrice,
    artistName,
    latitude,
    longitude,
  };
}

// Upsert path — mirrors ticketmaster.js/seatgeek.js's storeEvent exactly
// (same events table, same UPDATE-in-place-on-existing-external_id logic),
// so official-site events participate in search, sorting, and canonicalize
// identically to Ticketmaster/SeatGeek events.
export async function storeOfficialEvent(ev) {
  try {
    const existing = await pool.query('SELECT id FROM events WHERE external_id = $1', [ev.externalId]);

    if (existing.rows.length > 0) {
      await pool.query(
        `UPDATE events SET
         min_price = $1, max_price = $2, latitude = $3, longitude = $4, updated_at = NOW()
         WHERE external_id = $5`,
        [ev.minPrice, ev.maxPrice, ev.latitude, ev.longitude, ev.externalId]
      );
      return { id: existing.rows[0].id, created: false };
    }

    const result = await pool.query(
      `INSERT INTO events (
        external_id, title, description, category, date, country, state, city,
        venue_name, venue_address, image_url, source, source_url, min_price, max_price, artist_name,
        latitude, longitude
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
      RETURNING id`,
      [ev.externalId, ev.title, ev.description, ev.category, ev.date, ev.country, ev.state, ev.city,
       ev.venueName, ev.venueAddress, ev.image, 'official', ev.sourceUrl, ev.minPrice, ev.maxPrice, ev.artistName,
       ev.latitude, ev.longitude]
    );
    return { id: result.rows[0].id, created: true };
  } catch (error) {
    console.error('Error storing official-site event:', error);
    return null;
  }
}

// Fetches one configured source's page and stores whatever Events it finds.
async function syncOneSource(source) {
  try {
    const response = await axios.get(source.url, {
      timeout: 15000,
      headers: { 'User-Agent': 'ConcertAndMatchesBot/1.0 (+https://www.concertandmatches.com)' },
    });
    const rawEvents = extractJsonLdEvents(response.data);
    const normalized = rawEvents
      .map((raw) => normalizeJsonLdEvent(raw, source.url, source.category))
      .filter(Boolean);

    let stored = 0;
    for (const ev of normalized) {
      const result = await storeOfficialEvent(ev);
      if (result) stored += 1;
    }

    return { url: source.url, found: rawEvents.length, stored, error: null };
  } catch (error) {
    return { url: source.url, found: 0, stored: 0, error: error.message };
  }
}

// Syncs every given source sequentially (politeness — these are third-party
// sites, not a bulk API meant for concurrent hammering) and reports a
// per-site breakdown alongside the totals.
export async function syncOfficialSites(sources) {
  const results = [];
  for (const source of sources) {
    const result = await syncOneSource(source);
    results.push(result);
    // Record when/whether each source was reached, so a broken or
    // no-longer-published source is visible in the admin view rather than
    // silently failing forever.
    await pool.query(
      `UPDATE official_sources SET last_synced_at = NOW(), last_status = $1, last_error = $2 WHERE id = $3`,
      [result.error ? 'error' : 'success', result.error, source.id]
    ).catch(() => {}); // best-effort — don't fail the whole sync over a status write
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const totalFound = results.reduce((sum, r) => sum + r.found, 0);
  const totalStored = results.reduce((sum, r) => sum + r.stored, 0);
  const errors = results.filter((r) => r.error).length;

  return {
    success: true,
    sitesProcessed: results.length,
    totalEventsFound: totalFound,
    totalEventsStored: totalStored,
    sitesWithErrors: errors,
    results,
  };
}
