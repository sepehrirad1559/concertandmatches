import express from 'express';
import { pool } from '../index.js';
import { verifyToken, getUserInfo } from '../middleware/auth.js';

const router = express.Router();

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

    if (minPrice) {
      whereClause += ` AND min_price >= $${paramCount}`;
      params.push(parseFloat(minPrice));
      paramCount++;
    }

    if (maxPrice) {
      whereClause += ` AND max_price <= $${paramCount}`;
      params.push(parseFloat(maxPrice));
      paramCount++;
    }

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

    // Count matching rows (same filters, no limit/offset) so pagination reflects the actual result set.
    const countResult = await pool.query(`SELECT COUNT(*) FROM events${whereClause}`, params);
    const total = parseInt(countResult.rows[0].count);

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

    let query = `${selectClause}${whereClause}`;
    if (effectiveSort === 'distance' && hasLocation) {
      query += ' ORDER BY distance_km ASC NULLS LAST';
    } else if (effectiveSort === 'price-low') {
      query += ' ORDER BY min_price ASC';
    } else if (effectiveSort === 'price-high') {
      query += ' ORDER BY min_price DESC';
    } else if (effectiveSort === 'name') {
      query += ' ORDER BY title ASC';
    } else {
      query += ' ORDER BY date ASC';
    }

    // Pagination
    query += ` LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    listParams.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, listParams);

    res.json({
      events: result.rows,
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

    const ticketsResult = await pool.query(
      'SELECT * FROM tickets WHERE event_id = $1 AND is_sold = false ORDER BY price ASC LIMIT 50',
      [eventId]
    );

    res.json({
      event: eventResult.rows[0],
      availableTickets: ticketsResult.rows,
      ticketsCount: ticketsResult.rows.length
    });
  } catch (error) {
    console.error('Error fetching event:', error);
    res.status(500).json({ error: 'Failed to fetch event' });
  }
});

// Save Event (Watchlist)
router.post('/:eventId/save', verifyToken, getUserInfo, async (req, res) => {
  try {
    const { eventId } = req.params;
    const userId = req.userId;

    // Check if event exists
    const eventResult = await pool.query('SELECT id FROM events WHERE id = $1', [eventId]);
    if (eventResult.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }

    // Check if already saved
    const savedResult = await pool.query(
      'SELECT id FROM saved_events WHERE user_id = $1 AND event_id = $2',
      [userId, eventId]
    );

    if (savedResult.rows.length > 0) {
      return res.status(400).json({ error: 'Event already saved' });
    }

    // Save event
    await pool.query(
      'INSERT INTO saved_events (user_id, event_id) VALUES ($1, $2)',
      [userId, eventId]
    );

    res.json({ message: 'Event saved successfully' });
  } catch (error) {
    console.error('Error saving event:', error);
    res.status(500).json({ error: 'Failed to save event' });
  }
});

// Get Saved Events
router.get('/user/saved', verifyToken, getUserInfo, async (req, res) => {
  try {
    const userId = req.userId;

    const result = await pool.query(
      `SELECT e.* FROM events e
       INNER JOIN saved_events se ON e.id = se.event_id
       WHERE se.user_id = $1
       ORDER BY e.date ASC`,
      [userId]
    );

    res.json({ savedEvents: result.rows });
  } catch (error) {
    console.error('Error fetching saved events:', error);
    res.status(500).json({ error: 'Failed to fetch saved events' });
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
