import jwt from 'jsonwebtoken';
import { pool } from '../index.js';

// Verify JWT Token Middleware
export const verifyToken = (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];

    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || 'your-secret-key-change-in-production'
    );

    req.userId = decoded.userId;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
};

// Verify Admin Status
export const verifyAdmin = async (req, res, next) => {
  try {
    const result = await pool.query('SELECT is_admin FROM users WHERE id = $1', [req.userId]);
    
    if (result.rows.length === 0 || !result.rows[0].is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    next();
  } catch (error) {
    res.status(500).json({ error: 'Authorization check failed' });
  }
};

// Get User Info Middleware
export const getUserInfo = async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT id, email, first_name, last_name, is_admin FROM users WHERE id = $1',
      [req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    req.user = result.rows[0];
    next();
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch user info' });
  }
};
