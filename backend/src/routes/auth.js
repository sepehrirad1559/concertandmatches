import express from 'express';
import { pool } from '../index.js';
import { hashPassword, verifyPassword } from '../utils/passwords.js';
import { createSessionToken, verifySessionToken, parseCookies } from '../utils/session.js';

const router = express.Router();

// Real accounts, added 2026-11-06 at the user's request -- Sign In/Sign Up/
// Favorites in the nav previously just showed a "coming soon" notice (an
// honest placeholder; see App.jsx's authNoticeMessage comment history)
// because no accounts system existed in the database at all. This is a
// first, minimal real implementation: email+password only, no email
// verification or password reset yet (both disclosed as not built below,
// same as this codebase's existing pattern for an honestly-unbuilt
// feature) -- NOT tested against the live database from the session that
// wrote this, since that session had no database credentials; smoke-test
// register -> login -> /me -> logout right after this deploys.
const COOKIE_NAME = 'cm_session';

// SameSite=None;Secure is required (not optional) because the frontend
// (concertandmatches.com, Vercel) and this API (concertandmatches-
// production.up.railway.app, Railway) are different origins -- see
// index.js's existing `cors({ credentials: true, origin: allowedOrigins })`
// config, which this relies on already being correct. Secure requires
// HTTPS, which both Vercel and Railway already terminate.
function setSessionCookie(res, token) {
  const maxAgeSeconds = 30 * 24 * 60 * 60;
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; HttpOnly; Path=/; Max-Age=${maxAgeSeconds}; SameSite=None; Secure`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=None; Secure`);
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

router.post('/register', async (req, res) => {
  const { email, password } = req.body || {};
  if (!isValidEmail(email) || typeof password !== 'string' || password.length < 8) {
    res.status(400).json({ error: 'A valid email and a password of at least 8 characters are required.' });
    return;
  }
  const normalizedEmail = email.trim().toLowerCase();
  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
  if (existing.rows.length > 0) {
    res.status(409).json({ error: 'An account with that email already exists.' });
    return;
  }
  const passwordHash = await hashPassword(password);
  const result = await pool.query(
    'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
    [normalizedEmail, passwordHash],
  );
  const user = result.rows[0];
  setSessionCookie(res, createSessionToken(user.id));
  res.status(201).json({ user: { id: user.id, email: user.email } });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!isValidEmail(email) || typeof password !== 'string') {
    res.status(400).json({ error: 'Email and password are required.' });
    return;
  }
  const normalizedEmail = email.trim().toLowerCase();
  const result = await pool.query('SELECT id, email, password_hash FROM users WHERE email = $1', [normalizedEmail]);
  const user = result.rows[0];
  // Same generic error whether the email doesn't exist or the password is
  // wrong -- distinguishing the two would let this endpoint be used to
  // enumerate which emails have accounts.
  const genericError = { error: 'Incorrect email or password.' };
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    res.status(401).json(genericError);
    return;
  }
  setSessionCookie(res, createSessionToken(user.id));
  res.json({ user: { id: user.id, email: user.email } });
});

router.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/me', async (req, res) => {
  const payload = verifySessionToken(parseCookies(req)[COOKIE_NAME]);
  if (!payload) {
    res.json({ user: null });
    return;
  }
  const result = await pool.query('SELECT id, email FROM users WHERE id = $1', [payload.uid]);
  const user = result.rows[0];
  res.json({ user: user ? { id: user.id, email: user.email } : null });
});

// Shared middleware for routes that require a logged-in user (favorites.js)
// -- responds 401 itself when there's no valid session, so a caller can
// just mount this and read req.userId afterward.
export async function requireAuth(req, res, next) {
  const payload = verifySessionToken(parseCookies(req)[COOKIE_NAME]);
  if (!payload) {
    res.status(401).json({ error: 'Sign in required.' });
    return;
  }
  req.userId = payload.uid;
  next();
}

export default router;
