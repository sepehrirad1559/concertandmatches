// Manually curated "attraction" listings for affiliate partners that do
// NOT expose a structured event/product data feed — unlike Ticketmaster
// (Discovery API), SeatGeek (Platform API), and TicketNetwork (Impact.com
// Product Catalog API, catalog id 1872), which are all synced automatically
// from a real, live, programmatic source (see backend/DATA_SOURCES.md).
//
// The Rockefeller Center affiliate program (joined via Impact.com,
// 2026-09) was investigated the same way TicketNetwork's was: checked the
// Impact.com "Assets" tab (marketing creative only, no data), "Tracking
// Integration" (conversion pixels/postbacks, not a product feed), and the
// "Has Product Catalog" brand-attribute filter. None of these exposed a
// catalog for this brand — it's a plain affiliate program (10% on Online
// Sale), not a catalog-backed one. Same investigation for Pelago by
// Singapore Airlines came back the same way; Pelago was NOT added here
// because its inventory (thousands of experiences across many cities,
// changing constantly) can't be responsibly hand-maintained the way
// Rockefeller Center's small, stable set of attractions can — see the
// PartnerPromoBanner in frontend/src/App.jsx for how Pelago is surfaced
// instead (a single outbound promo card, not individual "events").
//
// So: this is a deliberate, manually-maintained exception, not a synced
// third-party feed pretending to be one. `source = 'curated'` (not
// 'ticketmaster'/'seatgeek'/'ticketnetwork') makes that visible everywhere
// events are queried. Prices below were read directly off
// rockefellercenter.com/buy-tickets on 2026-09-15 (the site's own official
// pricing page, "From $X" starting prices) — they WILL drift out of date
// since nothing re-fetches them automatically; re-check that page and
// update ATTRACTIONS below periodically (there is no feed to poll instead).
//
// These aren't discrete dated events, they're daily/ongoing attractions, but
// routes/events.js's listing query requires `date >= NOW()` and sorts
// `ORDER BY date ASC` — built for one-time shows, not perpetual attractions.
// Rather than fight that, syncCuratedAttractions() re-stamps `date` to a
// rolling near-future date every time it runs (see ROLLING_WINDOW_DAYS),
// and it's scheduled to run daily in index.js alongside the other syncs —
// so these rows never go stale/fall out of `date >= NOW()` between visits,
// without pretending they're tied to a specific showtime.
import { pool } from '../index.js';

const ROLLING_WINDOW_DAYS = 30;

const ROCKEFELLER_AFFILIATE_LINK = 'https://therockefellercenter.pxf.io/aNzk1q';

// lat/lng: 45 Rockefeller Plaza, New York, NY — same coordinates for every
// attraction below since they're all the same address, so distance-sort
// (routes/events.js) treats them consistently with everything else that has
// coordinates.
const ROCKEFELLER_LAT = 40.7587;
const ROCKEFELLER_LNG = -73.9787;

const ATTRACTIONS = [
  {
    slug: 'rockefeller-top-of-the-rock',
    title: 'Top of the Rock Observation Deck',
    description: 'Three open-air observation levels (67th, 69th, and 70th floors) with 360-degree views across Manhattan and Central Park.',
    minPrice: 42,
    maxPrice: null,
  },
  {
    slug: 'rockefeller-the-beam',
    title: 'The Beam + Top of the Rock Admission',
    description: 'Recreate the famous 1932 "Lunch Atop a Skyscraper" photo on a suspended steel beam, plus full Top of the Rock observation deck access.',
    minPrice: 57,
    maxPrice: null,
  },
  {
    slug: 'rockefeller-skylift',
    title: 'SKYLIFT + Top of the Rock Admission',
    description: 'An open-air platform that rises 30 feet above the 70th floor observation deck, plus full Top of the Rock admission.',
    minPrice: 57,
    maxPrice: null,
  },
  {
    slug: 'rockefeller-all-inclusive',
    title: 'Top of the Rock All-Inclusive Pass',
    description: 'Observation deck admission plus both The Beam and SKYLIFT experiences in a single pass.',
    minPrice: 72,
    maxPrice: null,
  },
  {
    slug: 'rockefeller-center-tour',
    title: 'Rockefeller Center Guided Tour',
    description: "A guided walking tour of Rockefeller Center's art, architecture, and history, led by a licensed guide.",
    minPrice: 27,
    maxPrice: null,
  },
  {
    slug: 'rockefeller-the-rink',
    title: 'The Rink at Rockefeller Center — General Skate',
    description: "Ice skating session at Rockefeller Center's iconic outdoor rink.",
    minPrice: 22,
    maxPrice: null,
  },
];

function rollingDate() {
  return new Date(Date.now() + ROLLING_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

async function storeAttraction(attraction) {
  const externalId = `curated-${attraction.slug}`;
  const date = rollingDate();

  const existing = await pool.query('SELECT id FROM events WHERE external_id = $1', [externalId]);

  if (existing.rows.length > 0) {
    await pool.query(
      `UPDATE events SET
         title = $1, description = $2, category = $3, date = $4,
         country = $5, state = $6, city = $7, venue_name = $8, venue_address = $9,
         source_url = $10, min_price = $11, max_price = $12,
         latitude = $13, longitude = $14, updated_at = NOW()
       WHERE external_id = $15`,
      [
        attraction.title, attraction.description, 'Attraction', date,
        'USA', 'NY', 'New York', 'Rockefeller Center', '45 Rockefeller Plaza, New York, NY 10111',
        ROCKEFELLER_AFFILIATE_LINK, attraction.minPrice, attraction.maxPrice,
        ROCKEFELLER_LAT, ROCKEFELLER_LNG, externalId,
      ]
    );
    return { id: existing.rows[0].id, created: false };
  }

  const result = await pool.query(
    `INSERT INTO events (
       external_id, title, description, category, date, country, state, city,
       venue_name, venue_address, image_url, source, source_url, min_price, max_price,
       latitude, longitude
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING id`,
    [
      externalId, attraction.title, attraction.description, 'Attraction', date,
      'USA', 'NY', 'New York', 'Rockefeller Center', '45 Rockefeller Plaza, New York, NY 10111',
      null, 'curated', ROCKEFELLER_AFFILIATE_LINK, attraction.minPrice, attraction.maxPrice,
      ROCKEFELLER_LAT, ROCKEFELLER_LNG,
    ]
  );
  return { id: result.rows[0].id, created: true };
}

export async function syncCuratedAttractions() {
  let created = 0;
  let updated = 0;
  const errors = [];

  for (const attraction of ATTRACTIONS) {
    try {
      const { created: wasCreated } = await storeAttraction(attraction);
      if (wasCreated) created++; else updated++;
    } catch (error) {
      console.error(`Error storing curated attraction ${attraction.slug}:`, error.message);
      errors.push({ slug: attraction.slug, error: error.message });
    }
  }

  return {
    success: errors.length === 0,
    totalEvents: ATTRACTIONS.length,
    created,
    updated,
    errors: errors.length ? errors : null,
  };
}

export default { syncCuratedAttractions };
