import express from 'express';
import bcrypt from 'bcryptjs';
import { pool } from '../index.js';
import { verifyToken, getUserInfo } from '../middleware/auth.js';

const router = express.Router();

// Get User Profile
router.get('/profile', verifyToken, getUserInfo, async (req, res) => {
  try {
    const userId = req.userId;

    const result = await pool.query(
      `SELECT id, email, first_name, last_name, phone, date_of_birth,
              country, state, city, address, zip_code, is_admin, created_at
       FROM users WHERE id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// Update User Profile
router.put('/profile', verifyToken, getUserInfo, async (req, res) => {
  try {
    const userId = req.userId;
    const { firstName, lastName, phone, dateOfBirth, country, state, city, address, zipCode } = req.body;

    const result = await pool.query(
      `UPDATE users SET
       first_name = COALESCE($1, first_name),
       last_name = COALESCE($2, last_name),
       phone = COALESCE($3, phone),
       date_of_birth = COALESCE($4, date_of_birth),
       country = COALESCE($5, country),
       state = COALESCE($6, state),
       city = COALESCE($7, city),
       address = COALESCE($8, address),
       zip_code = COALESCE($9, zip_code),
       updated_at = NOW()
       WHERE id = $10
       RETURNING id, email, first_name, last_name, phone, country, state, city`,
      [firstName, lastName, phone, dateOfBirth, country, state, city, address, zipCode, userId]
    );

    res.json({ message: 'Profile updated successfully', user: result.rows[0] });
  } catch (error) {
    console.error('Profile update error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// Change Password
router.post('/change-password', verifyToken, getUserInfo, async (req, res) => {
  try {
    const userId = req.userId;
    const { currentPassword, newPassword, confirmPassword } = req.body;

    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({ error: 'New passwords do not match' });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    // Get current password hash
    const userResult = await pool.query(
      'SELECT password_hash FROM users WHERE id = $1',
      [userId]
    );

    const user = userResult.rows[0];
    const validPassword = await bcrypt.compare(currentPassword, user.password_hash);

    if (!validPassword) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update password
    await pool.query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
      [hashedPassword, userId]
    );

    res.json({ message: 'Password changed successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// Get Purchase History (Tickets)
router.get('/my-tickets', verifyToken, getUserInfo, async (req, res) => {
  try {
    const userId = req.userId;

    const result = await pool.query(
      `SELECT o.id, o.order_number, e.title, e.date, e.venue_name, e.city, e.state,
              gt.ticket_number, o.total_price, o.status, o.purchased_at
       FROM orders o
       JOIN events e ON o.event_id = e.id
       LEFT JOIN generated_tickets gt ON o.id = gt.order_id
       WHERE o.user_id = $1 AND o.status = 'completed'
       ORDER BY o.purchased_at DESC`,
      [userId]
    );

    res.json({ tickets: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch tickets' });
  }
});

// Save Payment Method (for future use)
router.post('/payment-methods', verifyToken, getUserInfo, async (req, res) => {
  try {
    // TODO: Implement payment method storage with Stripe
    // For security, we should NOT store full card details
    // Use Stripe's saved payment methods instead

    res.json({ message: 'Payment method saved', paymentMethodId: 'pm_xxxxx' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save payment method' });
  }
});

// Get Saved Events (Watchlist)
router.get('/saved-events', verifyToken, getUserInfo, async (req, res) => {
  try {
    const userId = req.userId;

    const result = await pool.query(
      `SELECT e.id, e.title, e.category, e.date, e.city, e.state,
              e.min_price, e.max_price, se.created_at as saved_at
       FROM saved_events se
       JOIN events e ON se.event_id = e.id
       WHERE se.user_id = $1
       ORDER BY e.date ASC`,
      [userId]
    );

    res.json({ savedEvents: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch saved events' });
  }
});

// Remove Saved Event
router.delete('/saved-events/:eventId', verifyToken, getUserInfo, async (req, res) => {
  try {
    const { eventId } = req.params;
    const userId = req.userId;

    await pool.query(
      'DELETE FROM saved_events WHERE user_id = $1 AND event_id = $2',
      [userId, eventId]
    );

    res.json({ message: 'Event removed from saved' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove event' });
  }
});

export default router;
