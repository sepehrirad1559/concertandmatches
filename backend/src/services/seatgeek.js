import axios from 'axios';
import { pool } from '../index.js';
import { US_STATES } from './ticketmaster.js';

const SEATGEEK_CLIENT_ID = process.env.SEATGEEK_CLIENT_ID;
const SEATGEEK_BASE_URL = 'https://api.seatgeek.com/2';

// A handful of Canadian provinces, for the same reason Ticketmaster's sync
// covers Canada separately (spec: discover events across the US AND
// Canada). Confirmed against SeatGeek's own docs that `venue.state` is a
// real filter (https://seatgeek.github.io/), but unlike the US state list
// above (reused from Ticketmaster's own working code) this hasn't been
// verified against real Canadian SeatGeek listings — if a code is wrong or
// SeatGeek simply has no venues there, that state/province just contributes
// 0 events, same as any other empty page. Not a failure mode worth guarding
// against further.
const CANADIAN_PROVINCES = ['ON', 'BC', 'QC', 'AB', 'MB', 'SK', 'NS', 'NB'];

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

// Fetch events for one US state or Canadian province via SeatGeek's
// documented `venue.state` filter (https://seatgeek.github.io/) — the same
// per-region approach Ticketmaster's fetchAllUSEvents/fetchAllCanadianEvents
// already use via market codes. Segmenting by region (instead of just
// pulling more of a globally-sorted feed) means SeatGeek's coverage
// actually spreads across the country the way Ticketmaster's does, rather
// than clustering wherever the next few days happen to have the most
// events — which is what was silently capping cross-source overlap before.
export const fetchSeatGeekEventsByState = async (stateCode, perState = 100) => {
  try {
    const response = await axios.get(`${SEATGEEK_BASE_URL}/events`, {
      params: {
        client_id: SEATGEEK_CLIENT_ID,
        'taxonomies.name': 'concert',
        'venue.state': stateCode,
        per_page: perState,
        sort: 'datetime_local.asc',
      },
    });
    return response.data?.events || [];
  } catch (error) {
    console.error(`SeatGeek API error (venue.state=${stateCode}):`, error.response?.data || error.message);
    return [];
  }
};

// Loops the same US state list Ticketmaster's sync uses, plus a handful of
// Canadian provinces, pulling up to `perState` events from each. This is
// now the primary strategy syncSeatGeekEvents uses (see below) — it
// directly targets the same geographic footprint Ticketmaster covers,
// rather than relying on a single global feed and hoping enough volume
// happens to land in the same places.
export const fetchSeatGeekEventsByRegion = async (perState = 100) => {
  const events = [];
  const regions = [...US_STATES, ...CANADIAN_PROVINCES];

  for (const stateCode of regions) {
    console.log(`📍 Fetching SeatGeek events for ${stateCode}...`);
    const stateEvents = await fetchSeatGeekEventsByState(stateCode, perState);
    events.push(...stateEvents);
    // Politeness delay between requests, same rationale as the existing
    // page-based fetch below.
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.log(`✅ Total SeatGeek events fetched across ${regions.length} regions: ${events.length}`);
  return events;
};

// Fetch multiple pages up to a total event count. Kept as a fallback/simpler
// path (e.g. for callers that don't need regional segmentation) — the
// primary sync now uses fetchSeatGeekEventsByRegion above instead, since a
// low total here (originally 300) meant SeatGeek's coverage was a tiny,
// essentially random slice of the calendar next to Ticketmaster's ~2,800-
// event spread across 28 US/Canada markets, and even raising the total
// alone doesn't fix the lack of geographic spread — see that function's
// comment for the full story on why region-based fetching is the better fix.
export const fetchManySeatGeekEvents = async (totalWanted = 3000) => {
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

    // Data-quality guard (spec §32): an event with no valid date is useless
    // for a comparison site — skip it rather than storing a broken row.
    if (Number.isNaN(date.getTime())) {
      console.warn(`Skipping SeatGeek event ${id} — missing/invalid date`);
      return null;
    }

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
    // Data-quality guard (spec §32): a negative price is never valid —
    // treat it as unknown (null) rather than storing/displaying it.
    const rawMinPrice = stats?.lowest_price != null ? stats.lowest_price : null;
    const rawMaxPrice = stats?.highest_price != null ? stats.highest_price : (rawMinPrice != null ? rawMinPrice : null);
    const minPrice = rawMinPrice != null && rawMinPrice >= 0 ? rawMinPrice : null;
    const maxPrice = rawMaxPrice != null && rawMaxPrice >= 0 ? rawMaxPrice : null;

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

// Sync SeatGeek concert events into the events table. Now region-segmented
// (see fetchSeatGeekEventsByRegion above) rather than one global
// soonest-first feed — perState=100 mirrors Ticketmaster's own per-market
// fetch size, so the two sources cover comparable geographic ground instead
// of SeatGeek's data clustering whichever days happen to be busiest.
export const syncSeatGeekEvents = async (perState = 100) => {
  try {
    console.log('🔄 Starting SeatGeek sync...');

    if (!SEATGEEK_CLIENT_ID) {
      console.error('SEATGEEK_CLIENT_ID is not set — skipping SeatGeek sync.');
      return { success: false, error: 'SEATGEEK_CLIENT_ID not configured' };
    }

    const events = await fetchSeatGeekEventsByRegion(perState);
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
