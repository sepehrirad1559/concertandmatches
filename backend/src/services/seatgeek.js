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

    const minPrice = stats?.lowest_price ?? 0;
    const maxPrice = stats?.highest_price ?? (minPrice || 0);

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
  storeEvent,
  syncSeatGeekEvents,
  scheduleSeatGeekSync,
};
