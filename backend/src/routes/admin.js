import express from 'express';
import { pool } from '../index.js';
import { syncSeatGeekEvents, backfillMissingPrices as backfillSeatGeekPrices } from '../services/seatgeek.js';
import { syncAllEvents as syncTicketmasterEvents, backfillMissingPrices as backfillTicketmasterPrices } from '../services/ticketmaster.js';
import { rebuildCanonicalEvents } from '../services/canonicalize.js';
import { logProviderSync } from '../utils/syncLog.js';

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
  const startedAt = new Date();
  const result = await syncSeatGeekEvents(totalWanted);
  await logProviderSync({
    providerName: 'seatgeek', syncType: 'discovery', startedAt, finishedAt: new Date(),
    recordsReceived: result.totalEvents ?? null, status: result.success ? 'success' : 'error', errorMessage: result.error ?? null,
  });

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

  const startedAt = new Date();
  const result = await syncTicketmasterEvents();
  await logProviderSync({
    providerName: 'ticketmaster', syncType: 'discovery', startedAt, finishedAt: new Date(),
    recordsReceived: result.totalEvents ?? null, status: result.success ? 'success' : 'error', errorMessage: result.error ?? null,
  });

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
  const startedAt = new Date();
  const result = await backfillTicketmasterPrices(limit);
  await logProviderSync({
    providerName: 'ticketmaster', syncType: 'price_backfill', startedAt, finishedAt: new Date(),
    recordsReceived: result.checked ?? null, recordsUpdated: result.updated ?? null,
    status: result.success ? 'success' : 'error', errorMessage: result.error ?? null,
  });

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
  const startedAt = new Date();
  const result = await backfillSeatGeekPrices(limit);
  await logProviderSync({
    providerName: 'seatgeek', syncType: 'price_backfill', startedAt, finishedAt: new Date(),
    recordsReceived: result.checked ?? null, recordsUpdated: result.updated ?? null,
    status: result.success ? 'success' : 'error', errorMessage: result.error ?? null,
  });

  if (!result.success) {
    return res.status(500).json(result);
  }
  res.json(result);
});

// One-time schema migration: provider_sync_logs (spec §5, §35 — provider
// health/observability). Every sync/backfill route above (and the
// scheduled daily backfill in index.js) writes one row per run here once
// this table exists; writes are best-effort and never block the sync they
// describe (see utils/syncLog.js).
router.post('/schema/add-sync-logs', async (req, res) => {
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
      CREATE TABLE IF NOT EXISTS provider_sync_logs (
        id SERIAL PRIMARY KEY,
        provider_name TEXT NOT NULL,
        sync_type TEXT NOT NULL,
        started_at TIMESTAMPTZ NOT NULL,
        finished_at TIMESTAMPTZ,
        records_received INTEGER,
        records_updated INTEGER,
        status TEXT NOT NULL,
        error_message TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_provider_sync_logs_provider ON provider_sync_logs (provider_name, sync_type, created_at DESC);
    `);
    res.json({ success: true, message: 'provider_sync_logs table created (or already existed)' });
  } catch (error) {
    console.error('Error adding provider_sync_logs table:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Basic provider health view (spec §35): the most recent sync/backfill run
// per provider + sync type, so a human (or future admin UI) can see at a
// glance whether each provider is healthy, rate-limited, or failing —
// without digging through Railway logs by hand.
router.get('/health', async (req, res) => {
  const providedKey = req.headers['x-sync-key'];
  const expectedKey = process.env.SYNC_SECRET_KEY;
  if (!expectedKey) {
    return res.status(503).json({ error: 'SYNC_SECRET_KEY is not configured on the server' });
  }
  if (!providedKey || providedKey !== expectedKey) {
    return res.status(403).json({ error: 'Invalid or missing sync key' });
  }

  try {
    const result = await pool.query(`
      SELECT DISTINCT ON (provider_name, sync_type)
        provider_name, sync_type, started_at, finished_at, records_received, records_updated, status, error_message
      FROM provider_sync_logs
      ORDER BY provider_name, sync_type, started_at DESC
    `);
    res.json({ success: true, providers: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Aggregate counts for the admin dashboard (spec §35): how many raw events,
// deduplicated canonical events, and ticket offers exist, plus a rough
// price-coverage figure so it's obvious at a glance how much of the catalog
// actually has a comparable price yet. All read-only, no side effects.
router.get('/stats', async (req, res) => {
  const providedKey = req.headers['x-sync-key'];
  const expectedKey = process.env.SYNC_SECRET_KEY;
  if (!expectedKey) {
    return res.status(503).json({ error: 'SYNC_SECRET_KEY is not configured on the server' });
  }
  if (!providedKey || providedKey !== expectedKey) {
    return res.status(403).json({ error: 'Invalid or missing sync key' });
  }

  try {
    const [events, priced, bySource, canonical, offers, providers] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS count FROM events'),
      pool.query('SELECT COUNT(*)::int AS count FROM events WHERE min_price IS NOT NULL'),
      pool.query('SELECT source, COUNT(*)::int AS count FROM events GROUP BY source ORDER BY source'),
      pool.query('SELECT COUNT(*)::int AS count FROM canonical_events').catch(() => ({ rows: [{ count: null }] })),
      pool.query('SELECT COUNT(*)::int AS count FROM ticket_offers').catch(() => ({ rows: [{ count: null }] })),
      pool.query('SELECT name, active, affiliate_enabled FROM providers ORDER BY name').catch(() => ({ rows: [] })),
    ]);

    res.json({
      success: true,
      totalEvents: events.rows[0].count,
      eventsWithPrice: priced.rows[0].count,
      eventsBySource: bySource.rows,
      canonicalEvents: canonical.rows[0].count,
      ticketOffers: offers.rows[0].count,
      providers: providers.rows,
    });
  } catch (error) {
    console.error('Error computing admin stats:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Click analytics for the admin dashboard (spec §15, §35): totals, a
// breakdown by provider/source, clicks over the last 14 days, and the
// most-clicked events. Read-only. Falls back gracefully if click_events
// doesn't exist yet (migration not run).
router.get('/analytics/clicks', async (req, res) => {
  const providedKey = req.headers['x-sync-key'];
  const expectedKey = process.env.SYNC_SECRET_KEY;
  if (!expectedKey) {
    return res.status(503).json({ error: 'SYNC_SECRET_KEY is not configured on the server' });
  }
  if (!providedKey || providedKey !== expectedKey) {
    return res.status(403).json({ error: 'Invalid or missing sync key' });
  }

  try {
    const [total, bySource, byDay, topEvents] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS count FROM click_events'),
      pool.query('SELECT source, COUNT(*)::int AS count FROM click_events GROUP BY source ORDER BY count DESC'),
      pool.query(`
        SELECT DATE(created_at) AS day, COUNT(*)::int AS count
        FROM click_events
        WHERE created_at > NOW() - INTERVAL '14 days'
        GROUP BY DATE(created_at)
        ORDER BY day ASC
      `),
      pool.query(`
        SELECT event_title, city, state, COUNT(*)::int AS count
        FROM click_events
        WHERE event_title IS NOT NULL
        GROUP BY event_title, city, state
        ORDER BY count DESC
        LIMIT 10
      `),
    ]);

    res.json({
      success: true,
      totalClicks: total.rows[0].count,
      clicksBySource: bySource.rows,
      clicksByDay: byDay.rows,
      topEvents: topEvents.rows,
    });
  } catch (error) {
    console.error('Error computing click analytics:', error);
    // click_events may not exist yet — report that plainly rather than a raw 500.
    res.status(200).json({ success: false, error: error.message, hint: 'Has POST /admin/schema/add-click-tracking been run?' });
  }
});

export default router;
