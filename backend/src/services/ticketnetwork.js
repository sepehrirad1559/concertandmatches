import axios from 'axios';
import { pool } from '../index.js';
import { normalizeState } from '../utils/states.js';

// TicketNetwork's real ticket inventory, accessed through the Impact.com
// affiliate Partner API — NOT the Mercury Web Services (MWS) integration
// backend/src/providers/TicketNetworkProvider.js used to assume was
// required (that file was an inert scaffold pending an MWS application we
// never got approved). Found instead: TicketNetwork's Impact.com affiliate
// program (already approved for this account) exposes a real, live,
// auto-updating product catalog — catalog id 1872, "Ticketnetwork Product
// Catalog API" — with ~210k real event listings including venue, date and
// price, reachable via Impact's documented Partner REST API
// (https://integrations.impact.com/agency-v3/readme/authentication).
//
// Auth: HTTP Basic, base64(AccountSID:AuthToken), same pattern verified
// live against https://api.impact.com/Mediapartners/{sid}/Campaigns before
// this was built. Credentials come from env vars, never hardcoded.
const IMPACT_BASE_URL = 'https://api.impact.com';
const TICKETNETWORK_CATALOG_ID = '1872';

function getAuthHeader() {
  const sid = process.env.TICKETNETWORK_ACCOUNT_SID;
  const token = process.env.TICKETNETWORK_AUTH_TOKEN;
  if (!sid || !token) return null;
  return {
    sid,
    header: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
  };
}

// Same purpose as ticketmaster.js/seatgeek.js's trackApiError — lets a sync
// report whether requests were actually failing instead of a bare
// "totalEvents: 0" with no context.
let recentApiErrors = [];
function trackApiError(where, error) {
  recentApiErrors.push({
    where,
    status: error.response?.status ?? null,
    message: error.response?.data ? JSON.stringify(error.response.data).slice(0, 300) : error.message,
  });
}

// Impact's product-catalog schema is generic (built for retail catalogs,
// not tickets), so TicketNetwork's feed repurposes several retail fields to
// carry event data. Confirmed by direct inspection via GET
// /admin/diagnostics/providers against real, live catalog items — not
// guessed from docs, which don't document this mapping at all:
//   Name              -> event/show name
//   Labels[0]          -> venue name
//   Manufacturer       -> venue street address
//   LaunchDate         -> event date/time (ISO, with offset)
//   Gtin               -> city
//   Mpn                -> state/region
//   Asin               -> country
//   Category           -> event type ("CONCERTS" / "THEATRE" / "SPORTS")
//   Url                -> full Impact.com tracked affiliate link (ready to
//                          use as-is — no additional wrapping needed, unlike
//                          Ticketmaster's trackedTicketmasterLink)
//   ImageUrl            -> seating-chart map image (not a hero/artist photo)
//   Text1               -> "$min- $max" price range as a string; both real
//                          numbers and "$0.00- $0.00" (verified: unpriced,
//                          not a real $0 ticket)
const CATEGORY_LABELS = {
  CONCERTS: 'Concert',
  THEATRE: 'Theater',
  SPORTS: 'Sports',
};

function categoryFromRaw(raw) {
  if (!raw) return 'Event';
  return CATEGORY_LABELS[String(raw).toUpperCase()] || raw;
}

function countryFromRaw(raw) {
  const v = (raw || '').toLowerCase();
  if (v.includes('united states')) return 'USA';
  if (v.includes('canada')) return 'Canada';
  return raw || 'USA';
}

// Parses TicketNetwork's "$138.00- $1348.95" / "$0.00- $0.00" Text1 field.
// Data-quality guard (same policy as ticketmaster.js/seatgeek.js): a $0.00
// pair means "no pricing at the source yet", not a real free ticket, and a
// negative or unparseable value is treated as unknown (null) rather than
// stored/displayed.
function parsePriceRange(text1) {
  if (!text1 || typeof text1 !== 'string') return { minPrice: null, maxPrice: null };
  const match = text1.match(/\$\s*([\d,]+(?:\.\d+)?)\s*-\s*\$\s*([\d,]+(?:\.\d+)?)/);
  if (!match) return { minPrice: null, maxPrice: null };
  const min = parseFloat(match[1].replace(/,/g, ''));
  const max = parseFloat(match[2].replace(/,/g, ''));
  if (!Number.isFinite(min) || !Number.isFinite(max) || (min <= 0 && max <= 0)) {
    return { minPrice: null, maxPrice: null };
  }
  return {
    minPrice: min >= 0 ? min : null,
    maxPrice: max >= 0 ? max : (min >= 0 ? min : null),
  };
}

// Fetches one page of the TicketNetwork catalog. Pass `nextPageUri` (the
// relative `@nextpageuri` from a previous response) to continue pagination
// instead of guessing Impact's page-number query param — this is the same
// approach Impact's own response shape is designed around, and it's
// self-correcting if Impact ever changes/caps PageSize server-side (we just
// read back whatever @pagesize it actually applied).
export async function fetchTicketNetworkPage({ pageSize = 1000, nextPageUri = null } = {}) {
  const auth = getAuthHeader();
  if (!auth) {
    return { data: null, errorInfo: 'TICKETNETWORK_ACCOUNT_SID/TICKETNETWORK_AUTH_TOKEN not configured' };
  }
  const url = nextPageUri
    ? `${IMPACT_BASE_URL}${nextPageUri}`
    : `${IMPACT_BASE_URL}/Mediapartners/${auth.sid}/Catalogs/${TICKETNETWORK_CATALOG_ID}/Items`;
  const params = nextPageUri ? undefined : { PageSize: pageSize };

  try {
    const response = await axios.get(url, {
      params,
      headers: { Authorization: auth.header, Accept: 'application/json' },
      timeout: 30000,
    });
    return { data: response.data, errorInfo: null };
  } catch (error) {
    const status = error.response?.status;
    const errorInfo = status
      ? `HTTP ${status}: ${JSON.stringify(error.response?.data).slice(0, 300)}`
      : error.message;
    trackApiError('fetchTicketNetworkPage', error);
    return { data: null, errorInfo };
  }
}

// Store a single TicketNetwork catalog item in the shared events table.
// external_id is prefixed "tn-" so it can never collide with Ticketmaster's
// or SeatGeek's ids in the same column (same convention as "sg-" in
// services/seatgeek.js).
export const storeEvent = async (item) => {
  try {
    const externalId = `tn-${item.Id || item.CatalogItemId}`;
    const title = item.Name || 'Untitled Event';
    const venueName = item.Labels?.[0] || 'Unknown Venue';
    const venueAddress = item.Manufacturer || '';
    const city = item.Gtin || 'Unknown';
    // Normalized to a two-letter code at ingestion so newly-synced rows
    // already match Ticketmaster/SeatGeek's format directly — the bucket-key
    // functions also normalize defensively (see utils/states.js) so this
    // isn't required for matching to work, but keeping the stored value
    // consistent avoids the same confusion resurfacing elsewhere (e.g. any
    // future feature that reads `state` without going through those
    // helpers).
    const state = item.Mpn ? (normalizeState(item.Mpn).toUpperCase() || item.Mpn) : 'Unknown';
    const country = countryFromRaw(item.Asin);
    const category = categoryFromRaw(item.Category);
    const imageUrl = item.ImageUrl || null;
    const sourceUrl = item.Url || null;
    const date = new Date(item.LaunchDate);

    // Data-quality guard (same policy as ticketmaster.js/seatgeek.js): an
    // event with no valid date, or with no usable outbound link, is useless
    // on a comparison site — skip rather than store a broken row.
    if (Number.isNaN(date.getTime())) {
      console.warn(`Skipping TicketNetwork item ${externalId} — missing/invalid LaunchDate`);
      return null;
    }
    if (!sourceUrl) {
      console.warn(`Skipping TicketNetwork item ${externalId} — no Url`);
      return null;
    }

    const { minPrice, maxPrice } = parsePriceRange(item.Text1);

    const existingEvent = await pool.query(
      'SELECT id FROM events WHERE external_id = $1',
      [externalId]
    );

    if (existingEvent.rows.length > 0) {
      // Same COALESCE pattern fixed into ticketmaster.js/seatgeek.js this
      // session (commit 0ade28c0) — applied here from the start rather than
      // repeating that bug: only overwrite price when THIS sync actually
      // has a value for it, so a re-sync that (rarely) comes back without
      // Text1 pricing can't silently wipe out a price a previous sync found.
      await pool.query(
        `UPDATE events SET
         title = $1, category = $2, date = $3, country = $4, state = $5, city = $6,
         venue_name = $7, venue_address = $8, image_url = $9, source_url = $10,
         min_price = COALESCE($11, min_price), max_price = COALESCE($12, max_price),
         updated_at = NOW()
         WHERE external_id = $13`,
        [title, category, date, country, state, city, venueName, venueAddress,
         imageUrl, sourceUrl, minPrice, maxPrice, externalId]
      );
      return existingEvent.rows[0].id;
    } else {
      const result = await pool.query(
        `INSERT INTO events (
          external_id, title, description, category, date, country, state, city,
          venue_name, venue_address, image_url, source, source_url, min_price, max_price
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        RETURNING id`,
        [externalId, title, '', category, date, country, state, city,
         venueName, venueAddress, imageUrl, 'ticketnetwork', sourceUrl, minPrice, maxPrice]
      );
      return result.rows[0].id;
    }
  } catch (error) {
    console.error('Error storing TicketNetwork event:', error);
    return null;
  }
};

// Pages through the ENTIRE TicketNetwork catalog (~210k items as of
// 2026-09-11) and stores every item as an event. `maxPages` is an optional
// safety cap for a partial/test run (e.g. from an admin query param); left
// unset, it pages until Impact reports no further @nextpageuri.
//
// No latitude/longitude: the catalog gives city/state/country only, not
// coordinates — unlike Ticketmaster/SeatGeek, which return venue lat/lng
// directly. routes/events.js already handles NULL latitude/longitude
// gracefully (falls back to date-sort, no distance shown — see its
// `hasCoords` / `CASE WHEN latitude IS NULL...` handling), so this ships
// without geocoding rather than blocking on it; geocoding ~a few thousand
// unique city/state venues (not all 210k rows) would be a reasonable
// follow-up if distance-sorting TicketNetwork events specifically turns out
// to matter.
export const syncTicketNetworkEvents = async ({ maxPages = null, pageSize = 1000 } = {}) => {
  recentApiErrors = [];
  const auth = getAuthHeader();
  if (!auth) {
    return { success: false, error: 'TICKETNETWORK_ACCOUNT_SID/TICKETNETWORK_AUTH_TOKEN not configured' };
  }

  let nextPageUri = null;
  let pagesFetched = 0;
  let totalStored = 0;
  let totalSeen = 0;
  let apiTotal = null;

  console.log('🎟️ Starting TicketNetwork (Impact.com catalog) sync...');

  while (true) {
    const { data, errorInfo } = await fetchTicketNetworkPage({ pageSize, nextPageUri });
    if (errorInfo) {
      console.error('TicketNetwork API error:', errorInfo);
      // Stop rather than loop forever on a persistent error, but report
      // whatever was already stored rather than discarding it.
      return {
        success: pagesFetched > 0,
        error: pagesFetched === 0 ? errorInfo : null,
        pagesFetched,
        totalSeen,
        totalStored,
        apiErrorCount: recentApiErrors.length,
        sampleApiErrors: recentApiErrors.slice(0, 5),
      };
    }

    pagesFetched++;
    if (apiTotal === null) apiTotal = data?.['@total'] ?? null;
    const items = data?.Items || [];
    totalSeen += items.length;

    for (const item of items) {
      const id = await storeEvent(item);
      if (id) totalStored++;
    }

    console.log(`📄 TicketNetwork page ${pagesFetched}${data?.['@numpages'] ? `/${data['@numpages']}` : ''} — ${items.length} items, ${totalStored}/${totalSeen} stored so far`);

    nextPageUri = data?.['@nextpageuri'] || null;
    if (!nextPageUri || items.length === 0) break;
    if (maxPages && pagesFetched >= maxPages) {
      console.log(`⏸️ TicketNetwork sync stopped early — reached maxPages=${maxPages} (partial run)`);
      break;
    }

    // Politeness delay between pages, matching the other providers' pattern.
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  console.log(`✅ TicketNetwork sync complete! ${totalStored}/${totalSeen} events stored across ${pagesFetched} pages (catalog total reported: ${apiTotal ?? 'unknown'}).`);

  return {
    success: true,
    pagesFetched,
    totalSeen,
    totalStored,
    totalEvents: totalStored,
    catalogTotal: apiTotal,
    apiErrorCount: recentApiErrors.length,
    sampleApiErrors: recentApiErrors.length > 0 ? recentApiErrors.slice(0, 5) : undefined,
  };
};

// Run automatically every 24 hours, same cadence as the other two syncs.
// The catalog's own DateLastUpdated (confirmed ~daily during investigation)
// makes a daily re-sync the right cadence here too.
export const scheduleTicketNetworkSync = (intervalMs = 24 * 60 * 60 * 1000) => {
  console.log('⏰ Scheduling automatic TicketNetwork sync every 24 hours');
  setInterval(() => {
    console.log('🔄 Running scheduled TicketNetwork sync...');
    syncTicketNetworkEvents();
  }, intervalMs);
};

export default {
  fetchTicketNetworkPage,
  storeEvent,
  syncTicketNetworkEvents,
  scheduleTicketNetworkSync,
};
