import express from 'express';
import { pool } from '../index.js';
import { verifyToken, getUserInfo } from '../middleware/auth.js';

const router = express.Router();

// Get All Events with Filters
router.get('/', async (req, res) => {
  try {
    const { city, state, country, category, minPrice, maxPrice, startDate, endDate, search, sort = 'date', limit = 20, offset = 0 } = req.query;

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

    if (category) {
      whereClause += ` AND category = $${paramCount}`;
      params.push(category);
      paramCount++;
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

    // Count matching rows (same filters, no limit/offset) so pagination reflects the actual result set.
    const countResult = await pool.query(`SELECT COUNT(*) FROM events${whereClause}`, params);
    const total = parseInt(countResult.rows[0].count);

    // Sorting
    let query = `SELECT * FROM events${whereClause}`;
    if (sort === 'price-low') {
      query += ' ORDER BY min_price ASC';
    } else if (sort === 'price-high') {
      query += ' ORDER BY min_price DESC';
    } else if (sort === 'name') {
      query += ' ORDER BY title ASC';
    } else {
      query += ' ORDER BY date ASC';
    }

    // Pagination
    query += ` LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    const listParams = [...params, parseInt(limit), parseInt(offset)];

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
