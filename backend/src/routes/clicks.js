import express from 'express';
import { pool } from '../index.js';

const router = express.Router();

// Lightweight click-tracking endpoint (spec §15, §27, §48). Deliberately
// NOT a redirect — it logs against the events table's own row id (already
// present in every API response) and returns immediately, while the
// frontend's existing <a href> continues to navigate exactly as it does
// today (including the live, revenue-earning Ticketmaster tracked-affiliate
// link — see App.jsx's trackedTicketmasterLink). This means click tracking
// ships without touching that link's construction at all, which matters
// because getting that wrong would risk breaking real affiliate revenue.
// A full server-side redirect+tracking system (/go/:offerId) is a
// reasonable next step once there's a safe way to test it end-to-end
// without risking the existing tracked link.
function detectDeviceType(userAgent = '') {
  if (/Tablet|iPad/i.test(userAgent)) return 'tablet';
  if (/Mobi|Android|iPhone/i.test(userAgent)) return 'mobile';
  return 'desktop';
}

router.post('/', async (req, res) => {
  try {
    const { eventRowId, source, title, city, state, landingPage, sessionId } = req.body || {};

    // Best-effort validation only — this is analytics, not a security
    // boundary, so we log what we can rather than rejecting on anything
    // less than perfect input.
    const safeEventRowId = Number.isInteger(eventRowId) ? eventRowId : null;
    const deviceType = detectDeviceType(req.get('user-agent') || '');
    const referrer = req.get('referer') || null;

    await pool.query(
      `INSERT INTO click_events (event_row_id, source, event_title, city, state, landing_page, device_type, referrer, session_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [safeEventRowId, source || null, title || null, city || null, state || null, landingPage || null, deviceType, referrer, sessionId || null]
    );

    res.status(204).end();
  } catch (error) {
    // Never let a logging failure surface to the user — this fires
    // alongside a real "take me to the seller" click, which must still work
    // even if analytics has a bad day.
    console.error('Click logging failed:', error.message);
    res.status(204).end();
  }
});

export default router;
