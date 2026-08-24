import express from 'express';
import crypto from 'crypto';
import { pool } from '../index.js';
import { rebuildCanonicalEvents } from '../services/canonicalize.js';
import { logProviderSync } from '../utils/syncLog.js';
// Provider plugin interface (spec: formal provider abstraction) — routes
// below call getProvider('ticketmaster').sync() etc. instead of importing
// each service's functions directly. See ../providers/registry.js.
import { getProvider } from '../providers/registry.js';

const router = express.Router();

// --- Dashboard auth (spec §35 admin dashboard hardening) ---------------
//
// The dashboard previously required pasting the SAME shared secret used to
// gate schema migrations and full-database rebuilds (SYNC_SECRET_KEY)
// directly into a plain-text field in a public HTML page. That means
// anyone who ever viewed the dashboard's network traffic — or read the
// page's source while the key was typed in — had the same power as a curl
// call to POST /admin/canonicalize/rebuild or any /schema/* migration.
//
// This introduces a SEPARATE, lower-privilege password (ADMIN_DASHBOARD_
// PASSWORD) for dashboard viewing only. Logging in exchanges it for a
// short-lived (24h), HMAC-signed bearer token — the token itself never
// reveals the password, expires on its own, and (critically) only grants
// access to the three read-only endpoints below, never the destructive
// schema/rebuild/backfill routes, which still require the original
// SYNC_SECRET_KEY exactly as before. A valid SYNC_SECRET_KEY still works
// everywhere too (nothing that worked before stops working), so existing
// curl-based workflows are unaffected.
function verifyDashboardToken(token) {
  const secret = process.env.ADMIN_DASHBOARD_PASSWORD;
  if (!secret || !token) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payloadB64, signature] = parts;
  try {
    const expectedSignature = crypto.createHmac('sha256', secret).update(payloadB64).digest('hex');
    const sigBuf = Buffer.from(signature, 'hex');
    const expBuf = Buffer.from(expectedSignature, 'hex');
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return false;
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' && Date.now() < payload.exp;
  } catch (_err) {
    return false;
  }
}

// Accepts EITHER the full-power sync key OR a valid dashboard token.
function requireAdminAccess(req, res, next) {
  const providedKey = req.headers['x-sync-key'];
  const expectedKey = process.env.SYNC_SECRET_KEY;
  if (expectedKey && providedKey === expectedKey) return next();

  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (verifyDashboardToken(token)) return next();

  return res.status(403).json({ error: 'Invalid or missing credentials' });
}

router.post('/auth/login', (req, res) => {
  const dashboardPassword = process.env.ADMIN_DASHBOARD_PASSWORD;
  if (!dashboardPassword) {
    return res.status(503).json({ error: 'ADMIN_DASHBOARD_PASSWORD is not configured on the server' });
  }
  const { password } = req.body || {};
  if (!password || password !== dashboardPassword) {
    // Same message either way — don't reveal whether a password was even provided.
    return res.status(403).json({ error: 'Incorrect password' });
  }
  const exp = Date.now() + 24 * 60 * 60 * 1000; // 24h
  const payloadB64 = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  const signature = crypto.createHmac('sha256', dashboardPassword).update(payloadB64).digest('hex');
  res.json({ success: true, token: `${payloadB64}.${signature}`, expiresAt: exp });
});

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

  // ?total= now means "events per US state/Canadian province" (region-
  // segmented sync — see services/seatgeek.js), not a flat global total.
  // Kept the same query param name for backward compatibility with any
  // existing bookmarked/scripted calls; 300 is the current default (raised
  // from 100 after measuring that region-segmentation alone plateaued
  // around a 3% cross-source overlap rate — see services/seatgeek.js).
  const perState = Number(req.query.total) || 300;
  const startedAt = new Date();

  // Region-segmented sync loops through ~58 US states/Canadian provinces
  // with polite delays between calls plus a per-event store delay — it can
  // take several minutes for a full run, which exceeds Railway's proxy
  // timeout if we make the caller wait for it synchronously (that showed up
  // as a client-side "upstream error" even though the sync kept running on
  // the server). Respond immediately once the sync is kicked off instead;
  // check GET /admin/health or the Railway logs for completion/results.
  res.json({ success: true, message: `SeatGeek sync started in the background (perState=${perState}). Check GET /admin/health or Railway logs for completion.` });

  getProvider('seatgeek').sync(perState)
    .then((result) => logProviderSync({
      providerName: 'seatgeek', syncType: 'discovery', startedAt, finishedAt: new Date(),
      recordsReceived: result.totalEvents ?? null, status: result.success ? 'success' : 'error', errorMessage: result.error ?? null,
    }))
    .catch((error) => {
      console.error('Background SeatGeek sync failed:', error);
      return logProviderSync({
        providerName: 'seatgeek', syncType: 'discovery', startedAt, finishedAt: new Date(),
        recordsReceived: null, status: 'error', errorMessage: error.message,
      });
    });
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
  const result = await getProvider('ticketmaster').sync();
  await logProviderSync({
    providerName: 'ticketmaster', syncType: 'discovery', startedAt, finishedAt: new Date(),
    recordsReceived: result.totalEvents ?? null, status: result.success ? 'success' : 'error', errorMessage: result.error ?? null,
  });

  if (!result.success) {
    return res.status(500).json(result);
  }
  res.json(result);
});

// Removed (see backend/DATA_SOURCES.md): official_sources schema/CRUD
// routes and the /sync/official-sites and /discover/artist-sites sync
// routes. That feature fetched arbitrary third-party pages and parsed
// schema.org/JSON-LD markup out of their raw HTML — direct website
// scraping/HTML parsing, which this platform no longer performs in any
// form. The `official_sources` and any `events` rows with source='official'
// are inert leftover data; run POST /admin/cleanup/official-source-data
// once to remove them.

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

// Extends canonical_events/ticket_offers with the remaining normalized
// fields the platform's data model calls for, additively (ADD COLUMN IF
// NOT EXISTS — never drops/renames anything already in use). Run this
// after /admin/schema/add-canonical-tables, then /admin/canonicalize/rebuild
// to populate the new columns.
//
// Several of these will legitimately stay NULL for every row today: the
// Ticketmaster/SeatGeek bulk sync endpoints return an event-level min/max
// price RANGE, not individual seat-level listings, so there is no real
// section/row/quantity/fee breakdown to store without inventing one.
// price_type stays 'unknown' rather than defaulting to 'base' or 'all_in'
// for the same reason — neither API's bulk response documents which it is,
// so guessing would misrepresent the data as more comparable than it is
// (see canonicalize.js and DATA_SOURCES.md for the full explanation).
router.post('/schema/add-offer-details', async (req, res) => {
  const providedKey = req.headers['x-sync-key'];
  const expectedKey = process.env.SYNC_SECRET_KEY;
  if (!expectedKey || !providedKey || providedKey !== expectedKey) {
    return res.status(403).json({ error: 'Invalid or missing sync key' });
  }

  try {
    await pool.query(`
      ALTER TABLE canonical_events
        ADD COLUMN IF NOT EXISTS event_type TEXT,
        ADD COLUMN IF NOT EXISTS subcategory TEXT,
        ADD COLUMN IF NOT EXISTS performer TEXT,
        ADD COLUMN IF NOT EXISTS team TEXT,
        ADD COLUMN IF NOT EXISTS timezone TEXT,
        ADD COLUMN IF NOT EXISTS highest_price NUMERIC;
    `);

    await pool.query(`
      ALTER TABLE ticket_offers
        ADD COLUMN IF NOT EXISTS source_event_id TEXT,
        ADD COLUMN IF NOT EXISTS ticket_section TEXT,
        ADD COLUMN IF NOT EXISTS ticket_row TEXT,
        ADD COLUMN IF NOT EXISTS ticket_quantity INTEGER,
        ADD COLUMN IF NOT EXISTS fees NUMERIC,
        ADD COLUMN IF NOT EXISTS total_price NUMERIC,
        ADD COLUMN IF NOT EXISTS price_type TEXT NOT NULL DEFAULT 'unknown',
        ADD COLUMN IF NOT EXISTS availability TEXT NOT NULL DEFAULT 'available',
        ADD COLUMN IF NOT EXISTS affiliate_url TEXT;
    `);

    // price_history: an append-only log, one row per offer per rebuild
    // where the price actually changed — spec item 9 ("maintain price
    // history when appropriate"). Never updated in place, only inserted
    // into, so it's safe for this to grow independently of ticket_offers
    // being truncated/rebuilt each run.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS price_history (
        id SERIAL PRIMARY KEY,
        canonical_event_id INTEGER NOT NULL REFERENCES canonical_events(id) ON DELETE CASCADE,
        provider_id INTEGER REFERENCES providers(id),
        provider_offer_id TEXT NOT NULL,
        price NUMERIC,
        total_price NUMERIC,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_price_history_event ON price_history (canonical_event_id, recorded_at);
    `);

    res.json({ success: true, message: 'canonical_events/ticket_offers extended with the remaining normalized fields; price_history created. Run POST /admin/canonicalize/rebuild to populate.' });
  } catch (error) {
    console.error('Error adding offer-detail columns:', error);
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

// One-time cleanup after removing the official-sites scraper (see
// backend/DATA_SOURCES.md): deletes the events it collected (source =
// 'official') and drops the now-unused official_sources table, so no
// scraped data lingers in the central events table as if it were current.
// Safe to call even if already cleaned up (IF EXISTS / zero-row DELETE).
router.post('/cleanup/official-source-data', async (req, res) => {
  const providedKey = req.headers['x-sync-key'];
  const expectedKey = process.env.SYNC_SECRET_KEY;
  if (!expectedKey || !providedKey || providedKey !== expectedKey) {
    return res.status(403).json({ error: 'Invalid or missing sync key' });
  }
  try {
    const deleted = await pool.query(`DELETE FROM events WHERE source = 'official'`);
    await pool.query('DROP TABLE IF EXISTS official_sources');
    res.json({ success: true, eventsDeleted: deleted.rowCount, message: 'official_sources table dropped; run POST /admin/canonicalize/rebuild next to refresh the derived tables.' });
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
  const result = await getProvider('ticketmaster').backfillPrices(limit);
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
  const result = await getProvider('seatgeek').backfillPrices(limit);
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
router.get('/health', requireAdminAccess, async (req, res) => {
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
router.get('/stats', requireAdminAccess, async (req, res) => {
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
router.get('/analytics/clicks', requireAdminAccess, async (req, res) => {
  try {
    const [
      total,
      bySource,
      byDay,
      topEvents,
      byDevice,
      topCities,
      topStates,
      uniqueSessions,
      thisWeek,
      lastWeek,
    ] = await Promise.all([
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
      // Device-type breakdown (mobile vs desktop vs tablet, as recorded by
      // the click-tracking redirect) — helps gauge where traffic actually
      // comes from beyond raw totals.
      pool.query(`
        SELECT COALESCE(NULLIF(device_type, ''), 'unknown') AS device_type, COUNT(*)::int AS count
        FROM click_events
        GROUP BY 1
        ORDER BY count DESC
      `),
      pool.query(`
        SELECT city, state, COUNT(*)::int AS count
        FROM click_events
        WHERE city IS NOT NULL AND city != ''
        GROUP BY city, state
        ORDER BY count DESC
        LIMIT 10
      `),
      pool.query(`
        SELECT state, COUNT(*)::int AS count
        FROM click_events
        WHERE state IS NOT NULL AND state != ''
        GROUP BY state
        ORDER BY count DESC
        LIMIT 10
      `),
      // Unique sessions overall and in the last 14 days — a rough proxy for
      // distinct visitors, since click_events has no user/account concept.
      pool.query(`
        SELECT
          COUNT(DISTINCT session_id)::int AS all_time,
          COUNT(DISTINCT session_id) FILTER (WHERE created_at > NOW() - INTERVAL '14 days')::int AS last_14_days
        FROM click_events
        WHERE session_id IS NOT NULL
      `),
      // Week-over-week trend: clicks in the last 7 days vs the 7 days before
      // that. Computed as two scalar counts so the frontend can derive a
      // percent change without doing date math itself.
      pool.query(`SELECT COUNT(*)::int AS count FROM click_events WHERE created_at > NOW() - INTERVAL '7 days'`),
      pool.query(`
        SELECT COUNT(*)::int AS count FROM click_events
        WHERE created_at > NOW() - INTERVAL '14 days' AND created_at <= NOW() - INTERVAL '7 days'
      `),
    ]);

    const thisWeekCount = thisWeek.rows[0].count;
    const lastWeekCount = lastWeek.rows[0].count;
    const weekOverWeekChangePct = lastWeekCount > 0
      ? Math.round(((thisWeekCount - lastWeekCount) / lastWeekCount) * 1000) / 10
      : null; // no baseline to compare against — leave unset rather than fabricate a percentage

    res.json({
      success: true,
      totalClicks: total.rows[0].count,
      clicksBySource: bySource.rows,
      clicksByDay: byDay.rows,
      topEvents: topEvents.rows,
      clicksByDevice: byDevice.rows,
      topCities: topCities.rows,
      topStates: topStates.rows,
      uniqueSessions: {
        allTime: uniqueSessions.rows[0].all_time,
        last14Days: uniqueSessions.rows[0].last_14_days,
      },
      weekOverWeek: {
        thisWeek: thisWeekCount,
        lastWeek: lastWeekCount,
        changePct: weekOverWeekChangePct,
      },
      // No per-click price/revenue data exists in click_events (see schema),
      // so this endpoint intentionally reports engagement metrics only — it
      // does not fabricate a revenue figure. Real revenue reporting would
      // need actual affiliate-network payout data, which isn't available yet.
    });
  } catch (error) {
    console.error('Error computing click analytics:', error);
    // click_events may not exist yet — report that plainly rather than a raw 500.
    res.status(200).json({ success: false, error: error.message, hint: 'Has POST /admin/schema/add-click-tracking been run?' });
  }
});

export default router;
