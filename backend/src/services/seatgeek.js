import axios from 'axios';
import { pool } from '../index.js';

const SEATGEEK_CLIENT_ID = process.env.SEATGEEK_CLIENT_ID;
const SEATGEEK_BASE_URL = 'https://api.seatgeek.com/2';

// Fetch a page of concert events from SeatGeek's Platform API.
// Docs: https://platform.seatgeek.com/
export const fetchSeatGeekEvents = async (page = 1, perPage = 100) => {
  try {
    const response = await axios.get(`${SEATGEEK_BASE_URL}/events`, {
      params: {
        client_id: SEATGEEK_CLIENT_ID,
        'taxonomies.name': 'concert',
        per_page: perPage,
        page,
        sort: 'datetime_local.asc',
      },
    });

    return response.data?.events || [];
  } catch (error) {
    console.error('SeatGeek API error:', error.response?.data || error.message);
    return [];
  }
};

// Fetch multiple pages up to a total event count.
export const fetchManySeatGeekEvents = async (totalWanted = 300) => {
  const perPage = 100;
  const pages = Math.ceil(totalWanted / perPage);
  const events = [];

  for (let page = 1; page <= pages; page++) {
    console.log(`📍 Fetching SeatGeek page ${page}...`);
    const pageEvents = await fetchSeatGeekEvents(page, perPage);
    if (pageEvents.length === 0) break;
    events.push(...pageEvents);
    // Rate limiting - be polite between requests
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.log(`✅ Total SeatGeek events fetched: ${events.length}`);
  return events;
};

// Process and store a SeatGeek event in the shared events table.
// external_id is prefixed with "sg-" so it can never collide with
// Ticketmaster's numeric/alphanumeric external IDs in the same column.
export const storeEvent = async (sgEvent) => {
  try {
    const { id, title, datetime_local, venue, performers, url, stats } = sgEvent;

    const externalId = `sg-${id}`;
    const eventTitle = title || performers?.[0]?.name || 'Untitled Event';
    const category = 'Concert';
    const date = new Date(datetime_local);
    const image = performers?.[0]?.image || null;
    const sourceUrl = url;
    const artistName = performers?.[0]?.name || null;

    const venueName = venue?.name || 'Unknown Venue';
    const city = venue?.city || 'Unknown';
    const state = venue?.state || 'Unknown';
    const country = venue?.country === 'CA' ? 'Canada' : 'USA';

    // Venue coordinates, used to sort events by distance from the customer.
    // SeatGeek returns these as numbers already, nested under venue.location.
    const latitude = venue?.location?.lat ?? null;
    const longitude = venue?.location?.lon ?? null;

    // SeatGeek's free Platform API tier doesn't reliably return listing
    // price stats (often an empty {} object) — leave pricing null rather
    // than defaulting to a fake $0, which would otherwise look like a real
    // (and very wrong) price on the event page.
    const minPrice = stats?.lowest_price != null ? stats.lowest_price : null;
    const maxPrice = stats?.highest_price != null ? stats.highest_price : (minPrice != null ? minPrice : null);

    const existingEvent = await pool.query(
      'SELECT id FROM events WHERE external_id = $1',
      [externalId]
    );

    if (existingEvent.rows.length > 0) {
      await pool.query(
        `UPDATE events SET
         min_price = $1, max_price = $2, latitude = $3, longitude = $4, updated_at = NOW()
         WHERE external_id = $5`,
        [minPrice, maxPrice, latitude, longitude, externalId]
      );
      return existingEvent.rows[0].id;
    } else {
      const result = await pool.query(
        `INSERT INTO events (
          external_id, title, description, category, date, country, state, city,
          venue_name, venue_address, image_url, source, source_url, min_price, max_price, artist_name,
          latitude, longitude
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
        RETURNING id`,
        [externalId, eventTitle, '', category, date, country, state, city,
         venueName, venue?.address || '', image, 'seatgeek', sourceUrl, minPrice, maxPrice, artistName,
         latitude, longitude]
      );
      return result.rows[0].id;
    }
  } catch (error) {
    console.error('Error storing SeatGeek event:', error);
    return null;
  }
};

// Fetch a single event by SeatGeek's own id (not our prefixed "sg-<id>").
// Used for price backfill rather than the bulk sync, which pages through
// the /events search endpoint.
export const fetchSeatGeekEventById = async (seatgeekId) => {
  try {
    const response = await axios.get(`${SEATGEEK_BASE_URL}/events/${seatgeekId}`, {
      params: { client_id: SEATGEEK_CLIENT_ID },
    });
    return response.data || null;
  } catch (error) {
    console.error('SeatGeek event detail error:', error.response?.data || error.message);
    return null;
  }
};

// Backfill pricing for SeatGeek events stored with no price. SeatGeek's
// free Platform API tier often returns an empty `stats` object on the bulk
// /events listing even when the same event's own detail endpoint reports
// real numbers (e.g. once listings actually appear closer to the event
// date) — this re-checks each event individually and updates it if pricing
// is now available. Note: for some events this genuinely never fills in
// on the free tier; that's a data-source limitation, not a bug here.
export const backfillMissingPrices = async (limit = 100) => {
  try {
    if (!SEATGEEK_CLIENT_ID) {
      return { success: false, error: 'SEATGEEK_CLIENT_ID not configured' };
    }

    const { rows } = await pool.query(
      `SELECT id, external_id FROM events
       WHERE source = 'seatgeek' AND min_price IS NULL
       ORDER BY date ASC
       LIMIT $1`,
      [limit]
    );

    let updated = 0;
    for (const row of rows) {
      const seatgeekId = row.external_id.replace(/^sg-/, '');
      const detail = await fetchSeatGeekEventById(seatgeekId);
      const stats = detail?.stats;
      const minPrice = stats?.lowest_price != null ? stats.lowest_price : null;
      const maxPrice = stats?.highest_price != null ? stats.highest_price : minPrice;

      if (minPrice != null) {
        await pool.query(
          `UPDATE events SET min_price = $1, max_price = $2, updated_at = NOW() WHERE id = $3`,
          [minPrice, maxPrice, row.id]
        );
        updated++;
      }

      // Rate limiting — one detail call per event, be polite to the API.
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    return { success: true, checked: rows.length, updated };
  } catch (error) {
    console.error('SeatGeek price backfill failed:', error);
    return { success: false, error: error.message };
  }
};

// Sync SeatGeek concert events into the events table.
export const syncSeatGeekEvents = async (totalWanted = 300) => {
  try {
    console.log('🔄 Starting SeatGeek sync...');

    if (!SEATGEEK_CLIENT_ID) {
      console.error('SEATGEEK_CLIENT_ID is not set — skipping SeatGeek sync.');
      return { success: false, error: 'SEATGEEK_CLIENT_ID not configured' };
    }

    const events = await fetchManySeatGeekEvents(totalWanted);
    console.log(`Processing ${events.length} SeatGeek events...`);

    for (const event of events) {
      await storeEvent(event);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    console.log('✅ SeatGeek sync complete!');
    return { success: true, totalEvents: events.length };
  } catch (error) {
    console.error('SeatGeek sync failed:', error);
    return { success: false, error: error.message };
  }
};

// Run automatically every 24 hours, same cadence as the Ticketmaster sync.
export const scheduleSeatGeekSync = (intervalMs = 24 * 60 * 60 * 1000) => {
  console.log('⏰ Scheduling automatic SeatGeek sync every 24 hours');

  setInterval(() => {
    console.log('🔄 Running scheduled SeatGeek sync...');
    syncSeatGeekEvents();
  }, intervalMs);
};

export default {
  fetchSeatGeekEvents,
  fetchManySeatGeekEvents,
  fetchSeatGeekEventById,
  storeEvent,
  syncSeatGeekEvents,
  backfillMissingPrices,
  scheduleSeatGeekSync,
};
