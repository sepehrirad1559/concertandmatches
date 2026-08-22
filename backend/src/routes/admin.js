import express from 'express';
import { pool } from '../index.js';
import { syncSeatGeekEvents, backfillMissingPrices as backfillSeatGeekPrices } from '../services/seatgeek.js';
import { syncAllEvents as syncTicketmasterEvents, backfillMissingPrices as backfillTicketmasterPrices } from '../services/ticketmaster.js';
import { rebuildCanonicalEvents } from '../services/canonicalize.js';

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

// One-time schema migration: create the formal provider/venue/performer
// tables the metasearch-platform architecture needs (spec §2, §5). This is
// step 1 of a multi-phase upgrade — additive only, doesn't touch the
// existing `events` table or any current functionality, and is safe to run
// more than once. Seeds `providers` with the two sources already live
// (Ticketmaster, SeatGeek) so the provider-config system reflects reality
// from day one instead of starting empty.
router.post('/schema/add-provider-tables', async (req, res) => {
  const providedKey = req.headers['x-sync-key'];
  const expectedKey = process.env.SYNC_SECRET_KEY;
  if (!expectedKey) {
    return res.status(503).json({ error: 'SYNC_SECRET_KEY is not configured on the server' });
  }
  if (!providedKey || providedKey !== expectedKey) {
    return res.status(403).json({ error: 'Invalid or missing sync key' });
  }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS providers (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        provider_type TEXT NOT NULL, -- e.g. 'official_api', 'affiliate_feed', 'licensed_database'
        api_endpoint TEXT,
        terms_url TEXT,
        commercial_use_allowed BOOLEAN NOT NULL DEFAULT false,
        redistribution_allowed BOOLEAN NOT NULL DEFAULT false,
        affiliate_enabled BOOLEAN NOT NULL DEFAULT false,
        attribution_required BOOLEAN NOT NULL DEFAULT false,
        rate_limit TEXT,
        active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS venues (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        address TEXT,
        city TEXT,
        state TEXT,
        country TEXT,
        postal_code TEXT,
        latitude DOUBLE PRECISION,
        longitude DOUBLE PRECISION,
        website TEXT,
        capacity INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_venues_normalized_name ON venues (normalized_name);
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS performers (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        category TEXT,
        image TEXT,
        official_url TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_performers_normalized_name ON performers (normalized_name);
    `);

    // Seed providers with the two sources already live in production, so
    // the config table reflects the real current state rather than being
    // empty until someone fills it in by hand.
    await pool.query(`
      INSERT INTO providers (name, provider_type, api_endpoint, commercial_use_allowed, redistribution_allowed, affiliate_enabled, attribution_required, active)
      VALUES
        ('ticketmaster', 'official_api', 'https://app.ticketmaster.com/discovery/v2', true, true, true, false, true),
        ('seatgeek', 'official_api', 'https://api.seatgeek.com/2', true, true, true, false, true)
      ON CONFLICT (name) DO NOTHING;
    `);

    res.json({ success: true, message: 'providers/venues/performers tables created (or already existed) and providers seeded' });
  } catch (error) {
    console.error('Error adding provider tables:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// One-time schema migration: adds the affiliate URL template column to
// `providers` (spec §16 — "Configure affiliate URL templates") and seeds it
// with the real, currently-live Ticketmaster tracked-affiliate link (the
// same Impact.com deep-link base the frontend already wraps ticketmaster.com
// URLs in — see App.jsx's trackedTicketmasterLink/TICKETMASTER_TRACKED_BASE).
// {url} is replaced with the URL-encoded destination. SeatGeek is left null
// — its affiliate application is still pending, matching the frontend's own
// comment on that. This makes the affiliate link config data-driven instead
// of hardcoded, so routes/redirect.js (below) can build the correct outbound
// URL per provider without needing its own copy of this logic.
router.post('/schema/add-affiliate-templates', async (req, res) => {
  const providedKey = req.headers['x-sync-key'];
  const expectedKey = process.env.SYNC_SECRET_KEY;
  if (!expectedKey) {
    return res.status(503).json({ error: 'SYNC_SECRET_KEY is not configured on the server' });
  }
  if (!providedKey || providedKey !== expectedKey) {
    return res.status(403).json({ error: 'Invalid or missing sync key' });
  }

  try {
    await pool.query('ALTER TABLE providers ADD COLUMN IF NOT EXISTS affiliate_url_template TEXT');
    await pool.query(
      `UPDATE providers SET affiliate_url_template = $1 WHERE name = 'ticketmaster'`,
      ['https://ticketmaster.evyy.net/c/7649497/264167/4272?u={url}']
    );
    res.json({ success: true, message: 'affiliate_url_template column added and seeded for ticketmaster' });
  } catch (error) {
    console.error('Error adding affiliate template column:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// One-time schema migration: click tracking (spec §15, §27, §48). Kept
// deliberately independent of the canonical_events/ticket_offers tables
// below — it logs against the existing `events` table's own row id, which
// is already returned to the frontend today, so click tracking can go live
// immediately rather than waiting on the bigger normalized-schema migration.
router.post('/schema/add-click-tracking', async (req, res) => {
  const providedKey = req.headers['x-sync-key'];
  const expectedKey = process.env.SYNC_SECRET_KEY;
  if (!expectedKey) {
    return res.status(503).json({ error: 'SYNC_SECRET_KEY is not configured on the server' });
  }
  if (!providedKey || providedKey !== expectedKey) {
    return res.status(403).json({ error: 'Invalid or missing sync key' });
  }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS click_events (
        id SERIAL PRIMARY KEY,
        event_row_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
        source TEXT,
        event_title TEXT,
        city TEXT,
        state TEXT,
        landing_page TEXT,
        device_type TEXT,
        referrer TEXT,
        session_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_click_events_created_at ON click_events (created_at);
      CREATE INDEX IF NOT EXISTS idx_click_events_source ON click_events (source);
      CREATE INDEX IF NOT EXISTS idx_click_events_event_row_id ON click_events (event_row_id);
    `);

    res.json({ success: true, message: 'click_events table created (or already existed)' });
  } catch (error) {
    console.error('Error adding click tracking table:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// One-time schema migration: the normalized canonical_events / ticket_offers
// layer (spec §4-§8). These are DERIVED/materialized from the existing
// `events` table (the real source of truth, populated by the working
// Ticketmaster/SeatGeek sync) via POST /admin/canonicalize/rebuild below —
// nothing here changes how events are ingested or how the live /api/events
// route behaves today, so this is a safe, additive first step toward the
// persisted canonical-event architecture rather than a risky rip-and-replace.
router.post('/schema/add-canonical-tables', async (req, res) => {
  const providedKey = req.headers['x-sync-key'];
  const expectedKey = process.env.SYNC_SECRET_KEY;
  if (!expectedKey) {
    return res.status(503).json({ error: 'SYNC_SECRET_KEY is not configured on the server' });
  }
  if (!providedKey || providedKey !== expectedKey) {
    return res.status(403).json({ error: 'Invalid or missing sync key' });
  }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS canonical_events (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        normalized_title TEXT NOT NULL,
        category TEXT,
        event_date TIMESTAMPTZ,
        venue_name TEXT,
        city TEXT,
        state TEXT,
        country TEXT,
        latitude DOUBLE PRECISION,
        longitude DOUBLE PRECISION,
        image_url TEXT,
        artist_name TEXT,
        best_price NUMERIC,
        best_source TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_canonical_events_date ON canonical_events (event_date);
      CREATE INDEX IF NOT EXISTS idx_canonical_events_normalized_title ON canonical_events (normalized_title);
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS ticket_offers (
        id SERIAL PRIMARY KEY,
        canonical_event_id INTEGER NOT NULL REFERENCES canonical_events(id) ON DELETE CASCADE,
        provider_id INTEGER REFERENCES providers(id),
        provider_offer_id TEXT NOT NULL,
        source_event_row_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
        price NUMERIC,
        max_price NUMERIC,
        currency TEXT DEFAULT 'USD',
        seller_url TEXT,
        last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_ticket_offers_canonical_event ON ticket_offers (canonical_event_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ticket_offers_provider_offer ON ticket_offers (provider_id, provider_offer_id);
    `);

    res.json({ success: true, message: 'canonical_events/ticket_offers tables created (or already existed) — run POST /admin/canonicalize/rebuild to populate them' });
  } catch (error) {
    console.error('Error adding canonical-event tables:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Rebuilds canonical_events + ticket_offers from the current `events` table
// (the real source of truth) using the same cross-source matching logic that
// powers the live price-comparison feature. Safe to run repeatedly — fully
// replaces the derived tables' contents each time rather than trying to
// incrementally patch them, since they're a materialized view of `events`,
// not independently-edited data. Does NOT touch `events`, click_events, or
// the live /api/events route.
router.post('/canonicalize/rebuild', async (req, res) => {
  const providedKey = req.headers['x-sync-key'];
  const expectedKey = process.env.SYNC_SECRET_KEY;
  if (!expectedKey) {
    return res.status(503).json({ error: 'SYNC_SECRET_KEY is not configured on the server' });
  }
  if (!providedKey || providedKey !== expectedKey) {
    return res.status(403).json({ error: 'Invalid or missing sync key' });
  }

  try {
    const result = await rebuildCanonicalEvents();
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Canonical rebuild failed:', error);
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
