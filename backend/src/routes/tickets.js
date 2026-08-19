import express from 'express';
import { pool } from '../index.js';

const router = express.Router();

// Get Tickets for Event
router.get('/event/:eventId', async (req, res) => {
  try {
    const { eventId } = req.params;
    const { minPrice, maxPrice, seatType } = req.query;

    let query = 'SELECT * FROM tickets WHERE event_id = $1 AND is_sold = false';
    const params = [eventId];
    let paramCount = 2;

    if (minPrice) {
      query += ` AND price >= $${paramCount}`;
      params.push(parseFloat(minPrice));
      paramCount++;
    }

    if (maxPrice) {
      query += ` AND price <= $${paramCount}`;
      params.push(parseFloat(maxPrice));
      paramCount++;
    }

    if (seatType) {
      query += ` AND ticket_type = $${paramCount}`;
      params.push(seatType);
      paramCount++;
    }

    query += ' ORDER BY price ASC';

    const result = await pool.query(query, params);

    res.json({
      tickets: result.rows,
      total: result.rows.length
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch tickets' });
  }
});

// Get Ticket Details
router.get('/:ticketId', async (req, res) => {
  try {
    const { ticketId } = req.params;

    const result = await pool.query(
      'SELECT * FROM tickets WHERE id = $1',
      [ticketId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    res.json({ ticket: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch ticket' });
  }
});

export default router;
