import express from 'express';
import { pool } from '../index.js';
import { isSameEvent } from '../utils/matching.js';
import { normalizeState } from '../utils/states.js';
import { ACTIVE_SOURCES, appendSourceFilter } from '../config/sourceVisibility.js';
import { appendPricedOnlyFilter } from '../config/priceVisibility.js';

const router = express.Router();

// Safety cap on how many raw rows (pre-merge, across all sources) a single
// request will fetch before merging/sorting/paginating in memory. This used
// to be 5000, back when the whole events table only ever held a few
// thousand rows total. Since the query orders by date ASC and takes the
// EARLIEST rows up to this cap, that low a cap became a silent visibility
// bug once the comprehensive Ticketmaster/SeatGeek sync grew the table
// past 100k rows: any event past the first 5000 upcoming rows (across BOTH
// sources combined) was completely invisible to every listing endpoint, no
// matter how far a visitor paginated, even though it was sitting right
// there in the database. Raised now that mergeEventsAcrossSources buckets
// by (day, city, state) instead of doing an O(n^2) linear scan (see
// below), so a much higher cap here no longer risks the same request
// becoming slow/timing out. Still a cap, not "no limit" — the real fix for
// unbounded growth is proper SQL-level pagination, but this comfortably
// covers the current catalog size with headroom.
const MAX_RAW_ROWS = 30000;

// Merge rows that represent the same real-world event (per isSameEvent)
// into a single card with one `offers` entry per source — the actual
// price-comparison feature. Preserves row order otherwise (each group's
// position is wherever its first-seen row was).
function mergeEventsAcrossSources(rows) {
  const merged = [];

  // Bucket candidates by (calendar day, city, state) before checking
  // isSameEvent — that function already REQUIRES an exact match on all
  // three before it will consider two rows a duplicate at all (see
  // utils/matching.js), so grouping by the same key first means duplicate
  // detection only ever scans same-bucket candidates instead of every
  // event merged so far. Without this, `merged.find(...)` re-scanned the
  // entire growing `merged` array for every single row — O(n^2) — which
  // was invisible at a few thousand rows but became a serious problem once
  // the events table grew past 100k rows (MAX_RAW_ROWS raised below): a
  // 5000-row page merge was already ~12.5M isSameEvent calls, and raising
  // the row cap without this fix would have made every listing request
  // dramatically slower or outright time out.
  const buckets = new Map();
  const bucketKey = (row) => {
    const d = new Date(row.date);
    const day = Number.isNaN(d.getTime()) ? 'invalid-date' : d.toISOString().slice(0, 10);
    return `${day}|${(row.city || '').toLowerCase().trim()}|${normalizeState(row.state)}`;
  };

  for (const row of rows) {
    const offer = {
      // event_row_id/external_id are additive fields (not used by the
      // existing frontend logic) so the click-tracking beacon can identify
      // exactly which source-row was clicked. See routes/clicks.js.
      event_row_id: row.id,
      external_id: row.external_id,
      source: row.source,
      source_url: row.source_url,
      min_price: row.min_price,
      max_price: row.max_price,
      currency: row.currency,
    };

    const key = bucketKey(row);
    let bucket = buckets.get(key);
    const match = bucket && bucket.find((m) => isSameEvent(m, row));
    if (match) {
      // A second row from a source that's ALREADY represented on this
      // merged event (e.g. the same TicketNetwork performance listed twice
      // under two external_ids) is a duplicate listing, not a second
      // retailer — collapsing it into the existing offer is what keeps the
      // price-comparison line and offer list to one entry per real seller.
      // Without this, two same-source rows that both satisfy isSameEvent
      // show up as "ticketnetwork from $X · ticketnetwork from $X" on the
      // same card. Keep whichever row has the lower price (or the one with
      // an actual price, if only one of them has one).
      const existingSameSource = match.offers.find((o) => o.source === row.source);
      if (existingSameSource) {
        const existingPrice = existingSameSource.min_price != null ? Number(existingSameSource.min_price) : null;
        const newPrice = row.min_price != null ? Number(row.min_price) : null;
        const preferNew = existingPrice == null && newPrice != null
          ? true
          : (newPrice != null && existingPrice != null && newPrice < existingPrice);
        if (preferNew) {
          existingSameSource.event_row_id = row.id;
          existingSameSource.external_id = row.external_id;
          existingSameSource.source_url = row.source_url;
          existingSameSource.min_price = row.min_price;
          existingSameSource.max_price = row.max_price;
          existingSameSource.currency = row.currency;
        }
      } else {
        match.offers.push(offer);
      }
      // Backfill anything the primary row is missing from this duplicate.
      if (!match.image_url && row.image_url) match.image_url = row.image_url;
      if (!match.artist_name && row.artist_name) match.artist_name = row.artist_name;
      if (!match.description && row.description) match.description = row.description;
      if (match.distance_km == null && row.distance_km != null) match.distance_km = row.distance_km;
    } else {
      const newEvent = { ...row, offers: [offer] };
      merged.push(newEvent);
      if (!bucket) {
        bucket = [];
        buckets.set(key, bucket);
      }
      bucket.push(newEvent);
    }
  }

  // Compute the best (lowest) price across offers and flag its source, so
  // the UI can badge it. Also mirror it onto the existing top-level
  // min_price/max_price fields for backward compatibility with anything
  // still reading those directly.
  //
  // Deliberately excludes source === 'official' from this comparison: those
  // rows come from a festival/venue/artist/band's own site, not a ticket
  // seller, and any price their JSON-LD publishes (often a general festival
  // pass) isn't a like-for-like comparison with an actual per-ticket price
  // from Ticketmaster/SeatGeek. Counting it here would risk the "Best
  // Price" figure and BEST PRICE badge pointing at an unbuyable, non-
  // affiliate link. The official offer still appears in `offers` (the
  // frontend shows it as its own unpriced "Visit Official Site" link) —
  // it's just never eligible to win the price comparison.
  for (const event of merged) {
    const priced = event.offers.filter((o) => o.min_price != null && o.source !== 'official');
    if (priced.length > 0) {
      const best = priced.reduce((a, b) => (Number(a.min_price) <= Number(b.min_price) ? a : b));
      const worst = priced.reduce((a, b) => (Number(a.min_price) >= Number(b.min_price) ? a : b));
      event.best_price = best.min_price;
      event.best_source = best.source;
      event.min_price = best.min_price;
      event.max_price = best.max_price;

      // Full price comparison for this event: every comparable offer
      // sorted lowest-first, plus the lowest/highest/spread numbers so a
      // caller doesn't have to re-derive them from the offers array. All
      // of these are computed straight from ticket_offers-equivalent data
      // already on `event.offers` — nothing here reaches outside the
      // central database.
      event.price_comparison = {
        lowest_price: Number(best.min_price),
        highest_price: Number(worst.min_price),
        price_difference: Number((Number(worst.min_price) - Number(best.min_price)).toFixed(2)),
        // Percentage the highest offer is above the lowest. Undefined
        // (not 0) when lowest_price is 0 — "N% more than free" isn't a
        // meaningful figure, so leave it for the caller to handle rather
        // than emit a misleading Infinity/0.
        price_difference_pct: Number(best.min_price) > 0
          ? Number((((Number(worst.min_price) - Number(best.min_price)) / Number(best.min_price)) * 100).toFixed(1))
          : null,
        offers: priced
          .slice()
          .sort((a, b) => Number(a.min_price) - Number(b.min_price))
          .map((o, i) => ({
            rank: i + 1,
            source: o.source,
            price: Number(o.min_price),
            is_best_price: i === 0,
            url: o.source_url,
            // Neither Ticketmaster's nor SeatGeek's bulk sync endpoint
            // documents whether min_price includes fees, so this is
            // deliberately 'unknown' rather than a guessed 'base'/'all_in'
            // — see backend/src/services/canonicalize.js and
            // backend/DATA_SOURCES.md. Surfaced so a comparison built on
            // top of this API can show the caveat instead of silently
            // treating two possibly-non-equivalent prices as directly
            // comparable.
            price_type: 'unknown',
          })),
      };
    } else {
      event.best_price = null;
      event.best_source = null;
      event.price_comparison = null;
    }
  }

  return merged;
}

// Sort comparator matching the API's `sort` values, applied to merged
// events (so e.g. "price-low" compares each event's best price across
// sources, not one source's price in isolation). Events with no data for
// the chosen sort key always sort last, regardless of direction.
function compareEvents(a, b, effectiveSort) {
  if (effectiveSort === 'distance') {
    const da = a.distance_km, db = b.distance_km;
    if (da == null && db == null) return 0;
    if (da == null) return 1;
    if (db == null) return -1;
    return da - db;
  }
  if (effectiveSort === 'price-low' || effectiveSort === 'price-high') {
    const pa = a.best_price, pb = b.best_price;
    if (pa == null && pb == null) return 0;
    if (pa == null) return 1;
    if (pb == null) return -1;
    return effectiveSort === 'price-low' ? pa - pb : pb - pa;
  }
  if (effectiveSort === 'name') {
    return (a.title || '').localeCompare(b.title || '');
  }
  // default: date ascending
  return new Date(a.date) - new Date(b.date);
}

// The standing ordering rule for every category view (homepage category
// rows AND the main listing whenever a category/keywords filter is active):
//   1. Closest to the visitor's location first.
//   2. Among events at a given proximity, prefer the ones listed with more
//      retailers (a merged event's `offers.length`) — a real multi-seller
//      comparison is worth more than a single-seller listing at the same
//      distance.
//   3. Once that ordering is set, don't let one retailer's events cluster
//      together — walk it round-robin by each event's primary retailer so
//      the list cycles through sellers (1 from retailer A, 1 from retailer
//      B, 1 from retailer C, then back to A, ...) rather than showing many
//      consecutive events from the same single seller. Each retailer's own
//      queue keeps its internal order from steps 1-2, so the closest/most-
//      multi-retailer events from each seller still come up first within
//      their own turn.
// Applied only for category-scoped views, not the unfiltered homepage/
// browse list — "for each category" is the requested scope.
function applyLocationRetailerOrder(events, hasCoords) {
  const distanceOf = (e) => (e.distance_km != null ? e.distance_km : Infinity);

  const byDistanceThenRetailers = events.slice().sort((a, b) => {
    if (hasCoords) {
      const d = distanceOf(a) - distanceOf(b);
      if (d !== 0) return d;
    }
    const retailersA = (a.offers || []).length;
    const retailersB = (b.offers || []).length;
    if (retailersB !== retailersA) return retailersB - retailersA;
    return new Date(a.date) - new Date(b.date);
  });

  const queuesBySource = new Map();
  for (const event of byDistanceThenRetailers) {
    const primarySource = event.offers?.[0]?.source || event.source || 'unknown';
    if (!queuesBySource.has(primarySource)) queuesBySource.set(primarySource, []);
    queuesBySource.get(primarySource).push(event);
  }

  const queues = [...queuesBySource.values()];
  const result = [];
  let anyRemaining = true;
  while (anyRemaining) {
    anyRemaining = false;
    for (const queue of queues) {
      if (queue.length > 0) {
        result.push(queue.shift());
        anyRemaining = true;
      }
    }
  }
  return result;
}

// Get All Events with Filters
router.get('/', async (req, res) => {
  try {
    const { city, state, country, category, keywords, minPrice, maxPrice, startDate, endDate, search, location, sort, lat, lng, limit = 20, offset = 0 } = req.query;

    // Customer location, if the browser shared it. When present, results
    // default to nearest-first unless the caller asked for a different sort.
    const customerLat = lat !== undefined ? parseFloat(lat) : null;
    const customerLng = lng !== undefined ? parseFloat(lng) : null;
    const hasLocation = Number.isFinite(customerLat) && Number.isFinite(customerLng);
    const effectiveSort = sort || (hasLocation ? 'distance' : 'date');

    // Excludes past events by default — unconditionally, not just when a
    // caller explicitly passes startDate. Before this fix, a listing
    // request with no date filter (the homepage's default view) had
    // nothing excluding events whose date had already passed, so a show
    // that already happened stayed visible/sellable-looking indefinitely
    // until enough newer rows pushed it out of the LIMIT. A ticket-
    // comparison site has no legitimate reason to list a past event, so
    // this applies regardless of sort order or other filters. The
    // startDate/endDate filters below still work as an additional narrowing
    // on top of this — e.g. "shows in the next 7 days" — they just can no
    // longer be the ONLY thing keeping past events out.
    let whereClause = ' WHERE date >= NOW()';
    const params = [];
    let paramCount = 1;

    // Filters
    if (country) {
      whereClause += ` AND country = $${paramCount}`;
      params.push(country);
      paramCount++;
    }

    if (state) {
      whereClause += ` AND state = $${paramCount}`;
      params.push(state);
      paramCount++;
    }

    if (city) {
      whereClause += ` AND city = $${paramCount}`;
      params.push(city);
      paramCount++;
    }

    // location: free-text customer filter (e.g. "Milwaukee" or "WI"),
    // matched case-insensitively against city, state, or venue name — unlike
    // the exact-match `city`/`state` params above (used by structured
    // lookups), this is meant for a customer typing into a "Location" filter
    // box, so it's a partial, case-insensitive match across all three.
    if (location) {
      whereClause += ` AND (city ILIKE $${paramCount} OR state ILIKE $${paramCount} OR venue_name ILIKE $${paramCount})`;
      params.push(`%${location}%`);
      paramCount++;
    }

    // category supports a comma-separated list (e.g. "Music,Concert") so a
    // single UI filter (like a "Concerts" category tile) can match event
    // rows that different data sources labeled differently.
    if (category) {
      const categoryList = category.split(',').map((c) => c.trim()).filter(Boolean);
      if (categoryList.length > 0) {
        whereClause += ` AND category = ANY($${paramCount}::text[])`;
        params.push(categoryList);
        paramCount++;
      }
    }

    // minPrice/maxPrice are applied AFTER merging (against each event's best
    // price across sources — see below), not here, so an event doesn't get
    // excluded just because one source's offer falls outside the range
    // while a cheaper offer from the other source would be in range.

    if (startDate) {
      whereClause += ` AND date >= $${paramCount}`;
      params.push(new Date(startDate));
      paramCount++;
    }

    if (endDate) {
      whereClause += ` AND date <= $${paramCount}`;
      params.push(new Date(endDate));
      paramCount++;
    }

    if (search) {
      whereClause += ` AND (title ILIKE $${paramCount} OR artist_name ILIKE $${paramCount} OR venue_name ILIKE $${paramCount})`;
      params.push(`%${search}%`);
      paramCount++;
    }

    // keywords: comma-separated OR terms matched across the same columns as
    // `search`, but kept as a separate filter so a category tile's own
    // keyword match (e.g. "NFL") can be ANDed with the customer's own
    // search box text rather than overwriting it. Unlike `search` (a plain
    // substring match, appropriate for free text a customer typed), these
    // use word-boundary regex matching (Postgres \m...\M) so a short league
    // acronym like "NFL" or "NBA" doesn't false-positive-match inside an
    // unrelated word that happens to contain those letters in sequence
    // (e.g. "NFL" inside "Inflatable" or "Confluence").
    //
    // Also checked against `category`, not just title/artist/venue: a
    // Ticketmaster/SeatGeek game's title is typically just the matchup
    // ("Dallas Cowboys vs. Philadelphia Eagles") and rarely contains the
    // league name itself, so the NFL/NBA/NCAA Football quick-filter tiles
    // were matching almost nothing even once those events were being
    // synced — the league name only ever showed up in the category the
    // provider assigned (see services/ticketmaster.js's subGenre-based
    // category and services/seatgeek.js's taxonomy-based category).
    if (keywords) {
      const keywordList = keywords.split(',').map((k) => k.trim()).filter(Boolean);
      if (keywordList.length > 0) {
        const orParts = keywordList.map((_, i) => {
          const p = paramCount + i;
          return `(title ~* $${p} OR artist_name ~* $${p} OR venue_name ~* $${p} OR category ~* $${p})`;
        });
        whereClause += ` AND (${orParts.join(' OR ')})`;
        keywordList.forEach((kw) => params.push(`\\m${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\M`));
        paramCount += keywordList.length;
      }
    }

    // TEMPORARY (see config/sourceVisibility.js): restricts the main
    // browse/search listing to only the active source(s).
    ({ whereClause, paramCount } = appendSourceFilter(whereClause, params, paramCount));

    // PERMANENT (see config/priceVisibility.js): never list an event with no
    // tickets actually available for sale (no price from its source at all).
    whereClause = appendPricedOnlyFilter(whereClause);

    // Distance from the customer's location, via the Haversine formula. Only
    // events with stored venue coordinates get a real value; others come
    // back NULL and sort to the end rather than being excluded.
    const selectClause = hasLocation
      ? `SELECT *, (
           CASE WHEN latitude IS NULL OR longitude IS NULL THEN NULL ELSE
             6371 * acos(
               LEAST(1, GREATEST(-1,
                 cos(radians($${paramCount})) * cos(radians(latitude)) * cos(radians(longitude) - radians($${paramCount + 1}))
                 + sin(radians($${paramCount})) * sin(radians(latitude))
               ))
             )
           END
         ) AS distance_km FROM events`
      : 'SELECT * FROM events';
    const listParams = hasLocation ? [...params, customerLat, customerLng] : [...params];
    if (hasLocation) paramCount += 2;

    // No SQL-level sort matching the API's `sort` param, and no
    // OFFSET/paging LIMIT — real sorting and pagination both happen after
    // merging (below), since "cheapest offer" and "how many distinct
    // events" only exist once same-event rows from different sources are
    // combined. This ORDER BY + MAX_RAW_ROWS pair only exists so that IF a
    // filtered result set is ever large enough to hit the cap, the rows
    // kept are deterministic (earliest first) rather than whatever
    // Postgres happens to return.
    const query = `${selectClause}${whereClause} ORDER BY date ASC LIMIT $${paramCount}`;
    listParams.push(MAX_RAW_ROWS);

    const result = await pool.query(query, listParams);

    // Merge Ticketmaster + SeatGeek rows for the same real event into one
    // card with an `offers` array — the actual price-comparison feature.
    let merged = mergeEventsAcrossSources(result.rows);

    // Price filters apply post-merge, against each event's best price.
    if (minPrice) {
      const min = parseFloat(minPrice);
      merged = merged.filter((e) => e.best_price != null && Number(e.best_price) >= min);
    }
    if (maxPrice) {
      const max = parseFloat(maxPrice);
      merged = merged.filter((e) => e.best_price != null && Number(e.best_price) <= max);
    }

    // Standing ordering rule (closest -> most-retailers -> retailer-round-
    // robin) applies to every listing view by default, including the "All"
    // tile and the plain Featured Events grid with no category tile
    // selected at all — not just an explicit category/keyword filter. An
    // explicit `sort` (e.g. "Price: Low to High" from the dropdown) always
    // wins over this, since that's the visitor's own direct choice.
    if (!sort) {
      merged = applyLocationRetailerOrder(merged, hasLocation);
    } else {
      merged.sort((a, b) => compareEvents(a, b, effectiveSort));
    }

    const total = merged.length;
    const pageEvents = merged.slice(parseInt(offset), parseInt(offset) + parseInt(limit));

    res.json({
      events: pageEvents,
      total,
      limit: parseInt(limit),
      offset: parseInt(offset),
      hasMore: (parseInt(offset) + parseInt(limit)) < total
    });
  } catch (error) {
    console.error('Error fetching events:', error);
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

// Get a single event MERGED with any same-event offers from other sources
// (spec §12, §20-22 — real per-event pages need the same price-comparison
// data the list view has, not just one source's raw row). Used by the
// frontend's /event/:id-:slug detail route on a direct load or refresh,
// when the event object isn't already sitting in memory from a click.
//
// :eventRowId is a specific row's own id (stable — rows are updated in
// place by the sync jobs, never deleted, so this id never changes once
// assigned), NOT a canonical_events id from the derived/rebuildable layer
// (those ids reset on every POST /admin/canonicalize/rebuild, which would
// silently break any bookmarked or indexed URL built from them).
// Shared by the /detail route below AND routes/prerender.js (bot-facing
// server-rendered event pages need the exact same merged data a human
// visitor sees — see prerender.js for why that route exists).
async function getMergedEventById(eventRowId) {
  const baseResult = await pool.query('SELECT * FROM events WHERE id = $1', [eventRowId]);
  if (baseResult.rows.length === 0) return null;
  const base = baseResult.rows[0];

  // TEMPORARY (see config/sourceVisibility.js): a direct/bookmarked link to
  // a hidden-source event behaves as if it doesn't exist, same as any other
  // event this restriction hides from listings.
  if (ACTIVE_SOURCES && !ACTIVE_SOURCES.includes(base.source)) return null;

  // Candidates for cross-source merging: same calendar day + same
  // city/state (the cheap, exact part of isSameEvent) — narrows a
  // 3000+ row table down to a handful before running the more expensive
  // token-similarity check in JS, same division of labor as the list
  // endpoint above.
  let candidatesWhere = 'WHERE date::date = $1::date AND city = $2 AND state = $3 AND source != $4';
  const candidatesParams = [base.date, base.city, base.state, base.source];
  ({ whereClause: candidatesWhere } = appendSourceFilter(candidatesWhere, candidatesParams, candidatesParams.length + 1));
  const candidatesResult = await pool.query(
    `SELECT * FROM events ${candidatesWhere}`,
    candidatesParams
  );

  const merged = mergeEventsAcrossSources([base, ...candidatesResult.rows]);
  // mergeEventsAcrossSources always keeps the first row (base, here) as
  // the primary/merged[0] since it's first in the input array.
  const result = merged[0];

  // PERMANENT (see config/priceVisibility.js): checked AFTER merging, not on
  // `base` alone — an unpriced base row can still be genuinely for-sale if a
  // priced row from another source merged into it (mergeEventsAcrossSources
  // promotes the cheapest priced offer's price up to the merged event's own
  // min_price/max_price). Only hide it if NO offer, from any source, has a
  // real price — no tickets are actually available for it anywhere we know.
  if (result.min_price == null && result.max_price == null) return null;
  return result;
}

// ---- Homepage event-discovery sections (Popular / Recommended / Trending /
// by-category) ------------------------------------------------------------
//
// Category match rules mirror the frontend's own quick-filter tiles (see
// EVENT_CATEGORIES in frontend/src/App.jsx) so a section here contains
// exactly the same kinds of events those tiles would show. The generic
// "Sports" bucket was replaced with dedicated nfl/nba/ncaaFootball rules
// (matching the tiles' own NFL/NBA/NCAA Football keyword lists exactly) so
// the homepage sections split sports the same way the tiles do, rather than
// lumping every sport into one catch-all section.
const DISCOVER_CATEGORY_RULES = {
  nfl: { categories: [], keywords: ['NFL'] },
  concerts: { categories: ['Music', 'Concert'], keywords: [] },
  nba: { categories: [], keywords: ['NBA', 'Basketball'] },
  ncaaFootball: { categories: [], keywords: ['NCAA Football', 'College Football', 'NCAA'] },
  theater: { categories: ['Arts & Theatre', 'Theatre', 'Theater'], keywords: [] },
  comedy: { categories: [], keywords: ['Comedy', 'Stand-Up', 'Stand Up'] },
};

// How many events each discover section should return. The frontend now
// pages through each section client-side (see DISCOVER_PAGE_SIZE/
// DISCOVER_MAX_PAGES in App.jsx's EventSection — a "‹ 1 of 7 ›" control
// replaced the old single "View all" link), so a section needs enough
// events to actually fill up to 7 pages, not just the 5 that used to be
// shown outright.
const DISCOVER_PAGE_SIZE = 5;
const DISCOVER_MAX_PAGES = 7;
const DISCOVER_SECTION_COUNT = DISCOVER_PAGE_SIZE * DISCOVER_MAX_PAGES;

function buildCategoryWhere(rule, paramCountStart, params) {
  let paramCount = paramCountStart;
  const parts = [];
  if (rule.categories.length > 0) {
    parts.push(`category = ANY($${paramCount}::text[])`);
    params.push(rule.categories);
    paramCount++;
  }
  if (rule.keywords.length > 0) {
    const orParts = rule.keywords.map((_, i) => {
      const p = paramCount + i;
      return `(title ~* $${p} OR artist_name ~* $${p} OR venue_name ~* $${p} OR category ~* $${p})`;
    });
    parts.push(`(${orParts.join(' OR ')})`);
    rule.keywords.forEach((kw) => params.push(`\\m${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\M`));
    paramCount += rule.keywords.length;
  }
  return { sql: parts.length ? `(${parts.join(' OR ')})` : '', paramCount };
}

// Raw-row fetch shared by every discover section below: upcoming events
// only, optionally distance-scored/sorted from (lat,lng) when the visitor's
// location is known, optionally narrowed to one DISCOVER_CATEGORY_RULES
// entry. Returns raw (pre-merge) rows — callers merge with
// mergeEventsAcrossSources themselves so each section can attach its own
// scoring afterward. Each category section runs this as its OWN dedicated
// query (rather than slicing one shared pool) specifically so a thin
// category never comes up short just because the shared pool's LIMIT
// happened to fill up with other categories first.
async function fetchDiscoverCandidates(dbPool, { lat, lng, categoryRule = null, limitRaw = 400 }) {
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lng);
  const params = [];
  let paramCount = 1;
  let whereClause = 'WHERE date >= NOW()';

  // TEMPORARY (see config/sourceVisibility.js): applies to every homepage
  // discover section (Popular/Recommended/Trending/category rows), since
  // they all funnel through this one shared candidate fetch.
  ({ whereClause, paramCount } = appendSourceFilter(whereClause, params, paramCount));

  // PERMANENT (see config/priceVisibility.js): no sold-out/unpriced events
  // in any discover section either.
  whereClause = appendPricedOnlyFilter(whereClause);

  if (categoryRule) {
    const built = buildCategoryWhere(categoryRule, paramCount, params);
    if (built.sql) {
      whereClause += ` AND ${built.sql}`;
      paramCount = built.paramCount;
    }
  }

  const selectClause = hasCoords
    ? `SELECT *, (
         CASE WHEN latitude IS NULL OR longitude IS NULL THEN NULL ELSE
           6371 * acos(
             LEAST(1, GREATEST(-1,
               cos(radians($${paramCount})) * cos(radians(latitude)) * cos(radians(longitude) - radians($${paramCount + 1}))
               + sin(radians($${paramCount})) * sin(radians(latitude))
             ))
           )
         END
       ) AS distance_km FROM events`
    : 'SELECT * FROM events';
  const listParams = hasCoords ? [...params, lat, lng] : [...params];
  if (hasCoords) paramCount += 2;

  // Nearest-first when we know where the visitor is (so a tight LIMIT still
  // keeps the closest events rather than an arbitrary date-ordered slice
  // that might all be on the other side of the country); soonest-first
  // otherwise. Events with no stored coordinates (distance_km NULL) always
  // sort last rather than being excluded outright — Postgres already
  // defaults NULLs to sort last in ASC order, so a plain `distance_km ASC`
  // is enough; no need for an explicit `(distance_km IS NULL)` clause.
  //
  // Important: `distance_km` here must stay a BARE column reference.
  // Postgres only resolves a SELECT-list alias like `distance_km` when the
  // ORDER BY item is exactly that identifier — wrap it in any expression
  // (e.g. `(distance_km IS NULL)`) and Postgres instead tries to resolve it
  // as a real column of `events`, which doesn't exist, throwing "column
  // distance_km does not exist" and 500ing the whole /discover endpoint.
  // (This bit the very first version of this endpoint — passing lat/lng
  // triggered exactly that 500 in production. Keep this comment if this
  // clause is ever touched again.)
  const orderClause = hasCoords ? 'ORDER BY distance_km ASC, date ASC' : 'ORDER BY date ASC';

  const query = `${selectClause} ${whereClause} ${orderClause} LIMIT $${paramCount}`;
  listParams.push(limitRaw);
  const result = await dbPool.query(query, listParams);
  return result.rows;
}

// Attaches click_count (all-time clicks logged against this event — see
// routes/clicks.js) and recent_click_count (last 7 days, used for the
// Trending section) to each merged event, summed across every offer's
// event_row_id since a click on any one source's offer for the same real-
// world event still means a visitor found it interesting. All-time rather
// than a rolling window for click_count: the platform is too young for a
// 30-day window to reliably separate "popular" from "barely any data yet".
async function attachClickCounts(dbPool, mergedEvents) {
  const allRowIds = [];
  for (const event of mergedEvents) {
    for (const offer of event.offers) {
      if (offer.event_row_id != null) allRowIds.push(offer.event_row_id);
    }
  }
  if (allRowIds.length === 0) {
    for (const event of mergedEvents) {
      event.click_count = 0;
      event.recent_click_count = 0;
    }
    return;
  }

  const [totalResult, recentResult] = await Promise.all([
    dbPool.query(
      `SELECT event_row_id, COUNT(*)::int AS n FROM click_events WHERE event_row_id = ANY($1::int[]) GROUP BY event_row_id`,
      [allRowIds]
    ),
    dbPool.query(
      `SELECT event_row_id, COUNT(*)::int AS n FROM click_events WHERE event_row_id = ANY($1::int[]) AND created_at > NOW() - INTERVAL '7 days' GROUP BY event_row_id`,
      [allRowIds]
    ),
  ]);
  const totalMap = new Map(totalResult.rows.map((r) => [r.event_row_id, r.n]));
  const recentMap = new Map(recentResult.rows.map((r) => [r.event_row_id, r.n]));

  for (const event of mergedEvents) {
    let total = 0;
    let recent = 0;
    for (const offer of event.offers) {
      total += totalMap.get(offer.event_row_id) || 0;
      recent += recentMap.get(offer.event_row_id) || 0;
    }
    event.click_count = total;
    event.recent_click_count = recent;
  }
}

// Picks `count` events by a precomputed `_score`, but never lets one
// category dominate until every distinct category present has had a turn —
// the spec for "Recommended for You" explicitly calls out "category
// diversity". First pass: walk the score-sorted list, taking the single
// highest-scoring event from each not-yet-used category. Second pass (only
// if the first didn't fill every slot — e.g. fewer than `count` distinct
// categories exist nearby): fill remaining slots with the next best-scoring
// events regardless of category.
function pickDiverse(scoredEvents, count) {
  const sorted = scoredEvents.slice().sort((a, b) => b._score - a._score);
  const picked = [];
  const usedCategories = new Set();
  const usedIds = new Set();

  for (const event of sorted) {
    if (picked.length >= count) break;
    const cat = event.category || 'Other';
    if (usedCategories.has(cat)) continue;
    usedCategories.add(cat);
    usedIds.add(event.id);
    picked.push(event);
  }
  if (picked.length < count) {
    for (const event of sorted) {
      if (picked.length >= count) break;
      if (usedIds.has(event.id)) continue;
      usedIds.add(event.id);
      picked.push(event);
    }
  }
  return picked;
}

// Fills a section out to exactly `count` events (when the candidate pool
// has that many) by appending the soonest not-yet-picked upcoming events
// from the same pool — used whenever a popularity/trend signal alone
// doesn't produce enough events (e.g. a brand-new platform with little
// click data yet), so a section never comes back thinner than the platform
// actually has to offer nearby.
function backfillByDate(picked, candidatePool, count) {
  if (picked.length >= count) return picked.slice(0, count);
  const usedIds = new Set(picked.map((e) => e.id));
  const bySoonest = candidatePool.slice().sort((a, b) => new Date(a.date) - new Date(b.date));
  const result = picked.slice();
  for (const event of bySoonest) {
    if (result.length >= count) break;
    if (usedIds.has(event.id)) continue;
    usedIds.add(event.id);
    result.push(event);
  }
  return result;
}

// Homepage event-discovery sections (spec: Popular Events, Recommended for
// You, Trending Events Near [City], and one paginated row per Concerts/
// Sports/Theater/Comedy). Registered ahead of GET /:eventId below so
// "discover" is never swallowed as an :eventId path param.
//
// lat/lng/city are resolved CLIENT-SIDE (from the visitor's entered ZIP
// code, or reverse-geocoded from browser geolocation — see App.jsx) and
// passed straight through: this endpoint never tries to derive its own
// "nearest city" from the events table, since the visitor's actual home
// city may have no nearby events at all, and the heading still needs to
// name the visitor's real city rather than whatever's closest to it.
router.get('/discover', async (req, res) => {
  try {
    const lat = req.query.lat !== undefined ? parseFloat(req.query.lat) : null;
    const lng = req.query.lng !== undefined ? parseFloat(req.query.lng) : null;
    const hasCoords = Number.isFinite(lat) && Number.isFinite(lng);
    const cityLabel = (req.query.city || '').trim() || null;

    // Comma-separated categories the visitor has shown interest in this
    // session (see the frontend's lightweight click-category tally) — "based
    // on whatever user information/preferences are available" for
    // Recommended for You. Optional; the diversity algorithm below covers a
    // visitor with no history yet just as well.
    const prefCategories = (req.query.prefCategories || '')
      .split(',').map((c) => c.trim()).filter(Boolean);

    // One broad, location-aware candidate pool feeds Popular/Recommended/
    // Trending (all three are "best of what's nearby", just scored
    // differently). Concerts/Sports/Theater/Comedy each get their own
    // dedicated query further down.
    const rawCandidates = await fetchDiscoverCandidates(pool, { lat, lng, limitRaw: 1200 });
    const merged = mergeEventsAcrossSources(rawCandidates);
    await attachClickCounts(pool, merged);

    // ---- Popular Events: click_count first, soonest as a tiebreak; only
    // events with at least one real click count as "popular" — backfilled
    // with the soonest nearby upcoming events to reach 5 when click data is
    // thin (e.g. a brand-new platform or region). ----
    const popularSorted = merged.slice().sort((a, b) => {
      if (b.click_count !== a.click_count) return b.click_count - a.click_count;
      return new Date(a.date) - new Date(b.date);
    });
    const popularPicked = backfillByDate(
      popularSorted.filter((e) => e.click_count > 0).slice(0, DISCOVER_SECTION_COUNT),
      merged,
      DISCOVER_SECTION_COUNT
    );
    // Standing ordering rule applies to this section too: click_count only
    // decides WHICH events qualify as "popular"; once that set is picked,
    // present them closest-first / most-retailers-first / retailer-round-
    // robin, same as every category row.
    const popular = applyLocationRetailerOrder(popularPicked, hasCoords);

    // ---- Trending Events Near [City]: recent (7-day) click velocity, same
    // backfill approach as Popular. ----
    const trendingSorted = merged.slice().sort((a, b) => {
      if (b.recent_click_count !== a.recent_click_count) return b.recent_click_count - a.recent_click_count;
      if (b.click_count !== a.click_count) return b.click_count - a.click_count;
      return new Date(a.date) - new Date(b.date);
    });
    const trendingPicked = backfillByDate(
      trendingSorted.filter((e) => e.recent_click_count > 0).slice(0, DISCOVER_SECTION_COUNT),
      merged,
      DISCOVER_SECTION_COUNT
    );
    // Same standing ordering rule applied on top of the trending selection.
    const trending = applyLocationRetailerOrder(trendingPicked, hasCoords);

    // ---- Recommended for You: popularity + "happening soon" recency +
    // category diversity, with a small boost for categories the visitor has
    // actually shown interest in this session (if any — see prefCategories
    // above). This is the "sensible recommendation algorithm based on
    // event popularity, category diversity, location, and current trends"
    // fallback the spec calls for when there isn't enough personal history
    // yet — since the site has no login/account system, that's true for
    // every visitor today, so this fallback IS the algorithm for now. ----
    const now = Date.now();
    for (const event of merged) {
      const daysUntil = Math.max(0, (new Date(event.date).getTime() - now) / 86400000);
      const popularityScore = Math.log1p(event.click_count);
      const recencyScore = 1 / (1 + daysUntil / 14); // happening sooner scores higher ("current trends")
      const prefBoost = prefCategories.includes(event.category) ? 1 : 0;
      event._score = popularityScore * 2 + recencyScore + prefBoost;
    }
    const recommendedPicked = backfillByDate(pickDiverse(merged, DISCOVER_SECTION_COUNT), merged, DISCOVER_SECTION_COUNT);
    // Same standing ordering rule applied on top of the recommended
    // selection — pickDiverse/backfillByDate still decide WHICH events make
    // the cut (score + category diversity), this only decides the order
    // they're displayed in.
    const recommended = applyLocationRetailerOrder(recommendedPicked, hasCoords);

    // ---- Concerts / Sports / Theater / Comedy: up to DISCOVER_SECTION_COUNT
    // each (enough for the frontend's 7-page cap) when the platform has that
    // many upcoming, via their own dedicated query so a thin shared pool
    // never shorts one category. ----
    //
    // Nearest-first when the visitor's location is known (spec: "closest by
    // distance from the user's location in each category" — the default
    // behavior these rows are supposed to have). Before this fix, this loop
    // re-sorted by click_count/date only, silently throwing away the
    // distance ordering fetchDiscoverCandidates' SQL query already computed
    // (that query's own ORDER BY only controls which ~150 raw candidates get
    // pulled in — it says nothing about the order they're presented in once
    // this JS-side sort runs afterward). click_count/date remain as
    // tiebreakers among events at essentially the same distance, and as the
    // sole sort when no location is known at all.
    const categories = {};
    for (const [key, rule] of Object.entries(DISCOVER_CATEGORY_RULES)) {
      const rawRows = await fetchDiscoverCandidates(pool, { lat, lng, categoryRule: rule, limitRaw: 400 });
      const mergedCategory = mergeEventsAcrossSources(rawRows);
      await attachClickCounts(pool, mergedCategory);
      // Standing per-category ordering rule (see applyLocationRetailerOrder
      // above): closest first, then more-retailers-first among those, then
      // round-robin by retailer so the row doesn't cluster on one seller.
      const ordered = applyLocationRetailerOrder(mergedCategory, hasCoords);
      categories[key] = ordered.slice(0, DISCOVER_SECTION_COUNT);
    }

    // Strip internal-only scoring/click bookkeeping before responding —
    // these fields exist only for this endpoint's own ranking, not part of
    // the event shape the rest of the API returns.
    const clean = (events) => events.map(({ _score, click_count, recent_click_count, ...rest }) => rest);

    res.json({
      city: cityLabel,
      locationKnown: hasCoords || Boolean(cityLabel),
      popular: clean(popular),
      recommended: clean(recommended),
      trending: clean(trending),
      categories: {
        nfl: clean(categories.nfl),
        concerts: clean(categories.concerts),
        nba: clean(categories.nba),
        ncaaFootball: clean(categories.ncaaFootball),
        theater: clean(categories.theater),
        comedy: clean(categories.comedy),
      },
    });
  } catch (error) {
    console.error('Error building discover sections:', error);
    res.status(500).json({ error: 'Failed to load discovery sections' });
  }
});

router.get('/detail/:eventRowId', async (req, res) => {
  try {
    const event = await getMergedEventById(req.params.eventRowId);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    res.json({ event });
  } catch (error) {
    console.error('Error fetching merged event detail:', error);
    res.status(500).json({ error: 'Failed to fetch event' });
  }
});

// Autocomplete suggestions for the search box (spec: search/autocomplete
// engine). Returns a short, ranked list of distinct artists, event titles,
// venues, and cities matching the customer's in-progress query — meant to
// be called on every keystroke (debounced client-side), so this stays
// intentionally cheap: one ILIKE query per field, capped results, no
// cross-source merge (that only matters for the full results list, not a
// suggestions dropdown). Matches starting with the query are ranked above
// matches containing it elsewhere, since "starts with" is what a person
// scanning a dropdown expects to see first.
router.get('/autocomplete', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 2) {
      return res.json({ suggestions: [] });
    }

    const like = `%${q}%`;
    const startsWith = `${q}%`;
    // TEMPORARY (see config/sourceVisibility.js): autocomplete suggestions
    // shouldn't point visitors at events the listings themselves are hiding.
    const sourceClause = ACTIVE_SOURCES ? ' AND source = ANY($3::text[])' : '';
    const sourceParams = ACTIVE_SOURCES ? [ACTIVE_SOURCES] : [];

    // NOTE: each of these is SELECT DISTINCT with an ORDER BY expression
    // (the ILIKE-based "starts with" boolean) — Postgres requires every
    // ORDER BY expression on a SELECT DISTINCT query to appear in the
    // select list itself, so that boolean is explicitly selected (aliased
    // as starts_with) rather than only referenced in ORDER BY. Since
    // starts_with is fully determined by value (same value -> same
    // boolean), adding it to the select list doesn't change what DISTINCT
    // considers distinct.
    const [artists, titles, venues, cities] = await Promise.all([
      pool.query(
        `SELECT DISTINCT artist_name AS value, (artist_name ILIKE $2) AS starts_with FROM events
         WHERE artist_name ILIKE $1 AND artist_name IS NOT NULL AND artist_name != ''${sourceClause}
         ORDER BY starts_with DESC, value ASC LIMIT 5`,
        [like, startsWith, ...sourceParams]
      ),
      pool.query(
        `SELECT DISTINCT title AS value, (title ILIKE $2) AS starts_with FROM events
         WHERE title ILIKE $1 AND title IS NOT NULL AND title != ''${sourceClause}
         ORDER BY starts_with DESC, value ASC LIMIT 5`,
        [like, startsWith, ...sourceParams]
      ),
      pool.query(
        `SELECT DISTINCT venue_name AS value, (venue_name ILIKE $2) AS starts_with FROM events
         WHERE venue_name ILIKE $1 AND venue_name IS NOT NULL AND venue_name != ''${sourceClause}
         ORDER BY starts_with DESC, value ASC LIMIT 5`,
        [like, startsWith, ...sourceParams]
      ),
      pool.query(
        `SELECT DISTINCT city AS value, state, (city ILIKE $2) AS starts_with FROM events
         WHERE city ILIKE $1 AND city IS NOT NULL AND city != ''${sourceClause}
         ORDER BY starts_with DESC, value ASC LIMIT 5`,
        [like, startsWith, ...sourceParams]
      ),
    ]);

    // Tag each suggestion with a type so the UI can show a small label
    // ("Artist", "Venue", ...) and dedupe identical strings across
    // categories (e.g. an event titled the same as its headlining artist).
    const seen = new Set();
    const suggestions = [];
    const pushAll = (rows, type, format = (v) => v.value) => {
      for (const row of rows) {
        const label = format(row);
        const key = `${type}:${label.toLowerCase()}`;
        if (!label || seen.has(key)) continue;
        seen.add(key);
        suggestions.push({ type, label });
      }
    };
    pushAll(artists.rows, 'Artist');
    pushAll(titles.rows, 'Event');
    pushAll(venues.rows, 'Venue');
    pushAll(cities.rows, 'City', (r) => (r.state ? `${r.value}, ${r.state}` : r.value));

    // Cap the combined list — a dropdown longer than ~10 items stops being
    // scannable, and the per-field LIMIT 5s above already keep the pool
    // this trims from small.
    res.json({ suggestions: suggestions.slice(0, 10) });
  } catch (error) {
    console.error('Error fetching autocomplete suggestions:', error);
    res.status(500).json({ suggestions: [], error: 'Autocomplete failed' });
  }
});

// Search Events (Enhanced)
router.get('/search/advanced', async (req, res) => {
  try {
    const { q, country = 'USA' } = req.query;

    // TEMPORARY (see config/sourceVisibility.js)
    const sourceClause = ACTIVE_SOURCES ? ' AND source = ANY($3::text[])' : '';
    const sourceParams = ACTIVE_SOURCES ? [ACTIVE_SOURCES] : [];
    const result = await pool.query(
      `SELECT DISTINCT city, state FROM events
       WHERE country = $1 AND (title ILIKE $2 OR city ILIKE $2 OR state ILIKE $2)${sourceClause}
       LIMIT 20`,
      [country, `%${q}%`, ...sourceParams]
    );

    res.json({ results: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Search failed' });
  }
});

// Get Single Event
// IMPORTANT: this catch-all :eventId route must stay registered AFTER every
// other GET route on this router (/discover, /detail/:eventRowId,
// /autocomplete, /search/advanced, ...) — Express matches routes in
// registration order, and a bare "/:eventId" pattern matches literally any
// single path segment, including "autocomplete" or "advanced". Registered
// earlier, it silently swallowed those requests (treating the literal
// string "autocomplete" as an event id, which always 500'd on the DB
// lookup), which is why the search box's autocomplete dropdown never
// worked in production even though the /autocomplete handler itself was
// completely correct.
router.get('/:eventId', async (req, res) => {
  try {
    const { eventId } = req.params;

    const eventResult = await pool.query('SELECT * FROM events WHERE id = $1', [eventId]);
    if (eventResult.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }

    res.json({ event: eventResult.rows[0] });
  } catch (error) {
    console.error('Error fetching event:', error);
    res.status(500).json({ error: 'Failed to fetch event' });
  }
});

// Exported for reuse by routes/sitemap.js, which needs the same
// cross-source dedup so sitemap URLs correspond 1:1 with what customers
// actually see as a single event card, not one URL per raw source row.
export { mergeEventsAcrossSources, getMergedEventById };

export default router;
