import axios from 'axios';
import { pool } from '../index.js';

const TICKETMASTER_API_KEY = process.env.TICKETMASTER_API_KEY;
const TICKETMASTER_BASE_URL = 'https://app.ticketmaster.com/discovery/v2';

// Map of countries and their market codes
const MARKET_CODES = {
  'USA': [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25],
  'Canada': [26, 27, 28]
};

// US States mapping
const US_STATES = [
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
    const category = classifications?.[0]?.segment?.name || 'Other';
    const date = new Date(dates.start.dateTime);
    const image = images?.[0]?.url || null;
    const sourceUrl = url;

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
    const minPrice = priceRanges?.[0]?.min != null ? parseFloat(priceRanges[0].min) : null;
    const maxPrice = priceRanges?.[0]?.max != null ? parseFloat(priceRanges[0].max) : null;

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

    console.log('✅ Sync complete!');
    return { success: true, totalEvents: usEvents.length + caEvents.length };
  } catch (error) {
    console.error('Sync failed:', error);
    return { success: false, error: error.message };
  }
};

// Get event details from Ticketmaster
export const getTicketmasterEventDetails = async (eventId) => {
  try {
    const response = await axios.get(`${TICKETMASTER_BASE_URL}/events/${eventId}`, {
      params: { apikey: TICKETMASTER_API_KEY }
    });

    return response.data;
  } catch (error) {
    console.error('Error fetching Ticketmaster event details:', error);
    return null;
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
  storeEvent,
  syncAllEvents,
  getTicketmasterEventDetails,
  scheduleEventSync
};
