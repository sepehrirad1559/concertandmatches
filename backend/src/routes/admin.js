import express from 'express';
import { pool } from '../index.js';
import { syncSeatGeekEvents, backfillMissingPrices as backfillSeatGeekPrices } from '../services/seatgeek.js';
import { syncAllEvents as syncTicketmasterEvents, backfillMissingPrices as backfillTicketmasterPrices } from '../services/ticketmaster.js';

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

// Backfill missing prices for events that were stored with no price (see
// backfillMissingPrices in each service for why this happens — mostly
// bulk-listing endpoints under-reporting pricing compared to an event's
// own detail endpoint). Comparison against a seller only means anything
// once we actually have a price to compare, so this is what closes that
// gap on the events that synced without one. Batched (default 100 events
// per call, one API call per event) since it's much slower than a bulk
// sync — call it repeatedly (e.g. from cron) to keep working through the
// backlog, and again periodically since some prices genuinely don't exist
// yet at sync time (on-sale dates, etc.) and appear only later.
router.post('/backfill/ticketmaster-prices', async (req, res) => {
  const providedKey = req.headers['x-sync-key'];
  const expectedKey = process.env.SYNC_SECRET_KEY;

  if (!expectedKey) {
    return res.status(503).json({ error: 'SYNC_SECRET_KEY is not configured on the server' });
  }
  if (!providedKey || providedKey !== expectedKey) {
    return res.status(403).json({ error: 'Invalid or missing sync key' });
  }

  const limit = Number(req.query.limit) || 100;
  const result = await backfillTicketmasterPrices(limit);

  if (!result.success) {
    return res.status(500).json(result);
  }
  res.json(result);
});

router.post('/backfill/seatgeek-prices', async (req, res) => {
  const providedKey = req.headers['x-sync-key'];
  const expectedKey = process.env.SYNC_SECRET_KEY;

  if (!expectedKey) {
    return res.status(503).json({ error: 'SYNC_SECRET_KEY is not configured on the server' });
  }
  if (!providedKey || providedKey !== expectedKey) {
    return res.status(403).json({ error: 'Invalid or missing sync key' });
  }

  const limit = Number(req.query.limit) || 100;
  const result = await backfillSeatGeekPrices(limit);

  if (!result.success) {
    return res.status(500).json(result);
  }
  res.json(result);
});

export default router;
