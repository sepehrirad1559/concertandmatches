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
//
// As of the canonical-layer listing rewrite below, this cap only governs the
// FALLBACK path (listEventsFromRawEventsTable) — used when the derived
// canonical_events layer has never been rebuilt, or when a query against it
// fails. The normal path is now real SQL WHERE/ORDER BY/LIMIT/OFFSET against
// canonical_events and has no equivalent cap at all, which is the "real fix
// for unbounded growth" this comment was asking for.
const MAX_RAW_ROWS = 30000;

// Merge rows that represent the same real-world event (per isSameEvent)
// into a single card with one `offers` entry per source — the actual
// price-comparison feature. Preserves row order otherwise (each group's
// position is wherever its first-seen row was).
function mergeEventsAcrossSources(rows) {
  const merged = [];

  // Bucket candidates by (calendar day, city, state) before checking
  // isSameEvent — that function requires city+state to match exactly (see
  // utils/matching.js) and, with rare ±1-day exceptions handled below, the
  // day too — so grouping by the same key first means duplicate detection
  // only ever scans same-bucket candidates instead of every event merged so
  // far. Without this, `merged.find(...)` re-scanned the entire growing
  // `merged` array for every single row — O(n^2) — which was invisible at a
  // few thousand rows but became a serious problem once the events table
  // grew past 100k rows (MAX_RAW_ROWS raised below): a 5000-row page merge
  // was already ~12.5M isSameEvent calls, and raising the row cap without
  // this fix would have made every listing request dramatically slower or
  // outright time out.
  const buckets = new Map();
  const dayString = (date) => {
    const d = new Date(date);
    return Number.isNaN(d.getTime()) ? 'invalid-date' : d.toISOString().slice(0, 10);
  };
  const cityStatePart = (row) => `${(row.city || '').toLowerCase().trim()}|${normalizeState(row.state)}`;
  const bucketKey = (row) => `${dayString(row.date)}|${cityStatePart(row)}`;

  // A group is registered under its own day bucket AND the adjacent (±1)
  // day buckets, not just its own — see isSameDay in utils/matching.js for
  // why: a TicketNetwork row (date-only, always midnight UTC) and a
  // Ticketmaster/SeatGeek row for the SAME real event can legitimately land
  // on UTC calendar days one apart (an evening US show's local time crosses
  // into the next UTC day when TicketMaster/SeatGeek convert it, while
  // TicketNetwork's date-only value never does). isSameEvent already
  // tolerates that ±1 gap; without also registering groups under the
  // adjacent-day buckets here, those candidates would never even be looked
  // up against each other in the first place, since lookup only checks the
  // NEW row's own day bucket. Three inserts per group, one lookup per row —
  // still O(n) overall, just a larger constant.
  const registerInAdjacentBuckets = (group, date) => {
    const d = new Date(date);
    if (Number.isNaN(d.getTime())) {
      const key = `invalid-date|${cityStatePart(group)}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(group);
      return;
    }
    const baseUTC = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const cityState = cityStatePart(group);
    for (const offset of [-1, 0, 1]) {
      const day = new Date(baseUTC + offset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const key = `${day}|${cityState}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(group);
    }
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
    const bucket = buckets.get(key);
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
      registerInAdjacentBuckets(newEvent, row.date);
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
//   1. Closest to the visitor's location first — strictly, across every
//      retailer. A closer event from any single retailer always outranks a
//      farther one, no matter how many retailers list the farther one.
//   2. Only among events tied at the EXACT SAME distance (e.g. several
//      shows at the same venue), prefer the ones listed with more
//      retailers (a merged event's `offers.length`) — a real multi-seller
//      comparison is worth more than a single-seller listing at that same
//      distance.
// There is deliberately no retailer round-robin/interleaving step anymore
// — an earlier version reordered same-distance ties by primary retailer to
// avoid one seller's events clustering together, but any such shuffling
// risks looking like it's overriding the distance ordering, so plain
// distance-then-retailer-count-then-date is all this does now.
// Applied only for category-scoped views, not the unfiltered homepage/
// browse list — "for each category" is the requested scope.
function applyLocationRetailerOrder(events, hasCoords) {
  const distanceOf = (e) => (e.distance_km != null ? e.distance_km : Infinity);

  return events.slice().sort((a, b) => {
    if (hasCoords) {
      const d = distanceOf(a) - distanceOf(b);
      if (d !== 0) return d;
    }
    const retailersA = (a.offers || []).length;
    const retailersB = (b.offers || []).length;
    if (retailersB !== retailersA) return retailersB - retailersA;
    return new Date(a.date) - new Date(b.date);
  });
}

// Derives best_price/best_source/min_price/max_price/price_comparison for
// ONE event from its already-assembled `offers` array, using exactly the
// same rules mergeEventsAcrossSources applies at the end of its own merge
// (see the long comment there for why 'official' rows are excluded from the
// comparison, and why price_difference_pct is null rather than 0/Infinity
// when the lowest price is 0).
//
// Extracted so the SQL-backed listing path below can produce a byte-for-byte
// identical price_comparison object without re-running the whole in-memory
// merge: once the database has handed back an event's offers, deriving these
// five fields is pure arithmetic over a handful of offers, so there is no
// value in pushing it into SQL — and doing it here guarantees the two code
// paths can never drift apart in how they compute a "best price".
//
// Mutates `event` in place and returns it, same as the loop it was lifted
// from. mergeEventsAcrossSources itself still contains its own copy of this
// logic rather than calling this helper — deliberately left alone so this
// change cannot alter the behavior of the merge the /discover, /detail and
// sitemap paths all still depend on.
function applyPriceComparisonFields(event) {
  const priced = event.offers.filter((o) => o.min_price != null && o.source !== 'official');
  if (priced.length === 0) {
    event.best_price = null;
    event.best_source = null;
    event.price_comparison = null;
    return event;
  }

  const best = priced.reduce((a, b) => (Number(a.min_price) <= Number(b.min_price) ? a : b));
  const worst = priced.reduce((a, b) => (Number(a.min_price) >= Number(b.min_price) ? a : b));
  event.best_price = best.min_price;
  event.best_source = best.source;
  // Top-level min_price/max_price mirror the WINNING offer's own price pair
  // — not canonical_events.best_price/highest_price, which are the lowest
  // and highest *min* prices and can therefore come from two different
  // offers. Matching the live merge here matters: the frontend renders
  // "from $min – $max" from these two fields, and pairing the cheapest
  // seller's min with a different seller's min would invent a range no
  // single retailer actually offers.
  event.min_price = best.min_price;
  event.max_price = best.max_price;

  event.price_comparison = {
    lowest_price: Number(best.min_price),
    highest_price: Number(worst.min_price),
    price_difference: Number((Number(worst.min_price) - Number(best.min_price)).toFixed(2)),
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
        price_type: 'unknown',
      })),
  };
  return event;
}

// ---- Canonical-layer availability probe -------------------------------
//
// GET / is served from the precomputed canonical_events/ticket_offers layer
// (see listEventsFromCanonicalLayer below), but that layer is DERIVED: it
// starts empty on a fresh database and only becomes populated once someone
// runs POST /admin/schema/add-canonical-tables + /admin/schema/add-listing-
// columns and then POST /admin/canonicalize/rebuild (or the scheduled jobs
// in index.js get there first). Making the main public listing hard-depend
// on it would mean a brand-new or half-migrated deploy serves an empty site
// even though the raw `events` table is full of perfectly good rows.
//
// So: probe once, cache the answer for CANONICAL_PROBE_TTL_MS, and fall back
// to the original raw-`events` implementation (kept below, unchanged, as
// listEventsFromRawEventsTable) whenever the probe says "empty". The TTL is
// what keeps this from defeating the point of the whole change — one extra
// `SELECT 1 ... LIMIT 1` per minute across all traffic, not one per request.
// A minute is short enough that the site starts using the canonical layer on
// its own shortly after the first rebuild finishes, with no restart needed.
const CANONICAL_PROBE_TTL_MS = 60 * 1000;
const canonicalLayerState = { populated: false, checkedAt: 0 };

async function canonicalLayerIsPopulated() {
  const now = Date.now();
  if (now - canonicalLayerState.checkedAt < CANONICAL_PROBE_TTL_MS) {
    return canonicalLayerState.populated;
  }
  canonicalLayerState.checkedAt = now;
  try {
    // Tests primary_event_row_id specifically, not just "any row exists":
    // a database that was canonicalized by the PREVIOUS version of
    // services/canonicalize.js has plenty of canonical_events rows, but all
    // of them with a NULL primary_event_row_id — and since that column is
    // the `id` the listing returns, such rows are unusable and the listing
    // query filters them all out. Probing for a bare row would happily
    // declare that layer "populated" and serve an empty site until someone
    // noticed. Probing for a usable row means the endpoint only switches
    // over once a rebuild on the NEW code has actually happened.
    const probe = await pool.query('SELECT 1 FROM canonical_events WHERE primary_event_row_id IS NOT NULL LIMIT 1');
    canonicalLayerState.populated = probe.rows.length > 0;
  } catch (error) {
    // Table doesn't exist yet (migration not run) or the database is
    // unhappy — either way, the raw-events path is the safer answer.
    console.error('canonical_events probe failed, falling back to raw events listing:', error.message);
    canonicalLayerState.populated = false;
  }
  return canonicalLayerState.populated;
}

// Get All Events with Filters
//
// Two implementations live below. The canonical one does all the work in
// SQL (WHERE + ORDER BY + LIMIT/OFFSET), which is the whole point: the old
// implementation pulled up to MAX_RAW_ROWS (30,000) rows into Node on EVERY
// request and merged/filtered/sorted/sliced them in JS, which both burned
// the event loop per request and made every event past that cap invisible in
// a 220k+ row table no matter how far a visitor paginated. The raw one is
// retained verbatim as the fallback for a database whose canonical layer has
// never been rebuilt.
router.get('/', async (req, res) => {
  let served = false;
  try {
    if (await canonicalLayerIsPopulated()) {
      await listEventsFromCanonicalLayer(req, res);
      served = true;
    }
  } catch (error) {
    // A failure in the SQL path (e.g. the newer columns this endpoint needs
    // haven't been added yet because /admin/schema/add-listing-columns was
    // never POSTed) must degrade to the old behavior rather than 500 the
    // homepage. Mark the layer unusable so the next TTL window's worth of
    // requests skip straight to the fallback instead of each re-discovering
    // the same failure.
    console.error('Canonical listing query failed, falling back to raw events table:', error);
    canonicalLayerState.populated = false;
    canonicalLayerState.checkedAt = Date.now();
    if (res.headersSent) return;
  }
  if (!served) {
    await listEventsFromRawEventsTable(req, res);
  }
});

// Hard ceiling on `?limit=`. The old in-memory implementation sliced an
// already-materialized array, so an absurd limit cost nothing extra beyond
// what it had already fetched; with real SQL LIMIT/OFFSET, `?limit=500000`
// would be an open invitation to make the database do unbounded work on an
// unauthenticated endpoint. The frontend's own page size is 24
// (EVENTS_PAGE_SIZE in App.jsx), so this is far above anything the site
// itself asks for.
const MAX_PAGE_SIZE = 200;

// SQL-backed implementation of GET /. Reads the precomputed
// canonical_events/ticket_offers layer (services/canonicalize.js) — which
// already applies the exact same cross-source merge semantics as
// mergeEventsAcrossSources, just as a batch job instead of per request — so
// filtering, ordering and pagination can all be expressed as a single
// indexed query returning ONE page of rows, instead of dragging up to 30,000
// raw rows through Node on every request.
//
// Throws on any SQL failure rather than responding 500 itself: the route
// wrapper above catches that and degrades to listEventsFromRawEventsTable,
// so a missing column or an un-rebuilt derived layer can never take the
// public listing down.
async function listEventsFromCanonicalLayer(req, res) {
  const { city, state, country, category, keywords, minPrice, maxPrice, startDate, endDate, search, location, sort, lat, lng, limit = 20, offset = 0, excludeIds } = req.query;

  const parsedLimit = Number.parseInt(limit, 10);
  const parsedOffset = Number.parseInt(offset, 10);
  const effectiveLimit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), MAX_PAGE_SIZE) : 20;
  const effectiveOffset = Number.isFinite(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0;

  // Same semantics as the raw path: ids the homepage's discover carousels
  // have already shown, which the Featured Events grid must not repeat.
  // These are raw `events` ids, which is exactly what
  // canonical_events.primary_event_row_id holds — so this is now a SQL
  // NOT-IN rather than a post-fetch JS .filter() that silently shrank the
  // page below the requested limit.
  const excludeIdList = (excludeIds || '')
    .split(',')
    .map((id) => parseInt(id, 10))
    .filter((id) => Number.isInteger(id));

  const customerLat = lat !== undefined ? parseFloat(lat) : null;
  const customerLng = lng !== undefined ? parseFloat(lng) : null;
  const hasLocation = Number.isFinite(customerLat) && Number.isFinite(customerLng);
  const effectiveSort = sort || (hasLocation ? 'distance' : 'date');

  const params = [];
  let paramCount = 1;

  // TEMPORARY (see config/sourceVisibility.js): "source" is a per-OFFER /
  // per-provider concept in this layer (providers.name on ticket_offers),
  // not a column on canonical_events, so appendSourceFilter's raw-table
  // `AND source = ANY(...)` shape doesn't apply here. The equivalent is
  // applied at the offer level instead: only offers from an active provider
  // are returned or counted, an event is only listed if it still has at
  // least one such offer, and its best price is ranked among those offers
  // only. ACTIVE_SOURCES itself is imported and reused directly — the
  // decision about WHICH sources are visible still lives in exactly one
  // place. Currently null (inert), in which case none of this is emitted at
  // all and the precomputed ce.best_price / ce.offer_count columns are used
  // as-is; re-enabling it swaps in the equivalent per-offer subqueries.
  let activeSourcesParam = null;
  if (ACTIVE_SOURCES) {
    activeSourcesParam = paramCount;
    params.push(ACTIVE_SOURCES);
    paramCount++;
  }
  const offerSourceCondition = activeSourcesParam ? ` AND p.name = ANY($${activeSourcesParam}::text[])` : '';

  // best_price on canonical_events is computed by the rebuild from exactly
  // the same rules the live merge uses (lowest non-null min_price, excluding
  // 'official' rows) — verified in services/canonicalize.js — so it is the
  // canonical-layer equivalent of the raw path's own best-price computation
  // and can be filtered/sorted on directly. Only when ACTIVE_SOURCES hides a
  // provider does that precomputed value stop being the right answer (it
  // would still rank a hidden provider's offer as the winner), so in that
  // case only, it's recomputed per event over the visible offers.
  const bestPriceSql = activeSourcesParam
    ? `(SELECT MIN(o.price) FROM ticket_offers o JOIN providers p ON p.id = o.provider_id
        WHERE o.canonical_event_id = ce.id AND o.price IS NOT NULL AND p.name <> 'official'${offerSourceCondition})`
    : 'ce.best_price';

  // Retailer count, used by the default ordering rule below. Precomputed by
  // the rebuild as the number of DISTINCT providers on the event (matching
  // what the live merge's offers.length counts, since that merge collapses
  // several rows from one source into a single offer); recomputed per event
  // only when ACTIVE_SOURCES is restricting which providers count.
  const offerCountSql = activeSourcesParam
    ? `(SELECT COUNT(DISTINCT p.name) FROM ticket_offers o JOIN providers p ON p.id = o.provider_id
        WHERE o.canonical_event_id = ce.id${offerSourceCondition})`
    : 'ce.offer_count';

  // Past events are excluded unconditionally, same as the raw path — see
  // that function's comment for why this is not tied to startDate.
  // primary_event_row_id IS NOT NULL is additionally required because that
  // column IS the `id` this endpoint returns: an event whose representative
  // raw row has since been deleted (the FK is ON DELETE SET NULL) has no
  // stable id to link to, so it cannot be rendered as a card anyway.
  let whereClause = ' WHERE ce.event_date >= NOW() AND ce.primary_event_row_id IS NOT NULL';

  if (country) {
    whereClause += ` AND ce.country = $${paramCount}`;
    params.push(country);
    paramCount++;
  }

  if (state) {
    whereClause += ` AND ce.state = $${paramCount}`;
    params.push(state);
    paramCount++;
  }

  if (city) {
    whereClause += ` AND ce.city = $${paramCount}`;
    params.push(city);
    paramCount++;
  }

  // Free-text "Location" filter box — partial, case-insensitive, across
  // city/state/venue, exactly as on the raw path.
  if (location) {
    whereClause += ` AND (ce.city ILIKE $${paramCount} OR ce.state ILIKE $${paramCount} OR ce.venue_name ILIKE $${paramCount})`;
    params.push(`%${location}%`);
    paramCount++;
  }

  // category / keywords keep the raw path's exact structure, including the
  // crucial detail that the two are OR'd together rather than AND'd when a
  // single tile sets both (e.g. "Theater & Comedy" = category 'Arts &
  // Theatre' OR keyword 'Comedy') — see the long comment on the raw path for
  // why ANDing them silently emptied those tiles.
  let categorySql = '';
  if (category) {
    const categoryList = category.split(',').map((c) => c.trim()).filter(Boolean);
    if (categoryList.length > 0) {
      categorySql = `ce.category = ANY($${paramCount}::text[])`;
      params.push(categoryList);
      paramCount++;
    }
  }

  // Word-boundary (\m...\M) regex matching, same as the raw path, so a short
  // league acronym like "NFL" can't match inside "Inflatable"; matched
  // against category too, since a game's title is usually just the matchup.
  let keywordsSql = '';
  if (keywords) {
    const keywordList = keywords.split(',').map((k) => k.trim()).filter(Boolean);
    if (keywordList.length > 0) {
      const orParts = keywordList.map((_, i) => {
        const p = paramCount + i;
        return `(ce.title ~* $${p} OR ce.artist_name ~* $${p} OR ce.venue_name ~* $${p} OR ce.category ~* $${p})`;
      });
      keywordsSql = `(${orParts.join(' OR ')})`;
      keywordList.forEach((kw) => params.push(`\\m${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\M`));
      paramCount += keywordList.length;
    }
  }

  const categoryOrKeywordsParts = [categorySql, keywordsSql].filter(Boolean);
  if (categoryOrKeywordsParts.length > 0) {
    whereClause += ` AND (${categoryOrKeywordsParts.join(' OR ')})`;
  }

  if (startDate) {
    whereClause += ` AND ce.event_date >= $${paramCount}`;
    params.push(new Date(startDate));
    paramCount++;
  }

  if (endDate) {
    whereClause += ` AND ce.event_date <= $${paramCount}`;
    params.push(new Date(endDate));
    paramCount++;
  }

  if (search) {
    whereClause += ` AND (ce.title ILIKE $${paramCount} OR ce.artist_name ILIKE $${paramCount} OR ce.venue_name ILIKE $${paramCount})`;
    params.push(`%${search}%`);
    paramCount++;
  }

  // minPrice/maxPrice compare against the event's BEST price across sources
  // — same semantics as the raw path's post-merge JS filter (an event isn't
  // excluded because one source's offer is out of range while a cheaper one
  // is in range), except it's now a real indexed WHERE on a real column
  // rather than a filter applied to 30,000 already-fetched rows.
  if (minPrice) {
    const min = parseFloat(minPrice);
    if (Number.isFinite(min)) {
      whereClause += ` AND ${bestPriceSql} >= $${paramCount}`;
      params.push(min);
      paramCount++;
    }
  }
  if (maxPrice) {
    const max = parseFloat(maxPrice);
    if (Number.isFinite(max)) {
      whereClause += ` AND ${bestPriceSql} <= $${paramCount}`;
      params.push(max);
      paramCount++;
    }
  }

  if (excludeIdList.length > 0) {
    whereClause += ` AND ce.primary_event_row_id != ALL($${paramCount}::int[])`;
    params.push(excludeIdList);
    paramCount++;
  }

  // PERMANENT (see config/priceVisibility.js): never list an event with no
  // tickets actually for sale. appendPricedOnlyFilter's raw-row test is
  // `min_price IS NOT NULL OR max_price IS NOT NULL` on a single source row;
  // the canonical-layer equivalent is "this event has a usable best price
  // from at least one real seller". NOTE the two are not exactly identical
  // at the edges: a row whose ONLY price data is max_price, or whose only
  // priced offer is an 'official' row, passed the raw test but has a NULL
  // best_price here and is therefore now hidden. That is a stricter reading
  // of the same rule (neither case gives a visitor a real, comparable price
  // to click through on), and both are vanishingly rare — the 'official'
  // scraper no longer runs at all — but it is a real behavior difference and
  // is called out here deliberately.
  whereClause += ` AND ${bestPriceSql} IS NOT NULL`;

  // Distance from the customer, via the same Haversine expression the raw
  // path uses — copied verbatim apart from the ce. qualification, so an
  // event's reported distance_km can't drift between the two code paths.
  // Events without stored coordinates come back NULL and sort last rather
  // than being excluded.
  let distanceSelect = '';
  if (hasLocation) {
    distanceSelect = `, (
           CASE WHEN ce.latitude IS NULL OR ce.longitude IS NULL THEN NULL ELSE
             6371 * acos(
               LEAST(1, GREATEST(-1,
                 cos(radians($${paramCount})) * cos(radians(ce.latitude)) * cos(radians(ce.longitude) - radians($${paramCount + 1}))
                 + sin(radians($${paramCount})) * sin(radians(ce.latitude))
               ))
             )
           END
         ) AS distance_km`;
  }

  // Ordering, translated clause for clause from applyLocationRetailerOrder
  // (the default) and compareEvents (an explicit ?sort=), including their
  // null handling: every one of those comparators sorts missing data LAST
  // regardless of direction, which is NULLS LAST in both ASC and DESC here
  // (Postgres's own default is NULLS LAST for ASC but NULLS FIRST for DESC,
  // so the DESC cases must say so explicitly).
  //
  // Each entry is [inner, outer]: the inner form runs inside the subquery
  // that does the actual LIMIT/OFFSET (where `ce` and the select aliases are
  // in scope), and the identical outer form is re-applied on the final
  // result of the offers join. Repeating it is not redundant — a subquery's
  // ordering is not guaranteed to survive being joined to, so the outer
  // ORDER BY is what actually guarantees the response order.
  const orderSpecs = [];
  if (!sort) {
    // Standing rule for every default listing view: closest first (strictly,
    // across all retailers), then — only among events at the exact same
    // distance — the ones listed by more retailers, then soonest.
    if (hasLocation) orderSpecs.push(['distance_km ASC NULLS LAST', 'page.distance_km ASC NULLS LAST']);
    orderSpecs.push(['offer_count DESC', 'page.offer_count DESC']);
    orderSpecs.push(['ce.event_date ASC', 'page."date" ASC']);
  } else if (effectiveSort === 'distance' && hasLocation) {
    orderSpecs.push(['distance_km ASC NULLS LAST', 'page.distance_km ASC NULLS LAST']);
  } else if (effectiveSort === 'price-low') {
    orderSpecs.push(['sort_best_price ASC NULLS LAST', 'page.sort_best_price ASC NULLS LAST']);
  } else if (effectiveSort === 'price-high') {
    orderSpecs.push(['sort_best_price DESC NULLS LAST', 'page.sort_best_price DESC NULLS LAST']);
  } else if (effectiveSort === 'name') {
    orderSpecs.push(['ce.title ASC', 'page.title ASC']);
  } else {
    // 'date', an unrecognized sort value, or ?sort=distance with no
    // coordinates — all of which the JS comparator resolved to (or degraded
    // into) plain date-ascending.
    orderSpecs.push(['ce.event_date ASC', 'page."date" ASC']);
  }
  // Deterministic final tiebreak. The JS comparators returned 0 for ties and
  // relied on the surrounding array's incidental order, which was harmless
  // when the whole result set was sorted in one go — but with real
  // LIMIT/OFFSET, two rows that tie under an unstable sort can appear on
  // both page 1 and page 2 (or on neither), so the ordering has to be a
  // total order. canonical_events.id is used purely as that tiebreak and is
  // never exposed in the response.
  orderSpecs.push(['ce.id ASC', 'page.canonical_event_id ASC']);
  const innerOrderBy = orderSpecs.map(([inner]) => inner).join(', ');
  const outerOrderBy = orderSpecs.map(([, outer]) => outer).join(', ');

  const listParams = [...params];
  if (hasLocation) {
    listParams.push(customerLat, customerLng);
    paramCount += 2;
  }
  const limitParam = paramCount;
  const offsetParam = paramCount + 1;
  listParams.push(effectiveLimit, effectiveOffset);

  // The select list is deliberately explicit rather than `ce.*`, so that the
  // response's field set is auditable against what the raw path returned
  // (which was the whole `events` row spread out). Mapping, raw column ->
  // canonical column: id -> primary_event_row_id (a real, stable events.id —
  // canonical_events.id must NEVER be exposed as `id`, it is reassigned on
  // every rebuild), date -> event_date. external_id/source/source_url are
  // re-attached in JS below from the primary row's own offer, since those
  // are per-source values that live on ticket_offers here. created_at/
  // updated_at are the CANONICAL row's timestamps (when the derived layer
  // was last rebuilt), not the raw row's — the fields are still present so
  // nothing breaks, but nothing in the frontend reads them.
  const query = `
    SELECT page.*, COALESCE(offer_list.offers, '[]'::json) AS offers
    FROM (
      SELECT
        ce.id AS canonical_event_id,
        ce.primary_event_row_id AS id,
        ce.title,
        ce.description,
        ce.category,
        ce.event_date AS "date",
        ce.country,
        ce.state,
        ce.city,
        ce.venue_name,
        ce.venue_address,
        ce.image_url,
        ce.artist_name,
        ce.latitude,
        ce.longitude,
        ce.price_breakdown,
        ce.created_at,
        ce.updated_at,
        ${offerCountSql} AS offer_count,
        ${bestPriceSql} AS sort_best_price${distanceSelect}
      FROM canonical_events ce
      ${whereClause}
      ORDER BY ${innerOrderBy}
      LIMIT $${limitParam} OFFSET $${offsetParam}
    ) page
    LEFT JOIN LATERAL (
      SELECT json_agg(json_build_object(
        'event_row_id', d.source_event_row_id,
        'external_id', d.provider_offer_id,
        'source', d.source,
        'source_url', d.seller_url,
        'min_price', d.price::text,
        'max_price', d.max_price::text,
        'currency', d.currency
      )) AS offers
      FROM (
        -- One offer per SOURCE, not per ticket_offers row. The live merge
        -- collapses two rows from the same seller (e.g. the same
        -- TicketNetwork performance listed under two external_ids) into a
        -- single offer, keeping whichever has a real price, and the lower
        -- one when both do — otherwise a card renders
        -- "ticketnetwork from $X · ticketnetwork from $X". The rebuild
        -- stores every such row as its own ticket_offers row, so that same
        -- collapse is reproduced here with DISTINCT ON + the matching
        -- ordering (priced rows first, then cheapest).
        SELECT DISTINCT ON (p.name)
          p.name AS source,
          o.source_event_row_id,
          o.provider_offer_id,
          o.seller_url,
          o.price,
          o.max_price,
          o.currency
        FROM ticket_offers o
        JOIN providers p ON p.id = o.provider_id
        WHERE o.canonical_event_id = page.canonical_event_id${offerSourceCondition}
        ORDER BY p.name, (o.price IS NULL) ASC, o.price ASC
      ) d
    ) offer_list ON TRUE
    ORDER BY ${outerOrderBy}
  `;

  // `total` comes from a COUNT over the identical WHERE rather than the old
  // `merged.length` (which was only ever the length of whatever fit under
  // MAX_RAW_ROWS). Run alongside the page query rather than after it — they
  // are independent, and both hit the same index.
  const countQuery = `SELECT COUNT(*)::int AS total FROM canonical_events ce ${whereClause}`;

  const [pageResult, countResult] = await Promise.all([
    pool.query(query, listParams),
    pool.query(countQuery, params),
  ]);

  const total = countResult.rows[0] ? countResult.rows[0].total : 0;

  const events = pageResult.rows.map((row) => {
    // canonical_event_id / offer_count / sort_best_price are internal
    // bookkeeping for the query above and are stripped before responding —
    // canonical_event_id in particular must never leak out, since it is
    // reassigned by every rebuild.
    const { canonical_event_id, offer_count, sort_best_price, offers, ...rest } = row;
    const event = { ...rest, offers: offers || [] };

    // The raw path spread the PRIMARY row into the response, so these three
    // top-level fields carried that one row's source identity (the frontend
    // only uses them as a legacy fallback when `offers` is absent, but they
    // are part of the response shape). Here they are read back off the
    // offer belonging to the primary row.
    const primaryOffer = event.offers.find((o) => o.event_row_id === event.id) || null;
    event.external_id = primaryOffer ? primaryOffer.external_id : null;
    event.source = primaryOffer ? primaryOffer.source : null;
    event.source_url = primaryOffer ? primaryOffer.source_url : null;

    // Defaults for the (now impossible, given the best-price filter above,
    // but cheap to guarantee) case of an event that came back with no usable
    // offers at all — keeps the response shape stable rather than omitting
    // the keys entirely.
    event.min_price = null;
    event.max_price = null;
    applyPriceComparisonFields(event);
    return event;
  });

  res.json({
    events,
    total,
    limit: effectiveLimit,
    offset: effectiveOffset,
    hasMore: (effectiveOffset + effectiveLimit) < total,
  });
}

// The original implementation, preserved unchanged as the safety net
// described above. Everything here operates on the raw `events` table and
// merges in memory; see MAX_RAW_ROWS at the top of this file for its limits.
async function listEventsFromRawEventsTable(req, res) {
  try {
    const { city, state, country, category, keywords, minPrice, maxPrice, startDate, endDate, search, location, sort, lat, lng, limit = 20, offset = 0, excludeIds } = req.query;

    // Every event should be listed in only one homepage section. The
    // frontend collects the ids already shown in the discover carousels
    // (Popular/Recommended/Trending/by-category — see routes/events.js's
    // /discover, which dedups those against each other server-side) and
    // sends them here so the Featured Events grid ("All" and every
    // category tile) never repeats one of those events.
    const excludeIdSet = new Set(
      (excludeIds || '')
        .split(',')
        .map((id) => parseInt(id, 10))
        .filter((id) => Number.isInteger(id))
    );

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
    // rows that different data sources labeled differently. Built as a
    // standalone SQL fragment (not appended to whereClause directly) so it
    // can be OR'd with `keywords` below instead of AND'd with it — see that
    // block's comment for why (a merged tile like "Theater & Comedy" needs
    // "in the Arts & Theatre category OR mentions Comedy", not both at once).
    let categorySql = '';
    if (category) {
      const categoryList = category.split(',').map((c) => c.trim()).filter(Boolean);
      if (categoryList.length > 0) {
        categorySql = `category = ANY($${paramCount}::text[])`;
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
    //
    // Built as a standalone fragment, same as categorySql above, and then
    // OR'd with it rather than AND'd: a category tile can set EITHER field
    // alone (e.g. Concerts sets only category, NFL sets only keywords —
    // those behave exactly as before, since OR-ing a single non-empty
    // fragment with nothing is a no-op) or BOTH at once for a merged tile
    // like "Theater & Comedy" (category ['Arts & Theatre'] OR keywords
    // ['Comedy', ...]) — ANDing those together would have wrongly required
    // an event to be in Arts & Theatre AND also mention "comedy" by name,
    // which would have dropped plain theater shows and any comedy event
    // filed under a different category.
    let keywordsSql = '';
    if (keywords) {
      const keywordList = keywords.split(',').map((k) => k.trim()).filter(Boolean);
      if (keywordList.length > 0) {
        const orParts = keywordList.map((_, i) => {
          const p = paramCount + i;
          return `(title ~* $${p} OR artist_name ~* $${p} OR venue_name ~* $${p} OR category ~* $${p})`;
        });
        keywordsSql = `(${orParts.join(' OR ')})`;
        keywordList.forEach((kw) => params.push(`\\m${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\M`));
        paramCount += keywordList.length;
      }
    }

    const categoryOrKeywordsParts = [categorySql, keywordsSql].filter(Boolean);
    if (categoryOrKeywordsParts.length > 0) {
      whereClause += ` AND (${categoryOrKeywordsParts.join(' OR ')})`;
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

    if (excludeIdSet.size > 0) {
      merged = merged.filter((e) => !excludeIdSet.has(e.id));
    }

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
}

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
// "Sports" bucket was replaced with dedicated nfl/nba/nhl/mlb/mls/
// ncaaFootball rules (matching the tiles' own keyword lists exactly) so
// the homepage sections split sports the same way the tiles do, rather than
// lumping every sport into one catch-all section.
const DISCOVER_CATEGORY_RULES = {
  nfl: { categories: [], keywords: ['NFL'] },
  concerts: { categories: ['Music', 'Concert'], keywords: [] },
  nba: { categories: [], keywords: ['NBA', 'Basketball'] },
  nhl: { categories: [], keywords: ['NHL', 'Hockey'] },
  mlb: { categories: [], keywords: ['MLB', 'Baseball'] },
  mls: { categories: [], keywords: ['MLS', 'Soccer'] },
  boxing: { categories: [], keywords: ['Boxing'] },
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

    // Every event should be listed in only one homepage section — never
    // repeated across Popular/Recommended/Trending/NFL/Concerts/NBA/NCAA
    // Football/Theater/Comedy. `usedIds` tracks every id already claimed by
    // an earlier (higher-priority) section so later sections pick from
    // what's left; `takeUnused`/`markUsed` are small helpers around that.
    // Priority follows the order these sections appear on the page: Popular
    // > Recommended > Trending > NFL > Concerts > NBA > NCAA Football >
    // Theater > Comedy. (The Featured Events grid further down the page is
    // the true catch-all — it excludes everything claimed here via its own
    // `excludeIds` param, see routes/events.js's GET '/' handler.)
    const usedIds = new Set();
    const takeUnused = (list) => list.filter((e) => !usedIds.has(e.id));
    const markUsed = (list) => { for (const e of list) usedIds.add(e.id); };

    // ---- Popular Events: click_count first, soonest as a tiebreak; only
    // events with at least one real click count as "popular" — backfilled
    // with the soonest nearby upcoming events to reach 5 when click data is
    // thin (e.g. a brand-new platform or region). ----
    const popularCandidates = takeUnused(merged);
    const popularSorted = popularCandidates.slice().sort((a, b) => {
      if (b.click_count !== a.click_count) return b.click_count - a.click_count;
      return new Date(a.date) - new Date(b.date);
    });
    const popularPicked = backfillByDate(
      popularSorted.filter((e) => e.click_count > 0).slice(0, DISCOVER_SECTION_COUNT),
      popularCandidates,
      DISCOVER_SECTION_COUNT
    );
    // Standing ordering rule applies to this section too: click_count only
    // decides WHICH events qualify as "popular"; once that set is picked,
    // present them closest-first / most-retailers-first / retailer-round-
    // robin, same as every category row.
    const popular = applyLocationRetailerOrder(popularPicked, hasCoords);
    markUsed(popular);

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
    const recommendedCandidates = takeUnused(merged);
    const recommendedPicked = backfillByDate(
      pickDiverse(recommendedCandidates, DISCOVER_SECTION_COUNT),
      recommendedCandidates,
      DISCOVER_SECTION_COUNT
    );
    // Same standing ordering rule applied on top of the recommended
    // selection — pickDiverse/backfillByDate still decide WHICH events make
    // the cut (score + category diversity), this only decides the order
    // they're displayed in.
    const recommended = applyLocationRetailerOrder(recommendedPicked, hasCoords);
    markUsed(recommended);

    // ---- Trending Events Near [City]: recent (7-day) click velocity, same
    // backfill approach as Popular. ----
    const trendingCandidates = takeUnused(merged);
    const trendingSorted = trendingCandidates.slice().sort((a, b) => {
      if (b.recent_click_count !== a.recent_click_count) return b.recent_click_count - a.recent_click_count;
      if (b.click_count !== a.click_count) return b.click_count - a.click_count;
      return new Date(a.date) - new Date(b.date);
    });
    const trendingPicked = backfillByDate(
      trendingSorted.filter((e) => e.recent_click_count > 0).slice(0, DISCOVER_SECTION_COUNT),
      trendingCandidates,
      DISCOVER_SECTION_COUNT
    );
    // Same standing ordering rule applied on top of the trending selection.
    const trending = applyLocationRetailerOrder(trendingPicked, hasCoords);
    markUsed(trending);

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
    //
    // Processing order for the cross-section dedup below is deliberately
    // NOT DISCOVER_CATEGORY_RULES' own key order. A rule matched by a
    // specific KEYWORD (nfl/nba/ncaaFootball/comedy — the title, artist, or
    // venue actually names that thing) is a much more confident match than
    // a rule matched only by the generic `category` column (concerts/
    // theater — e.g. Ticketmaster's broad "Arts & Theatre" segment covers
    // comedy, dance, opera, and more, not just theater). A real comedy show
    // filed under "Arts & Theatre" matches BOTH the Theater rule (by
    // category) and the Comedy rule (by keyword) — without this ordering,
    // whichever rule's turn came first in DISCOVER_CATEGORY_RULES claimed
    // it via the dedup below regardless of which one actually fits, which
    // is how "Comedy Juice" (a real comedy show 35km away) ended up
    // classified under Theater and pushed out of Comedy, leaving Comedy to
    // show a 1500km+ event as its "closest". Keyword rules go first so the
    // more specific match always wins the event.
    const categoryProcessingOrder = Object.keys(DISCOVER_CATEGORY_RULES).sort((a, b) => {
      const aHasKeywords = DISCOVER_CATEGORY_RULES[a].keywords.length > 0;
      const bHasKeywords = DISCOVER_CATEGORY_RULES[b].keywords.length > 0;
      if (aHasKeywords === bHasKeywords) return 0;
      return aHasKeywords ? -1 : 1;
    });
    const categories = {};
    for (const key of categoryProcessingOrder) {
      const rule = DISCOVER_CATEGORY_RULES[key];
      const rawRows = await fetchDiscoverCandidates(pool, { lat, lng, categoryRule: rule, limitRaw: 400 });
      const mergedCategory = mergeEventsAcrossSources(rawRows);
      await attachClickCounts(pool, mergedCategory);
      // Same cross-section dedup as Popular/Recommended/Trending above:
      // skip anything already claimed by a higher-priority section (NFL >
      // Concerts > NBA > NCAA Football > Theater > Comedy, in that order —
      // matching the loop's own key order in DISCOVER_CATEGORY_RULES).
      const categoryCandidates = takeUnused(mergedCategory);
      // Standing per-category ordering rule (see applyLocationRetailerOrder
      // above): closest first, then more-retailers-first among those, then
      // round-robin by retailer so the row doesn't cluster on one seller.
      const ordered = applyLocationRetailerOrder(categoryCandidates, hasCoords);
      categories[key] = ordered.slice(0, DISCOVER_SECTION_COUNT);
      markUsed(categories[key]);
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
