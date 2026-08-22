import axios from 'axios';
import { pool } from '../index.js';

// StubHub's "Application-Only" OAuth flow — gets an access token for public
// data (events, listings, prices) without needing a logged-in StubHub user.
// Requires STUBHUB_CLIENT_ID / STUBHUB_CLIENT_SECRET, issued once StubHub
// approves API/partner access (there's no public self-serve signup as of
// this writing — see developer.stubhub.com and contact StubHub directly).
//
// STATUS: unverified skeleton. StubHub's public docs don't give full
// request/response schemas for the Catalog/Inventory endpoints, so the
// field names and endpoint paths below are best-effort from the docs
// structure, not confirmed against a real account. Expect to debug this
// against actual API responses the same way the Ticketmaster/SeatGeek
// integrations needed a real false-positive fix after going live — do not
// treat this as production-ready until it's been run against a real
// StubHub sandbox/account and its output checked.
const STUBHUB_CLIENT_ID = process.env.STUBHUB_CLIENT_ID;
const STUBHUB_CLIENT_SECRET = process.env.STUBHUB_CLIENT_SECRET;
const STUBHUB_AUTH_URL = 'https://account.stubhub.com/oauth2/access_token'; // placeholder — confirm exact host in real docs once you have partner access
const STUBHUB_API_BASE = 'https://api.stubhub.com'; // placeholder — confirm exact host

let cachedToken = null;
let cachedTokenExpiresAt = 0;

// Fetch (and cache) an Application-Only access token.
async function getAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiresAt - 60_000) {
    return cachedToken;
  }

  const basicAuth = Buffer.from(`${STUBHUB_CLIENT_ID}:${STUBHUB_CLIENT_SECRET}`).toString('base64');
  const response = await axios.post(
    STUBHUB_AUTH_URL,
    'grant_type=client_credentials&scope=PRODUCTION',
    {
      headers: {
        Authorization: `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );

  cachedToken = response.data.access_token;
  cachedTokenExpiresAt = Date.now() + (response.data.expires_in || 3600) * 1000;
  return cachedToken;
}

// Fetch a page of concert events from StubHub's Catalog search.
export const fetchStubHubEvents = async (page = 0, perPage = 100) => {
  try {
    const token = await getAccessToken();
    const response = await axios.get(`${STUBHUB_API_BASE}/catalog/events/v3`, {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        categoryId: 'CONCERT', // placeholder — confirm real category taxonomy
        rows: perPage,
        start: page * perPage,
        sort: 'eventDateLocal asc',
      },
    });

    return response.data?.events || response.data?.numFound ? response.data.events : [];
  } catch (error) {
    console.error('StubHub API error:', error.response?.data || error.message);
    return [];
  }
};

// Fetch multiple pages up to a total event count. Mirrors
// fetchManySeatGeekEvents in seatgeek.js.
export const fetchManyStubHubEvents = async (totalWanted = 300) => {
  const perPage = 100;
  const pages = Math.ceil(totalWanted / perPage);
  const events = [];

  for (let page = 0; page < pages; page++) {
    console.log(`📍 Fetching StubHub page ${page + 1}...`);
    const pageEvents = await fetchStubHubEvents(page, perPage);
    if (pageEvents.length === 0) break;
    events.push(...pageEvents);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.log(`✅ Total StubHub events fetched: ${events.length}`);
  return events;
};

// Process and store a StubHub event in the shared events table.
// external_id is prefixed "sh-" — same convention as SeatGeek's "sg-" — so
// it can never collide with another source's IDs in the same column.
export const storeEvent = async (shEvent) => {
  try {
    // NOTE: field paths below are best-effort guesses at StubHub's Catalog
    // response shape and need to be confirmed/corrected against a real
    // response before this is trusted.
    const id = shEvent.id;
    const title = shEvent.name;
    const venue = shEvent.venue || {};
    const externalId = `sh-${id}`;
    const date = new Date(shEvent.eventDateLocal || shEvent.eventDateUTC);
    const image = shEvent.imageUrl || null;
    const sourceUrl = shEvent.webURI || shEvent.url || null;
    const artistName = shEvent.performers?.[0]?.name || null;

    const venueName = venue.name || 'Unknown Venue';
    const city = venue.city || 'Unknown';
    const state = venue.state || 'Unknown';
    const country = venue.country === 'CA' ? 'Canada' : 'USA';
    const latitude = venue.latitude ?? null;
    const longitude = venue.longitude ?? null;

    // StubHub's listing/price summary — confirm exact field name
    // (minListingPrice / ticketInfo / listingPriceRange, etc).
    const minPrice = shEvent.minListingPrice?.amount ?? null;
    const maxPrice = shEvent.maxListingPrice?.amount ?? minPrice;

    const existingEvent = await pool.query('SELECT id FROM events WHERE external_id = $1', [externalId]);

    if (existingEvent.rows.length > 0) {
      await pool.query(
        `UPDATE events SET
         min_price = $1, max_price = $2, latitude = $3, longitude = $4, updated_at = NOW()
         WHERE external_id = $5`,
        [minPrice, maxPrice, latitude, longitude, externalId]
      );
      return existingEvent.rows[0].id;
    }

    const result = await pool.query(
      `INSERT INTO events (
        external_id, title, description, category, date, country, state, city,
        venue_name, venue_address, image_url, source, source_url, min_price, max_price, artist_name,
        latitude, longitude
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
      RETURNING id`,
      [externalId, title, '', 'Concert', date, country, state, city,
       venueName, venue.address1 || '', image, 'stubhub', sourceUrl, minPrice, maxPrice, artistName,
       latitude, longitude]
    );
    return result.rows[0].id;
  } catch (error) {
    console.error('Error storing StubHub event:', error);
    return null;
  }
};

// Sync StubHub concert events into the events table. Same shape as
// syncSeatGeekEvents / syncAllEvents so it plugs into admin.js the same way.
export const syncStubHubEvents = async (totalWanted = 300) => {
  try {
    console.log('🔄 Starting StubHub sync...');

    if (!STUBHUB_CLIENT_ID || !STUBHUB_CLIENT_SECRET) {
      console.error('STUBHUB_CLIENT_ID/STUBHUB_CLIENT_SECRET not set — skipping StubHub sync.');
      return { success: false, error: 'STUBHUB_CLIENT_ID/STUBHUB_CLIENT_SECRET not configured' };
    }

    const events = await fetchManyStubHubEvents(totalWanted);
    console.log(`Processing ${events.length} StubHub events...`);

    for (const event of events) {
      await storeEvent(event);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    console.log('✅ StubHub sync complete!');
    return { success: true, totalEvents: events.length };
  } catch (error) {
    console.error('StubHub sync failed:', error);
    return { success: false, error: error.message };
  }
};

export default {
  fetchStubHubEvents,
  fetchManyStubHubEvents,
  storeEvent,
  syncStubHubEvents,
};
