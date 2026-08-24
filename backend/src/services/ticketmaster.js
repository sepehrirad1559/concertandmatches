import axios from 'axios';
import { pool } from '../index.js';

const TICKETMASTER_API_KEY = process.env.TICKETMASTER_API_KEY;
const TICKETMASTER_BASE_URL = 'https://app.ticketmaster.com/discovery/v2';

// Map of countries and their market codes
const MARKET_CODES = {
  'USA': [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25],
  'Canada': [26, 27, 28]
};

// US States mapping — exported so other providers (e.g. seatgeek.js's
// state-segmented sync) can cover the exact same geographic footprint
// without maintaining a second, potentially-drifting copy of this list.
export const US_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY'
];

// Fetch events from Ticketmaster
export const fetchTicketmasterEvents = async (marketCode = '1', limit = 50) => {
  try {
    const response = await axios.get(`${TICKETMASTER_BASE_URL}/events.json`, {
      params: {
        apikey: TICKETMASTER_API_KEY,
        marketId: marketCode,
        size: limit,
        sort: 'date,asc'
      }
    });

    if (!response.data._embedded || !response.data._embedded.events) {
      return [];
    }

    return response.data._embedded.events;
  } catch (error) {
    console.error('Ticketmaster API error:', error.message);
    return [];
  }
};

// Fetch events for all US states
export const fetchAllUSEvents = async () => {
  try {
    console.log('🌐 Fetching events from Ticketmaster for all US states...');
    
    const events = [];
    
    // Fetch from multiple markets
    for (let marketId = 1; marketId <= 25; marketId++) {
      console.log(`📍 Fetching market ${marketId}...`);
      const marketEvents = await fetchTicketmasterEvents(marketId, 100);
      events.push(...marketEvents);
      
      // Rate limiting - wait 500ms between requests
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.log(`✅ Total events fetched: ${events.length}`);
    return events;
  } catch (error) {
    console.error('Error fetching all US events:', error);
    return [];
  }
};

// Fetch events for Canada
export const fetchAllCanadianEvents = async () => {
  try {
    console.log('🍁 Fetching events from Ticketmaster for Canada...');

    const events = [];

    for (let marketId = 26; marketId <= 28; marketId++) {
      console.log(`📍 Fetching Canadian market ${marketId}...`);
      const marketEvents = await fetchTicketmasterEvents(marketId, 100);
      events.push(...marketEvents);

      await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.log(`✅ Total Canadian events fetched: ${events.length}`);
    return events;
  } catch (error) {
    console.error('Error fetching Canadian events:', error);
    return [];
  }
};

// Fetch a page of events restricted to Ticketmaster's "Sports" classification
// for one market. The generic per-market fetch above (fetchTicketmasterEvents)
// is capped at `size` results sorted by date and mixes every segment together
// (Music, Arts & Theatre, Sports, Film, ...) — since concerts vastly
// outnumber games in most markets, that cap meant NFL/NBA/NCAA Football
// events were getting crowded out and rarely synced even though Ticketmaster
// has them. Querying classificationName=Sports directly guarantees each
// market's sports slate is fetched on its own budget instead of competing
// with concerts for the same 100-result page.
export const fetchTicketmasterSportsEvents = async (marketCode = '1', limit = 200) => {
  try {
    const response = await axios.get(`${TICKETMASTER_BASE_URL}/events.json`, {
      params: {
        apikey: TICKETMASTER_API_KEY,
        marketId: marketCode,
        classificationName: 'Sports',
        size: limit,
        sort: 'date,asc'
      }
    });

    if (!response.data._embedded || !response.data._embedded.events) {
      return [];
    }

    return response.data._embedded.events;
  } catch (error) {
    console.error('Ticketmaster Sports API error:', error.message);
    return [];
  }
};

// Sports counterpart to fetchAllUSEvents/fetchAllCanadianEvents — same
// per-market loop, but against the dedicated Sports-classification fetch
// above so NFL/NBA/NCAA Football (and every other sport Ticketmaster
// tracks) get full, dedicated coverage across every US market.
export const fetchAllUSSportsEvents = async () => {
  try {
    console.log('🏈 Fetching Sports events from Ticketmaster for all US markets...');

    const events = [];

    for (let marketId = 1; marketId <= 25; marketId++) {
      console.log(`📍 Fetching Sports events for market ${marketId}...`);
      const marketEvents = await fetchTicketmasterSportsEvents(marketId, 200);
      events.push(...marketEvents);

      await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.log(`✅ Total US Sports events fetched: ${events.length}`);
    return events;
  } catch (error) {
    console.error('Error fetching all US Sports events:', error);
    return [];
  }
};

// Sports counterpart to fetchAllCanadianEvents.
export const fetchAllCanadianSportsEvents = async () => {
  try {
    console.log('🏈 Fetching Sports events from Ticketmaster for Canada...');

    const events = [];

    for (let marketId = 26; marketId <= 28; marketId++) {
      console.log(`📍 Fetching Canadian Sports events for market ${marketId}...`);
      const marketEvents = await fetchTicketmasterSportsEvents(marketId, 200);
      events.push(...marketEvents);

      await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.log(`✅ Total Canadian Sports events fetched: ${events.length}`);
    return events;
  } catch (error) {
    console.error('Error fetching Canadian Sports events:', error);
    return [];
  }
};

// Ticketmaster's `marketId` codes (1-28, used by every fetch above) only
// cover ~28 major metro DMAs. That's fine for concerts, which mostly happen
// in those same big-city arenas — but a large share of NCAA Football (and
// plenty of NBA/NFL preseason, and minor-league/college sports generally)
// is played in smaller college towns — Tuscaloosa, Clemson, Ann Arbor,
// College Station — that fall outside every one of those market codes.
// Those games were structurally invisible to the per-market fetch above no
// matter how the classification/size params were tuned, since the market
// filter itself excludes the venue before classification is even applied.
// This queries Ticketmaster by country (US/CA) instead of market, which has
// no such metro-only restriction, so a game in any town gets found.
//
// classificationName='Football'/'Basketball' (not 'Sports') so this stays
// scoped to the two sports actually asked for (NFL/NBA/NCAA Football),
// rather than pulling every sport nationwide — classificationName matches
// against the name at ANY level of Ticketmaster's segment/genre/subgenre
// hierarchy, so 'Football' catches both NFL and NCAA Football events, and
// 'Basketball' catches both NBA and NCAA Basketball; storeEvent's existing
// subGenre/genre-based category logic (see below) then splits them apart.
//
// Segmented by month (not one big query) because Ticketmaster's Discovery
// API caps deep paging at ~1,000 total results per query — a single
// nationwide, unbounded-date query for something as broad as "Basketball"
// could exceed that during peak season and silently truncate.
const NATIONWIDE_SPORTS_CLASSIFICATIONS = ['Football', 'Basketball'];
const NATIONWIDE_SPORTS_COUNTRIES = ['US', 'CA'];

async function fetchTicketmasterEventsByClassificationAndMonth(classificationName, countryCode, startDateTime, endDateTime) {
  try {
    const response = await axios.get(`${TICKETMASTER_BASE_URL}/events.json`, {
      params: {
        apikey: TICKETMASTER_API_KEY,
        classificationName,
        countryCode,
        startDateTime,
        endDateTime,
        size: 200,
        sort: 'date,asc',
      },
    });
    return response.data?._embedded?.events || [];
  } catch (error) {
    console.error(`Ticketmaster nationwide Sports API error (classificationName=${classificationName}, country=${countryCode}, month=${startDateTime.slice(0, 7)}):`, error.message);
    return [];
  }
}

// Formats a Date as the `YYYY-MM-DDTHH:mm:ssZ` shape Ticketmaster's
// startDateTime/endDateTime params require (no milliseconds).
function toTicketmasterDateTime(date) {
  return date.toISOString().split('.')[0] + 'Z';
}

// Nationwide counterpart to fetchAllUSSportsEvents/fetchAllCanadianSportsEvents
// — covers every town, not just the ~28 major markets those loop over (see
// comment above). monthsAhead defaults to 8, comfortably covering a full
// NFL/NCAA Football season (Aug-Jan) and most of an NBA season from
// whenever this runs.
export const fetchTicketmasterSportsEventsNationwide = async (monthsAhead = 8) => {
  const events = [];
  const now = new Date();

  for (const countryCode of NATIONWIDE_SPORTS_COUNTRIES) {
    for (const classificationName of NATIONWIDE_SPORTS_CLASSIFICATIONS) {
      for (let m = 0; m < monthsAhead; m++) {
        const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + m, 1, 0, 0, 0));
        const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + m + 1, 0, 23, 59, 59));
        const startDateTime = toTicketmasterDateTime(start);
        const endDateTime = toTicketmasterDateTime(end);
        console.log(`🏟️  Fetching nationwide ${classificationName} events (${countryCode}, ${startDateTime.slice(0, 7)})...`);
        const monthEvents = await fetchTicketmasterEventsByClassificationAndMonth(classificationName, countryCode, startDateTime, endDateTime);
        events.push(...monthEvents);
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
  }

  console.log(`✅ Total nationwide Sports events fetched: ${events.length}`);
  return events;
};

// Process and store Ticketmaster event in database
export const storeEvent = async (tmEvent) => {
  try {
    const {
      id,
      name,
      description,
      dates,
      classifications,
      images,
      url,
      _embedded,
      priceRanges
    } = tmEvent;

    // Extract data
    const title = name;
    // For Sports, prefer the most specific league/sport name Ticketmaster
    // gives us over the generic "Sports" segment name — subGenre is usually
    // the league itself ("NFL", "NBA", "NCAA Football"), genre the broader
    // sport ("Football", "Basketball") when no league-level subGenre is
    // present. Without this, every game synced under the Sports
    // classification would land in the catch-all "Sports" category instead
    // of being distinguishable as NFL/NBA/NCAA Football on the site.
    const segmentName = classifications?.[0]?.segment?.name;
    const genreName = classifications?.[0]?.genre?.name;
    const subGenreName = classifications?.[0]?.subGenre?.name;
    let category = segmentName || 'Other';
    if (segmentName === 'Sports') {
      if (subGenreName && !/^undefined$/i.test(subGenreName)) {
        category = subGenreName;
      } else if (genreName && !/^undefined$/i.test(genreName)) {
        category = genreName;
      }
    }
    const date = new Date(dates.start.dateTime);
    const image = images?.[0]?.url || null;
    const sourceUrl = url;

    // Basic data-quality guard (spec §32): an event with no valid date is
    // useless for a comparison site — it can't be shown, sorted, or matched
    // against — so skip it rather than storing a broken row.
    if (Number.isNaN(date.getTime())) {
      console.warn(`Skipping Ticketmaster event ${id} — missing/invalid date`);
      return null;
    }

    // Extract venue info
    const venue = _embedded?.venues?.[0];
    const venueName = venue?.name || 'Unknown Venue';
    const city = venue?.city?.name || 'Unknown';
    const state = venue?.state?.stateCode || 'Unknown';
    const country = venue?.country?.countryCode === 'CA' ? 'Canada' : 'USA';

    // Venue coordinates, used to sort events by distance from the customer.
    // Ticketmaster returns these as numeric strings, so coerce with Number().
    const rawLat = venue?.location?.latitude;
    const rawLng = venue?.location?.longitude;
    const latitude = rawLat !== undefined ? Number(rawLat) : null;
    const longitude = rawLng !== undefined ? Number(rawLng) : null;

    // Price range. Ticketmaster's priceRanges entries use `min`/`max` (not
    // `minPrice`/`maxPrice` — a field-name mismatch in earlier code meant
    // most events fell through to a fake $0-$500 placeholder instead of
    // their real price). When Ticketmaster doesn't report pricing at all,
    // leave these null rather than guessing a placeholder range.
    // Data-quality guard (spec §32): a negative price is never valid — treat
    // it as unknown (null) rather than storing/displaying a nonsense value.
    const rawMinPrice = priceRanges?.[0]?.min != null ? parseFloat(priceRanges[0].min) : null;
    const rawMaxPrice = priceRanges?.[0]?.max != null ? parseFloat(priceRanges[0].max) : null;
    const minPrice = rawMinPrice != null && rawMinPrice >= 0 ? rawMinPrice : null;
    const maxPrice = rawMaxPrice != null && rawMaxPrice >= 0 ? rawMaxPrice : null;

    // Full tier breakdown (e.g. Standard vs. VIP), so the event page can list
    // every available price sorted low to high instead of just one range.
    // Most events only report one tier, but some report several.
    const priceBreakdown = Array.isArray(priceRanges) && priceRanges.length > 0
      ? JSON.stringify(
          priceRanges
            .filter((pr) => pr.min != null || pr.max != null)
            .map((pr) => ({
              type: pr.type ? pr.type.charAt(0).toUpperCase() + pr.type.slice(1) : 'Standard',
              min: pr.min != null ? parseFloat(pr.min) : null,
              max: pr.max != null ? parseFloat(pr.max) : null,
              currency: pr.currency || 'USD',
            }))
        )
      : null;

    // Check if event already exists
    const existingEvent = await pool.query(
      'SELECT id FROM events WHERE external_id = $1',
      [id]
    );

    if (existingEvent.rows.length > 0) {
      // Update existing event
      await pool.query(
        `UPDATE events SET
         min_price = $1, max_price = $2, latitude = $3, longitude = $4, price_breakdown = $5, updated_at = NOW()
         WHERE external_id = $6`,
        [minPrice, maxPrice, latitude, longitude, priceBreakdown, id]
      );
      return existingEvent.rows[0].id;
    } else {
      // Insert new event
      const result = await pool.query(
        `INSERT INTO events (
          external_id, title, description, category, date, country, state, city,
          venue_name, venue_address, image_url, source, source_url, min_price, max_price,
          latitude, longitude, price_breakdown
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
        RETURNING id`,
        [id, title, description || '', category, date, country, state, city,
         venueName, venue?.address?.address1 || '', image, 'ticketmaster', sourceUrl, minPrice, maxPrice,
         latitude, longitude, priceBreakdown]
      );
      return result.rows[0].id;
    }
  } catch (error) {
    console.error('Error storing event:', error);
    return null;
  }
};

// Sync all Ticketmaster events
export const syncAllEvents = async () => {
  try {
    console.log('🔄 Starting Ticketmaster sync...');
    
    // Fetch US events
    const usEvents = await fetchAllUSEvents();
    console.log(`Processing ${usEvents.length} US events...`);
    
    for (const event of usEvents) {
      await storeEvent(event);
      // Rate limiting
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Fetch Canadian events
    const caEvents = await fetchAllCanadianEvents();
    console.log(`Processing ${caEvents.length} Canadian events...`);

    for (const event of caEvents) {
      await storeEvent(event);
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Dedicated Sports-classification pull (see fetchAllUSSportsEvents/
    // fetchAllCanadianSportsEvents above) — the generic per-market fetches
    // above are capped and dominated by concerts, so NFL/NBA/NCAA Football
    // events need their own fetch budget to get full coverage.
    console.log('🏈 Fetching Sports events from Ticketmaster...');
    const usSportsEvents = await fetchAllUSSportsEvents();
    const caSportsEvents = await fetchAllCanadianSportsEvents();
    const sportsEvents = [...usSportsEvents, ...caSportsEvents];
    console.log(`Processing ${sportsEvents.length} Sports events...`);

    for (const event of sportsEvents) {
      await storeEvent(event);
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Nationwide pull (see fetchTicketmasterSportsEventsNationwide above) —
    // the per-market fetch just above only reaches Ticketmaster's ~28 major
    // metro markets, which structurally excludes most college-town NCAA
    // Football venues regardless of classification/size tuning. This covers
    // every town by querying per-country instead of per-market.
    // storeEvent upserts on external_id, so any overlap with the per-market
    // fetch above just updates the same row rather than duplicating it.
    console.log('🏟️  Fetching nationwide Sports events from Ticketmaster...');
    const nationwideSportsEvents = await fetchTicketmasterSportsEventsNationwide();
    console.log(`Processing ${nationwideSportsEvents.length} nationwide Sports events...`);

    for (const event of nationwideSportsEvents) {
      await storeEvent(event);
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    console.log('✅ Sync complete!');
    return {
      success: true,
      totalEvents: usEvents.length + caEvents.length + sportsEvents.length + nationwideSportsEvents.length,
    };
  } catch (error) {
    console.error('Sync failed:', error);
    return { success: false, error: error.message };
  }
};

// Get event details from Ticketmaster. Returns { data, errorInfo } instead of
// throwing/nulling silently, so callers (specifically backfillMissingPrices)
// can report WHY a price wasn't found instead of just "it wasn't" — this was
// added after a backfill run came back "checked: 100, updated: 0" with no way
// to tell whether that meant "API calls are failing" or "these events truly
// have no price yet at the source".
export const getTicketmasterEventDetails = async (eventId) => {
  try {
    const response = await axios.get(`${TICKETMASTER_BASE_URL}/events/${eventId}`, {
      params: { apikey: TICKETMASTER_API_KEY }
    });

    return { data: response.data, errorInfo: null };
  } catch (error) {
    const status = error.response?.status;
    const body = error.response?.data;
    const errorInfo = status
      ? `HTTP ${status}: ${JSON.stringify(body).slice(0, 300)}`
      : error.message;
    console.error('Error fetching Ticketmaster event details:', errorInfo);
    return { data: null, errorInfo };
  }
};

// Backfill pricing for Ticketmaster events that were stored with no price
// (common: the bulk /events.json search Ticketmaster returns during sync
// often omits priceRanges even when the single-event endpoint has it, e.g.
// once tickets go on sale after the event was first synced). Re-fetches
// each event's own detail page, which reports pricing more reliably, and
// updates the row if a real price is now available. Limited per call and
// rate-limited between requests since this hits the Ticketmaster API once
// per event, unlike the bulk sync.
//
// Returns diagnostic counts/samples alongside `updated` so a "0 updated" run
// is legible from the API response alone: apiErrors means calls are failing
// (bad/missing API key, rate limiting, etc — a real bug); noPriceInResponse
// means the calls succeeded but Ticketmaster itself has no price for that
// event yet (not a bug, just data that isn't available yet at the source).
export const backfillMissingPrices = async (limit = 100) => {
  try {
    if (!TICKETMASTER_API_KEY) {
      return { success: false, error: 'TICKETMASTER_API_KEY not configured' };
    }

    const { rows } = await pool.query(
      `SELECT id, external_id FROM events
       WHERE source = 'ticketmaster' AND min_price IS NULL
       ORDER BY date ASC
       LIMIT $1`,
      [limit]
    );

    let updated = 0;
    let apiErrors = 0;
    let noPriceInResponse = 0;
    const errorSamples = [];
    const noPriceSamples = [];

    for (const row of rows) {
      const { data: detail, errorInfo } = await getTicketmasterEventDetails(row.external_id);

      if (errorInfo) {
        apiErrors++;
        if (errorSamples.length < 3) {
          errorSamples.push({ external_id: row.external_id, error: errorInfo });
        }
      }

      const priceRanges = detail?.priceRanges;
      const minPrice = priceRanges?.[0]?.min != null ? parseFloat(priceRanges[0].min) : null;
      const maxPrice = priceRanges?.[0]?.max != null ? parseFloat(priceRanges[0].max) : null;

      if (minPrice != null) {
        const priceBreakdown = Array.isArray(priceRanges)
          ? JSON.stringify(
              priceRanges
                .filter((pr) => pr.min != null || pr.max != null)
                .map((pr) => ({
                  type: pr.type ? pr.type.charAt(0).toUpperCase() + pr.type.slice(1) : 'Standard',
                  min: pr.min != null ? parseFloat(pr.min) : null,
                  max: pr.max != null ? parseFloat(pr.max) : null,
                  currency: pr.currency || 'USD',
                }))
            )
          : null;

        await pool.query(
          `UPDATE events SET min_price = $1, max_price = $2, price_breakdown = $3, updated_at = NOW() WHERE id = $4`,
          [minPrice, maxPrice, priceBreakdown, row.id]
        );
        updated++;
      } else if (!errorInfo) {
        noPriceInResponse++;
        if (noPriceSamples.length < 3) {
          noPriceSamples.push({
            external_id: row.external_id,
            hasPriceRangesField: priceRanges !== undefined,
            responseKeys: detail ? Object.keys(detail).slice(0, 15) : [],
          });
        }
      }

      // Rate limiting — one detail call per event, be polite to the API.
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    return {
      success: true,
      checked: rows.length,
      updated,
      apiErrors,
      noPriceInResponse,
      errorSamples,
      noPriceSamples,
    };
  } catch (error) {
    console.error('Ticketmaster price backfill failed:', error);
    return { success: false, error: error.message };
  }
};

// Create scheduled sync (runs every 24 hours)
export const scheduleEventSync = (intervalMs = 24 * 60 * 60 * 1000) => {
  console.log('⏰ Scheduling automatic event sync every 24 hours');
  
  setInterval(() => {
    console.log('🔄 Running scheduled sync...');
    syncAllEvents();
  }, intervalMs);
};

// Export for manual sync endpoint
export default {
  fetchTicketmasterEvents,
  fetchAllUSEvents,
  fetchAllCanadianEvents,
  fetchTicketmasterSportsEvents,
  fetchAllUSSportsEvents,
  fetchAllCanadianSportsEvents,
  fetchTicketmasterSportsEventsNationwide,
  storeEvent,
  syncAllEvents,
  getTicketmasterEventDetails,
  backfillMissingPrices,
  scheduleEventSync
};
