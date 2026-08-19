import express from 'express';
import { pool } from '../index.js';
import { verifyToken, getUserInfo } from '../middleware/auth.js';

const router = express.Router();

// Get User Orders
router.get('/', verifyToken, getUserInfo, async (req, res) => {
  try {
    const userId = req.userId;
    const { limit = 20, offset = 0, status } = req.query;

    let query = `
      SELECT o.*, e.title as event_title, e.date as event_date, e.city, e.state,
             gt.ticket_number
      FROM orders o
      JOIN events e ON o.event_id = e.id
      LEFT JOIN generated_tickets gt ON o.id = gt.order_id
      WHERE o.user_id = $1
    `;

    const params = [userId];
    let paramCount = 2;

    if (status) {
      query += ` AND o.status = $${paramCount}`;
      params.push(status);
      paramCount++;
    }

    query += ` ORDER BY o.created_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);

    res.json({
      orders: result.rows,
      total: result.rows.length,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// Get Order Details
router.get('/:orderId', verifyToken, getUserInfo, async (req, res) => {
  try {
    const { orderId } = req.params;
    const userId = req.userId;

    const result = await pool.query(
      `SELECT o.*, e.title, e.date, e.venue_name, e.city, e.state,
              gt.ticket_number, gt.ticket_qr_code, p.status as payment_status
       FROM orders o
       JOIN events e ON o.event_id = e.id
       LEFT JOIN generated_tickets gt ON o.id = gt.order_id
       LEFT JOIN payments p ON o.id = p.order_id
       WHERE o.id = $1 AND o.user_id = $2`,
      [orderId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json({ order: result.rows[0] });
  } catch (error) {
    console.error('Error fetching order:', error);
    res.status(500).json({ error: 'Failed to fetch order' });
  }
});

// Download Ticket PDF
router.get('/:orderId/download-ticket', verifyToken, async (req, res) => {
  try {
    const { orderId } = req.params;
    const userId = req.userId;

    const result = await pool.query(
      'SELECT ticket_pdf_url FROM generated_tickets WHERE order_id = $1',
      [orderId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    // In production, redirect to cloud storage or serve file
    const ticketUrl = result.rows[0].ticket_pdf_url;
    res.json({ ticketUrl });
  } catch (error) {
    res.status(500).json({ error: 'Failed to download ticket' });
  }
});

// Cancel Order (within cancellation window)
router.post('/:orderId/cancel', verifyToken, getUserInfo, async (req, res) => {
  try {
    const { orderId } = req.params;
    const userId = req.userId;

    const orderResult = await pool.query(
      'SELECT * FROM orders WHERE id = $1 AND user_id = $2',
      [orderId, userId]
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orderResult.rows[0];
    const eventDate = new Date(order.event_date);
    const daysUntilEvent = (eventDate - new Date()) / (1000 * 60 * 60 * 24);

    // Can only cancel if more than 7 days before event
    if (daysUntilEvent < 7) {
      return res.status(400).json({ error: 'Cannot cancel within 7 days of event' });
    }

    // Update order status
    await pool.query(
      'UPDATE orders SET status = $1 WHERE id = $2',
      ['cancelled', orderId]
    );

    // Mark ticket as available again
    await pool.query(
      'UPDATE tickets SET is_sold = false WHERE id = $1',
      [order.ticket_id]
    );

    res.json({ message: 'Order cancelled successfully' });
  } catch (error) {
    console.error('Error cancelling order:', error);
    res.status(500).json({ error: 'Failed to cancel order' });
  }
});

export default router;
