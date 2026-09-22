import { pool } from '../index.js';

// Resolves approximate (city-center, not per-venue) coordinates for a
// city/state so TicketNetwork events — which the Impact.com catalog gives
// no latitude/longitude for at all (see ticketnetwork.js) — can still be
// distance-sorted and show a "X mi away" badge like Ticketmaster/SeatGeek
// events do.
//
// This started as an intentional gap (see the old comment in
// ticketnetwork.js: "ships without geocoding... reasonable follow-up if
// distance-sorting TicketNetwork events specifically turns out to matter").
// It turned into a real bug once Ticketmaster/SeatGeek were hidden via
// ACTIVE_SOURCES (2026-09-20): with TicketNetwork left as almost the only
// visible source, and routes/events.js's distance-primary sort putting
// NULL-coordinate rows last (`distance_km ASC NULLS LAST`), the entire
// "Popular Events Near You" section and similar distance-sorted views were
// effectively only showing the handful of TicketNetwork events that
// happened to share an external_id/venue with a previously-synced
// Ticketmaster/SeatGeek row — burying near-term, in-stock events at smaller
// venues (confirmed for Madison, WI: High Noon Saloon, The Bur Oak, Orpheum
// Theatre - Madison, Adams Friendship Fine Arts Center all had no
// coordinates at all).
//
// Two-tier cache, in that order:
//   1. Any coordinates already stored on ANY event (any source) for the
//      same city/state — free, no network call, and naturally covers every
//      city Ticketmaster/SeatGeek already geocoded for us.
//   2. An in-memory cache for this process's lifetime, so a sync run only
//      ever geocodes each unique city/state once even though storeEvent is
//      called once per catalog item (~210k calls, a few thousand unique
//      cities).
// Only a genuine cache miss on both falls through to an actual network
// request, rate-limited to respect Nominatim's (OpenStreetMap's free,
// keyless geocoder) usage policy of roughly 1 request/second.
const memoryCache = new Map(); // "city|state" -> {lat,lng} | null
let dbCachePrimed = false;

function cacheKey(city, state) {
  return `${(city || '').trim().toLowerCase()}|${(state || '').trim().toLowerCase()}`;
}

async function primeFromDb() {
  if (dbCachePrimed) return;
  dbCachePrimed = true;
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (city, state) city, state, latitude, longitude
       FROM events
       WHERE latitude IS NOT NULL AND longitude IS NOT NULL
         AND city IS NOT NULL AND city != '' AND city != 'Unknown'`
    );
    for (const row of rows) {
      memoryCache.set(cacheKey(row.city, row.state), {
        lat: Number(row.latitude),
        lng: Number(row.longitude),
      });
    }
    console.log(`geocode: primed ${memoryCache.size} city/state coordinate(s) from existing events`);
  } catch (err) {
    console.error('geocode: failed to prime cache from DB:', err.message);
  }
}

let lastRequestAt = 0;
async function throttle() {
  const wait = Math.max(0, 1100 - (Date.now() - lastRequestAt));
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();
}

// Returns { lat, lng } or null (unresolvable — e.g. bad/foreign city data;
// callers should treat null exactly like "no coordinates available", the
// same as before this module existed).
export async function geocodeCityState(city, state, country = 'USA') {
  if (!city || city === 'Unknown') return null;
  await primeFromDb();

  const key = cacheKey(city, state);
  if (memoryCache.has(key)) return memoryCache.get(key);

  try {
    await throttle();
    const params = new URLSearchParams({
      format: 'json',
      limit: '1',
      city,
      country: country === 'Canada' ? 'Canada' : 'United States',
    });
    if (state && state !== 'Unknown') params.set('state', state);

    const res = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
      headers: {
        // Nominatim's usage policy requires an identifying User-Agent.
        'User-Agent': 'ConcertAndMatches/1.0 (service@concertandmatches.com)',
      },
    });
    if (!res.ok) {
      memoryCache.set(key, null);
      return null;
    }
    const data = await res.json();
    const hit = Array.isArray(data) ? data[0] : null;
    const lat = hit ? parseFloat(hit.lat) : NaN;
    const lng = hit ? parseFloat(hit.lon) : NaN;
    const coords = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
    memoryCache.set(key, coords);
    return coords;
  } catch (err) {
    memoryCache.set(key, null);
    return null;
  }
}
