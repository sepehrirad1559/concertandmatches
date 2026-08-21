import express from 'express';
import { pool } from '../index.js';
import { verifyToken, verifyAdmin, getUserInfo } from '../middleware/auth.js';
import { syncSeatGeekEvents } from '../services/seatgeek.js';
import { syncAllEvents as syncTicketmasterEvents } from '../services/ticketmaster.js';

const router = express.Router();

// One-off / manually-triggered data sync endpoints.
// Protected by a shared secret (SYNC_SECRET_KEY env var) rather than user
// login, since these are meant to be triggered by the site owner directly
// (e.g. via curl) rather than through the regular admin dashboard.
router.post('/sync/seatgeek', async (req, res) => {
  const providedKey = req.headers['x-sync-key'];
  const expectedKey = process.env.SYNC_SECRET_KEY;

  if (!expectedKey) {
    return res.status(503).json({ error: 'SYNC_SECRET_KEY is not configured on the server' });
  }
  if (!providedKey || providedKey !== expectedKey) {
    return res.status(403).json({ error: 'Invalid or missing sync key' });
  }

  const totalWanted = Number(req.query.total) || 300;
  const result = await syncSeatGeekEvents(totalWanted);

  if (!result.success) {
    return res.status(500).json(result);
  }
  res.json(result);
});

router.post('/sync/ticketmaster', async (req, res) => {
  const providedKey = req.headers['x-sync-key'];
  const expectedKey = process.env.SYNC_SECRET_KEY;

  if (!expectedKey) {
    return res.status(503).json({ error: 'SYNC_SECRET_KEY is not configured on the server' });
  }
  if (!providedKey || providedKey !== expectedKey) {
    return res.status(403).json({ error: 'Invalid or missing sync key' });
  }

  const result = await syncTicketmasterEvents();

  if (!result.success) {
    return res.status(500).json(result);
  }
  res.json(result);
});

// One-time schema migration: add venue coordinate columns used to sort
// events by distance from the customer. Safe to call more than once.
router.post('/schema/add-geo-columns', async (req, res) => {
  const providedKey = req.headers['x-sync-key'];
  const expectedKey = process.env.SYNC_SECRET_KEY;

  if (!expectedKey) {
    return res.status(503).json({ error: 'SYNC_SECRET_KEY is not configured on the server' });
  }
  if (!providedKey || providedKey !== expectedKey) {
    return res.status(403).json({ error: 'Invalid or missing sync key' });
  }

  try {
    await pool.query('ALTER TABLE events ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION');
    await pool.query('ALTER TABLE events ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION');
    // price_breakdown holds the full set of ticket price tiers Ticketmaster
    // reports for an event (e.g. Standard vs. VIP), so the event page can
    // list every available price sorted low to high instead of just one
    // min/max range. Null for events with only a single reported range.
    await pool.query('ALTER TABLE events ADD COLUMN IF NOT EXISTS price_breakdown JSONB');
    res.json({ success: true, message: 'latitude/longitude/price_breakdown columns present on events table' });
  } catch (error) {
    console.error('Error adding geo columns:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// One-time cleanup: SeatGeek events synced before the pricing fix have a
// fake $0.00 min/max price (the old code defaulted to 0 instead of leaving
// price unknown as null) baked in from before this fix, and won't get
// corrected by a normal re-sync unless SeatGeek's API happens to return
// that exact event again. This directly clears the fake zeros so the event
// page doesn't show a bogus "$0" price.
router.post('/cleanup/zero-prices', async (req, res) => {
  const providedKey = req.headers['x-sync-key'];
  const expectedKey = process.env.SYNC_SECRET_KEY;
  if (!expectedKey || !providedKey || providedKey !== expectedKey) {
    return res.status(403).json({ error: 'Invalid or missing sync key' });
  }
  try {
    const result = await pool.query(
      `UPDATE events SET min_price = NULL, max_price = NULL
       WHERE source = 'seatgeek' AND min_price = 0 AND max_price = 0`
    );
    res.json({ success: true, cleared: result.rowCount });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Dashboard Stats
router.get('/dashboard', verifyToken, verifyAdmin, getUserInfo, async (req, res) => {
  try {
    // Total Revenue
    const revenueResult = await pool.query(
      `SELECT SUM(total_price) as total_revenue, COUNT(*) as total_orders
       FROM orders WHERE status = 'completed'`
    );

    // Total Users
    const usersResult = await pool.query('SELECT COUNT(*) as total_users FROM users');

    // Total Events
    const eventsResult = await pool.query('SELECT COUNT(*) as total_events FROM events');

    // Recent Orders
    const ordersResult = await pool.query(
      `SELECT o.*, e.title, u.email
       FROM orders o
       JOIN events e ON o.event_id = e.id
       JOIN users u ON o.user_id = u.id
       ORDER BY o.created_at DESC LIMIT 10`
    );

    res.json({
      stats: {
        totalRevenue: revenueResult.rows[0].total_revenue || 0,
        totalOrders: revenueResult.rows[0].total_orders || 0,
        totalUsers: usersResult.rows[0].total_users || 0,
        totalEvents: eventsResult.rows[0].total_events || 0
      },
      recentOrders: ordersResult.rows
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

// Get All Orders (Admin)
router.get('/orders', verifyToken, verifyAdmin, getUserInfo, async (req, res) => {
  try {
    const { limit = 20, offset = 0, status } = req.query;

    let query = `
      SELECT o.*, e.title, u.email, u.first_name
      FROM orders o
      JOIN events e ON o.event_id = e.id
      JOIN users u ON o.user_id = u.id
    `;

    const params = [];
    let paramCount = 1;

    if (status) {
      query += ` WHERE o.status = $${paramCount}`;
      params.push(status);
      paramCount++;
    }

    query += ` ORDER BY o.created_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);
    const countResult = await pool.query(`
      SELECT COUNT(*) FROM orders ${status ? `WHERE status = $1` : ''}
    `, status ? [status] : []);

    res.json({
      orders: result.rows,
      total: parseInt(countResult.rows[0].count)
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// Get All Users (Admin)
router.get('/users', verifyToken, verifyAdmin, getUserInfo, async (req, res) => {
  try {
    const { limit = 20, offset = 0 } = req.query;

    const result = await pool.query(
      `SELECT id, email, first_name, last_name, is_admin, created_at
       FROM users
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [parseInt(limit), parseInt(offset)]
    );

    const countResult = await pool.query('SELECT COUNT(*) FROM users');

    res.json({
      users: result.rows,
      total: parseInt(countResult.rows[0].count)
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Get All Events (Admin)
router.get('/events', verifyToken, verifyAdmin, getUserInfo, async (req, res) => {
  try {
    const { limit = 20, offset = 0 } = req.query;

    const result = await pool.query(
      `SELECT id, title, category, date, city, state, min_price, max_price, created_at
       FROM events
       ORDER BY date DESC
       LIMIT $1 OFFSET $2`,
      [parseInt(limit), parseInt(offset)]
    );

    const countResult = await pool.query('SELECT COUNT(*) FROM events');

    res.json({
      events: result.rows,
      total: parseInt(countResult.rows[0].count)
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

// Get Refund Requests (Admin)
router.get('/refunds', verifyToken, verifyAdmin, getUserInfo, async (req, res) => {
  try {
    const { status = 'pending' } = req.query;

    const result = await pool.query(
      `SELECT r.*, o.order_number, u.email, e.title
       FROM refund_requests r
       JOIN orders o ON r.order_id = o.id
       JOIN users u ON r.user_id = u.id
       JOIN events e ON o.event_id = e.id
       WHERE r.status = $1
       ORDER BY r.created_at DESC`,
      [status]
    );

    res.json({ refunds: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch refund requests' });
  }
});

// Approve Refund (Admin)
router.post('/refunds/:refundId/approve', verifyToken, verifyAdmin, getUserInfo, async (req, res) => {
  try {
    const { refundId } = req.params;

    const refundResult = await pool.query(
      'SELECT * FROM refund_requests WHERE id = $1',
      [refundId]
    );

    if (refundResult.rows.length === 0) {
      return res.status(404).json({ error: 'Refund request not found' });
    }

    const refund = refundResult.rows[0];

    // TODO: Process refund with Stripe
    // await stripe.refunds.create({ charge: chargeId });

    // Update refund status
    await pool.query(
      'UPDATE refund_requests SET status = $1, processed_at = NOW() WHERE id = $2',
      ['approved', refundId]
    );

    // Update order status
    await pool.query(
      'UPDATE orders SET status = $1 WHERE id = $2',
      ['refunded', refund.order_id]
    );

    res.json({ message: 'Refund approved' });
  } catch (error) {
    console.error('Refund approval error:', error);
    res.status(500).json({ error: 'Failed to approve refund' });
  }
});

// Reject Refund (Admin)
router.post('/refunds/:refundId/reject', verifyToken, verifyAdmin, getUserInfo, async (req, res) => {
  try {
    const { refundId } = req.params;

    await pool.query(
      'UPDATE refund_requests SET status = $1 WHERE id = $2',
      ['rejected', refundId]
    );

    res.json({ message: 'Refund rejected' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to reject refund' });
  }
});

// Get Revenue Analytics
router.get('/analytics/revenue', verifyToken, verifyAdmin, getUserInfo, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT DATE(created_at) as date, SUM(total_price) as revenue, COUNT(*) as orders
       FROM orders
       WHERE status = 'completed'
       GROUP BY DATE(created_at)
       ORDER BY DATE(created_at) DESC
       LIMIT 30`
    );

    res.json({ revenueData: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// Ban User (Admin)
router.post('/users/:userId/ban', verifyToken, verifyAdmin, getUserInfo, async (req, res) => {
  try {
    const { userId } = req.params;

    // Mark user as banned (you'd need to add a banned_at column)
    await pool.query(
      'UPDATE users SET is_admin = false WHERE id = $1',
      [userId]
    );

    // Log admin action
    await pool.query(
      `INSERT INTO admin_logs (admin_id, action, details)
       VALUES ($1, $2, $3)`,
      [req.userId, 'BAN_USER', `Banned user ${userId}`]
    );

    res.json({ message: 'User banned' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to ban user' });
  }
});

export default router;
