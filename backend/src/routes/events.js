import express from 'express';
import { pool } from '../index.js';
import { isSameEvent } from '../utils/matching.js';

const router = express.Router();

// Safety cap on how many raw rows (pre-merge, across all sources) a single
// request will fetch before merging/sorting/paginating in memory. The full
// events table is a few thousand rows, so this comfortably covers real
// traffic while bounding worst-case query cost if a filter is very loose.
const MAX_RAW_ROWS = 5000;

// Merge rows that represent the same real-world event (per isSameEvent)
// into a single card with one `offers` entry per source — the actual
// price-comparison feature. Preserves row order otherwise (each group's
// position is wherever its first-seen row was).
function mergeEventsAcrossSources(rows) {
  const merged = [];
  for (const row of rows) {
    const offer = {
      source: row.source,
      source_url: row.source_url,
      min_price: row.min_price,
      max_price: row.max_price,
      currency: row.currency,
    };

    const match = merged.find((m) => isSameEvent(m, row));
    if (match) {
      match.offers.push(offer);
      // Backfill anything the primary row is missing from this duplicate.
      if (!match.image_url && row.image_url) match.image_url = row.image_url;
      if (!match.artist_name && row.artist_name) match.artist_name = row.artist_name;
      if (!match.description && row.description) match.description = row.description;
      if (match.distance_km == null && row.distance_km != null) match.distance_km = row.distance_km;
    } else {
      merged.push({ ...row, offers: [offer] });
    }
  }

  // Compute the best (lowest) price across offers and flag its source, so
  // the UI can badge it. Also mirror it onto the existing top-level
  // min_price/max_price fields for backward compatibility with anything
  // still reading those directly.
  for (const event of merged) {
    const priced = event.offers.filter((o) => o.min_price != null);
    if (priced.length > 0) {
      const best = priced.reduce((a, b) => (Number(a.min_price) <= Number(b.min_price) ? a : b));
      event.best_price = best.min_price;
      event.best_source = best.source;
      event.min_price = best.min_price;
      event.max_price = best.max_price;
    } else {
      event.best_price = null;
      event.best_source = null;
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

    let whereClause = ' WHERE 1=1';
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
    if (keywords) {
      const keywordList = keywords.split(',').map((k) => k.trim()).filter(Boolean);
      if (keywordList.length > 0) {
        const orParts = keywordList.map((_, i) => {
          const p = paramCount + i;
          return `(title ~* $${p} OR artist_name ~* $${p} OR venue_name ~* $${p})`;
        });
        whereClause += ` AND (${orParts.join(' OR ')})`;
        keywordList.forEach((kw) => params.push(`\\m${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\M`));
        paramCount += keywordList.length;
      }
    }

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

    merged.sort((a, b) => compareEvents(a, b, effectiveSort));

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

// Get Single Event
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

// Search Events (Enhanced)
router.get('/search/advanced', async (req, res) => {
  try {
    const { q, country = 'USA' } = req.query;

    const result = await pool.query(
      `SELECT DISTINCT city, state FROM events 
       WHERE country = $1 AND (title ILIKE $2 OR city ILIKE $2 OR state ILIKE $2)
       LIMIT 20`,
      [country, `%${q}%`]
    );

    res.json({ results: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Search failed' });
  }
});

export default router;
