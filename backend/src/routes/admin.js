import express from 'express';
import { pool } from '../index.js';
import { verifyToken, verifyAdmin, getUserInfo } from '../middleware/auth.js';

const router = express.Router();

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
