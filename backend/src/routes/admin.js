import express from 'express';
import crypto from 'crypto';
import { pool } from '../index.js';
import { rebuildCanonicalEvents } from '../services/canonicalize.js';
import { logProviderSync } from '../utils/syncLog.js';
// Provider plugin interface (spec: formal provider abstraction) — routes
// below call getProvider('ticketmaster').sync() etc. instead of importing
// each service's functions directly. See ../providers/registry.js.
import { getProvider } from '../providers/registry.js';
import { isSameEvent, tokenSimilarity, isSameDay } from '../utils/matching.js';
import { syncSeatGeekMatchesForExistingEvents } from '../services/seatgeek.js';
import { trackedTicketmasterLink } from '../services/ticketmaster.js';
import { syncCuratedAttractions } from '../services/curatedAttractions.js';
import axios from 'axios';

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

// Both services' backfillMissingPrices() (services/ticketmaster.js,
// services/seatgeek.js) now return apiErrors/noPriceInResponse alongside
// updated/checked, specifically so a "0 updated" run is diagnosable instead
// of looking identical to a healthy one. Every call site below used to drop
// those fields on the floor once result.success was true (errorMessage only
// ever got set from result.error, which is only set on a hard failure) — so
// the admin dashboard's sync-health table showed "success, 0 updated, —" for
// both "everything's fine, these events just don't have pricing yet" and "every
// API call has been silently failing for days." This makes the distinction
// visible from the logged row itself.
export function backfillDiagnosticMessage(result) {
  const parts = [];
  if (result.quotaExhausted) {
    parts.push(`QUOTA EXHAUSTED — ${result.quotaExhaustedNote || 'stopped early, retrying now will only fail identically until the provider quota resets'}`);
  }
  if (result.apiErrors > 0) {
    parts.push(`${result.apiErrors} API error(s) fetching event detail${result.errorSamples?.length ? `: ${JSON.stringify(result.errorSamples)}` : ''}`);
  }
  if (result.noPriceInResponse > 0) {
    parts.push(`${result.noPriceInResponse} of ${result.checked} checked had no price at the source yet (not an error — expected for events before on-sale)`);
  }
  return parts.length ? parts.join('; ') : null;
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
      recordsReceived: result.totalEvents ?? null, status: result.success ? 'success' : 'error',
      errorMessage: result.error ?? (result.apiErrorCount > 0 ? `${result.apiErrorCount} API error(s): ${JSON.stringify(result.sampleApiErrors)}` : null),
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

  // Same fix as /sync/seatgeek above: the comprehensive nationwide sync
  // (every segment, every US/CA town, fully paginated per month) can take
  // many minutes — far longer than Railway's proxy will hold a synchronous
  // request open. Waiting on it here is exactly what produced the
  // PowerShell-side "upstream error" (a proxy-level timeout/disconnect)
  // even though the sync itself kept running server-side. Respond
  // immediately once it's kicked off instead; check GET /admin/health or
  // the Railway logs for the actual completed result (including the new
  // apiErrorCount/sampleApiErrors fields).
  res.json({ success: true, message: 'Ticketmaster sync started in the background. Check GET /admin/health or Railway logs for completion.' });

  getProvider('ticketmaster').sync()
    .then((result) => logProviderSync({
      providerName: 'ticketmaster', syncType: 'discovery', startedAt, finishedAt: new Date(),
      recordsReceived: result.totalEvents ?? null, status: result.success ? 'success' : 'error',
      // Surface apiErrorCount/sampleApiErrors (see services/ticketmaster.js)
      // in the logged error_message even on a "successful" run, so a sync
      // that silently failed most of its requests but still returned
      // success:true is visible from GET /admin/health without needing a
      // separate diagnostics call.
      errorMessage: result.error ?? (result.apiErrorCount > 0 ? `${result.apiErrorCount} API error(s): ${JSON.stringify(result.sampleApiErrors)}` : null),
    }))
    .catch((error) => {
      console.error('Background Ticketmaster sync failed:', error);
      return logProviderSync({
        providerName: 'ticketmaster', syncType: 'discovery', startedAt, finishedAt: new Date(),
        recordsReceived: null, status: 'error', errorMessage: error.message,
      });
    });
});

// Bounded alternative to /sync/ticketmaster above — fetches and stores only
// the `limit` (default 5000) Ticketmaster events with the soonest dates,
// across every top-level segment and country, instead of the entire
// catalog. Useful for a quick, fast-finishing sync rather than the
// comprehensive nationwide-everything pull, which can take many minutes.
// Same background-response pattern as /sync/ticketmaster: responds
// immediately, runs the actual sync after responding, and logs the result
// via logProviderSync so GET /admin/health reflects it once done.
router.post('/sync/ticketmaster-closest', async (req, res) => {
  const providedKey = req.headers['x-sync-key'];
  const expectedKey = process.env.SYNC_SECRET_KEY;

  if (!expectedKey) {
    return res.status(503).json({ error: 'SYNC_SECRET_KEY is not configured on the server' });
  }
  if (!providedKey || providedKey !== expectedKey) {
    return res.status(403).json({ error: 'Invalid or missing sync key' });
  }

  const requestedLimit = Number(req.body?.limit ?? req.query?.limit);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : 5000;
  const startedAt = new Date();

  res.json({ success: true, message: `Ticketmaster closest-${limit}-events sync started in the background. Check GET /admin/health or Railway logs for completion.` });

  getProvider('ticketmaster').syncClosest(limit)
    .then((result) => logProviderSync({
      providerName: 'ticketmaster', syncType: 'closest-by-date', startedAt, finishedAt: new Date(),
      recordsReceived: result.totalStored ?? null, status: result.success ? 'success' : 'error',
      errorMessage: result.error ?? (result.apiErrorCount > 0 ? `${result.apiErrorCount} API error(s): ${JSON.stringify(result.sampleApiErrors)}` : null),
    }))
    .catch((error) => {
      console.error('Background Ticketmaster closest-events sync failed:', error);
      return logProviderSync({
        providerName: 'ticketmaster', syncType: 'closest-by-date', startedAt, finishedAt: new Date(),
        recordsReceived: null, status: 'error', errorMessage: error.message,
      });
    });
});

// One-time seed: adds a 'ticketnetwork' row to `providers` so
// canonicalize.js's ticket_offers join (providerIdByName.get(row.source))
// doesn't silently skip TicketNetwork offers the way it does for any source
// with no matching providers row (see that file's skippedNoProvider
// counter). No affiliate_url_template — TicketNetwork's catalog Url field
// is already the full Impact.com tracked affiliate link, unlike
// Ticketmaster's raw seller URL which needs wrapping (see App.jsx's
// trackedTicketmasterLink / providers.affiliate_url_template).
router.post('/schema/add-ticketnetwork-provider', async (req, res) => {
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
      INSERT INTO providers (name, provider_type, api_endpoint, commercial_use_allowed, redistribution_allowed, affiliate_enabled, attribution_required, active)
      VALUES ('ticketnetwork', 'official_api', 'https://api.impact.com', true, true, true, false, true)
      ON CONFLICT (name) DO NOTHING;
    `);
    res.json({ success: true, message: 'ticketnetwork provider row seeded (or already existed)' });
  } catch (error) {
    console.error('Error seeding ticketnetwork provider row:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/sync/ticketnetwork', async (req, res) => {
  const providedKey = req.headers['x-sync-key'];
  const expectedKey = process.env.SYNC_SECRET_KEY;

  if (!expectedKey) {
    return res.status(503).json({ error: 'SYNC_SECRET_KEY is not configured on the server' });
  }
  if (!providedKey || providedKey !== expectedKey) {
    return res.status(403).json({ error: 'Invalid or missing sync key' });
  }

  // ?maxPages= lets a caller run a small partial sync first (e.g. a few
  // pages) to sanity-check results before committing to the full ~210k-item
  // catalog, which at ~1000 items/page can take a while to page through
  // completely. Omit it (or pass 0) for a full sync.
  const maxPages = Number(req.query.maxPages) || null;
  const pageSize = Number(req.query.pageSize) || 1000;
  const startedAt = new Date();

  // Same background-response pattern as /sync/seatgeek and /sync/ticketmaster
  // above — paging through the full catalog can take many minutes, longer
  // than Railway's proxy will hold a synchronous request open.
  res.json({ success: true, message: `TicketNetwork sync started in the background (maxPages=${maxPages ?? 'unlimited — full catalog'}, pageSize=${pageSize}). Check GET /admin/health or Railway logs for completion.` });

  getProvider('ticketnetwork').sync({ maxPages, pageSize })
    .then((result) => logProviderSync({
      providerName: 'ticketnetwork', syncType: 'discovery', startedAt, finishedAt: new Date(),
      recordsReceived: result.totalEvents ?? null, status: result.success ? 'success' : 'error',
      errorMessage: result.error ?? (result.apiErrorCount > 0 ? `${result.apiErrorCount} API error(s): ${JSON.stringify(result.sampleApiErrors)}` : null),
    }))
    .catch((error) => {
      console.error('Background TicketNetwork sync failed:', error);
      return logProviderSync({
        providerName: 'ticketnetwork', syncType: 'discovery', startedAt, finishedAt: new Date(),
        recordsReceived: null, status: 'error', errorMessage: error.message,
      });
    });
});

// Manually curated Rockefeller Center attractions (see
// backend/src/services/curatedAttractions.js for why — no Impact.com
// product catalog exists for this brand, unlike TicketNetwork's). Fast
// (6 rows, no external API call), so this runs synchronously and responds
// with the real result instead of the background-job pattern used by the
// large provider syncs above.
router.post('/sync/curated-attractions', async (req, res) => {
  const providedKey = req.headers['x-sync-key'];
  const expectedKey = process.env.SYNC_SECRET_KEY;

  if (!expectedKey) {
    return res.status(503).json({ error: 'SYNC_SECRET_KEY is not configured on the server' });
  }
  if (!providedKey || providedKey !== expectedKey) {
    return res.status(403).json({ error: 'Invalid or missing sync key' });
  }

  const startedAt = new Date();
  try {
    const result = await syncCuratedAttractions();
    await logProviderSync({
      providerName: 'curated', syncType: 'discovery', startedAt, finishedAt: new Date(),
      recordsReceived: result.totalEvents ?? null,
      status: result.success ? 'success' : 'error',
      errorMessage: result.errors ? JSON.stringify(result.errors) : null,
    });
    res.json({ success: true, result });
  } catch (error) {
    console.error('Curated attractions sync failed:', error);
    await logProviderSync({
      providerName: 'curated', syncType: 'discovery', startedAt, finishedAt: new Date(),
      status: 'error', errorMessage: error.message,
    });
    res.status(500).json({ success: false, error: error.message });
  }
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
    //
    // NOT a plain CREATE TABLE IF NOT EXISTS: this database already has a
    // `price_history` table left over from database-schema.sql, an early
    // e-commerce-style scaffold (users/tickets/orders/price_history/
    // refund_requests) that predates the events/canonical_events model this
    // app actually runs on and was never wired into any route. That old
    // table uses event_id/ticket_id/marketplace columns, not
    // canonical_event_id/provider_id — so CREATE TABLE IF NOT EXISTS was a
    // silent no-op against it, and the CREATE INDEX below then failed with
    // "column canonical_event_id does not exist". Build it column-by-column
    // with ADD COLUMN IF NOT EXISTS instead, so this works whether the table
    // is brand new or is that old leftover shape — additive only, doesn't
    // touch/drop the old columns. canonical_event_id is left nullable here
    // (rather than NOT NULL, as originally written) since ADD COLUMN NOT
    // NULL fails outright on a table that already has rows.
    await pool.query(`CREATE TABLE IF NOT EXISTS price_history (id SERIAL PRIMARY KEY)`);
    await pool.query(`
      ALTER TABLE price_history
        ADD COLUMN IF NOT EXISTS canonical_event_id INTEGER REFERENCES canonical_events(id) ON DELETE CASCADE,
        ADD COLUMN IF NOT EXISTS provider_id INTEGER REFERENCES providers(id),
        ADD COLUMN IF NOT EXISTS provider_offer_id TEXT,
        ADD COLUMN IF NOT EXISTS price NUMERIC,
        ADD COLUMN IF NOT EXISTS total_price NUMERIC,
        ADD COLUMN IF NOT EXISTS recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    `);
    const legacyCols = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'price_history' AND column_name IN ('event_id', 'ticket_id', 'price')`
      );
    for (const { column_name } of legacyCols.rows) {
      await pool.query(`ALTER TABLE price_history ALTER COLUMN ${column_name} DROP NOT NULL`);
    }
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_price_history_event ON price_history (canonical_event_id, recorded_at)`);

    res.json({ success: true, message: 'canonical_events/ticket_offers extended with the remaining normalized fields; price_history created. Run POST /admin/canonicalize/rebuild to populate.' });
  } catch (error)  {
    console.error('Error adding offer-detail columns:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Everything the public listing endpoint (GET /api/events) needs in order to
// be answered entirely by the database instead of by merging up to 30,000
// raw rows in Node on every request. Additive and idempotent, same as every
// other /schema/* route here. Run it once after deploy, then POST
// /admin/canonicalize/rebuild to populate the new columns.
//
// Three groups of changes:
//
// 1. canonical_events gains the few fields the listing response needs that
//    the rebuild was dropping on the floor, plus the stable id it has to
//    return. primary_event_row_id is the important one: canonical_events.id
//    is reassigned by the rebuild's TRUNCATE ... RESTART IDENTITY on EVERY
//    run, so it can never be exposed to the frontend as an event's `id` —
//    detail-page URLs, the /go/event/:id affiliate redirect and click
//    tracking are all keyed on a raw events.id and must stay that way.
//    description and price_breakdown are needed because the frontend hands
//    the list object straight to the event detail view on click WITHOUT
//    re-fetching (App.jsx only calls /events/detail/:id on a cold load), and
//    that view renders both. venue_address is included for exact response-
//    shape parity even though nothing currently reads it — it costs one
//    nullable column and avoids a silent field disappearing from the API.
//    offer_count is the precomputed "how many retailers list this event"
//    number the default listing order sorts by.
//
// 2. Indexes for the new query patterns on canonical_events. event_date
//    already had one from /schema/add-canonical-tables; the rest are new.
//    Each is issued as its own pool.query rather than batched into one
//    multi-statement string, so any single one can later be switched to
//    CREATE INDEX CONCURRENTLY (which cannot run inside an implicit
//    multi-statement transaction) without restructuring this route.
//
// 3. Basic indexes on the RAW `events` table, which had none at all beyond
//    its primary key and the external_id unique constraint. Those help the
//    rebuild's own full scan, the admin/diagnostic queries, and the
//    raw-table fallback path in routes/events.js.
//
// Also seeds a `curated` providers row. Without it, the curated Rockefeller
// Center events (services/curatedAttractions.js) are counted by
// canonicalize.js's skippedNoProvider and get NO ticket_offers rows at all —
// which was harmless while the derived layer was admin-only, but would make
// those events render with an empty offers array (and therefore no
// buy-ticket link) once the public listing reads from it.
router.post('/schema/add-listing-columns', async (req, res) => {
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
      ALTER TABLE canonical_events
        ADD COLUMN IF NOT EXISTS primary_event_row_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS description TEXT,
        ADD COLUMN IF NOT EXISTS venue_address TEXT,
        ADD COLUMN IF NOT EXISTS price_breakdown JSONB,
        ADD COLUMN IF NOT EXISTS offer_count INTEGER NOT NULL DEFAULT 0;
    `);

    // canonical_events indexes for the listing endpoint's WHERE/ORDER BY.
    // event_date already has idx_canonical_events_date from
    // /schema/add-canonical-tables, so it's not repeated here.
    await pool.query('CREATE INDEX IF NOT EXISTS idx_canonical_events_category ON canonical_events (category)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_canonical_events_city_state ON canonical_events (city, state)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_canonical_events_best_price ON canonical_events (best_price)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_canonical_events_primary_event_row ON canonical_events (primary_event_row_id)');

    // Raw `events` indexes — the table had none of these, despite every
    // listing/detail/sync query filtering or ordering on them.
    await pool.query('CREATE INDEX IF NOT EXISTS idx_events_date ON events (date)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_events_city ON events (city)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_events_state ON events (state)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_events_category ON events (category)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_events_source ON events (source)');

    await pool.query(`
      INSERT INTO providers (name, provider_type, api_endpoint, commercial_use_allowed, redistribution_allowed, affiliate_enabled, attribution_required, active)
      VALUES ('curated', 'licensed_database', NULL, true, true, true, false, true)
      ON CONFLICT (name) DO NOTHING;
    `);

    res.json({ success: true, message: 'canonical_events extended with primary_event_row_id/description/venue_address/price_breakdown/offer_count; canonical_events + events indexes created; curated provider seeded. Run POST /admin/canonicalize/rebuild to populate.' });
  } catch (error) {
    console.error('Error adding listing columns/indexes:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// One-time migration for the price-backfill starvation fix (2026-09-16) —
// see services/ticketmaster.js and services/seatgeek.js's backfillMissingPrices
// for the full explanation. Both now order their backfill candidates by
// price_backfill_checked_at (NULLS FIRST) instead of date alone, so a
// permanently-unpriced event stops eating a fresh API call on every single
// run once it's been tried once. Needs this column (and an index for the
// ORDER BY, since both services also filter WHERE min_price IS NULL — a
// partial index keeps it small since priced rows never need it again) before
// that code path can run.
router.post('/schema/add-price-backfill-tracking', async (req, res) => {
  const providedKey = req.headers['x-sync-key'];
  const expectedKey = process.env.SYNC_SECRET_KEY;
  if (!expectedKey) {
    return res.status(503).json({ error: 'SYNC_SECRET_KEY is not configured on the server' });
  }
  if (!providedKey || providedKey !== expectedKey) {
    return res.status(403).json({ error: 'Invalid or missing sync key' });
  }

  try {
    await pool.query('ALTER TABLE events ADD COLUMN IF NOT EXISTS price_backfill_checked_at TIMESTAMPTZ');
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_events_price_backfill_queue
        ON events (source, price_backfill_checked_at, date)
        WHERE min_price IS NULL
    `);
    res.json({ success: true, message: 'events extended with price_backfill_checked_at; partial index created for the backfill queue.' });
  } catch (error) {
    console.error('Error adding price_backfill_checked_at:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// One-time backfill for the Ticketmaster affiliate-link fix (2026-09-16) —
// see services/ticketmaster.js's trackedTicketmasterLink for the full
// explanation. That fix only wraps the outbound URL for events stored from
// this point forward (storeEvent's INSERT path); every Ticketmaster event
// already in the database still has the old, untracked, raw
// ticketmaster.com URL as its source_url, since storeEvent's UPDATE path
// never touches source_url after insert. This walks every existing
// Ticketmaster row and rewrites source_url through the same tracked-link
// wrapper, so referrals from already-synced events start earning
// commission too instead of only new ones going forward. Idempotent — a
// row whose source_url is already a tracked link (starts with the
// tracking domain) is skipped, so running this twice is harmless.
//
// A rebuild (POST /api/admin/canonicalize/rebuild) still needs to run after
// this to propagate the updated source_url into ticket_offers.affiliate_url,
// same as any other events-table change — this route only touches the
// events table.
router.post('/schema/wrap-ticketmaster-affiliate-links', async (req, res) => {
  const providedKey = req.headers['x-sync-key'];
  const expectedKey = process.env.SYNC_SECRET_KEY;
  if (!expectedKey) {
    return res.status(503).json({ error: 'SYNC_SECRET_KEY is not configured on the server' });
  }
  if (!providedKey || providedKey !== expectedKey) {
    return res.status(403).json({ error: 'Invalid or missing sync key' });
  }

  const startedAt = new Date();
  res.json({ success: true, message: 'Ticketmaster affiliate-link backfill started in the background. Check GET /admin/health for completion.' });

  (async () => {
    const BATCH_SIZE = 2000;
    let updated = 0;
    let skippedAlreadyTracked = 0;
    try {
      while (true) {
        const { rows } = await pool.query(
          `SELECT id, source_url FROM events
           WHERE source = 'ticketmaster' AND source_url IS NOT NULL
             AND source_url NOT LIKE 'https://ticketmaster.evyy.net/%'
           LIMIT $1`,
          [BATCH_SIZE]
        );
        if (rows.length === 0) break;

        for (const row of rows) {
          const tracked = trackedTicketmasterLink(row.source_url);
          if (tracked === row.source_url) {
            skippedAlreadyTracked++;
            continue;
          }
          await pool.query('UPDATE events SET source_url = $1 WHERE id = $2', [tracked, row.id]);
          updated++;
        }
      }
      await logProviderSync({
        providerName: 'ticketmaster', syncType: 'affiliate_link_backfill', startedAt, finishedAt: new Date(),
        recordsReceived: updated + skippedAlreadyTracked, recordsUpdated: updated, status: 'success',
        errorMessage: null,
      });
    } catch (error) {
      console.error('Error wrapping Ticketmaster affiliate links:', error);
      await logProviderSync({
        providerName: 'ticketmaster', syncType: 'affiliate_link_backfill', startedAt, finishedAt: new Date(),
        recordsReceived: null, recordsUpdated: updated, status: 'error', errorMessage: error.message,
      });
    }
  })();
});

// Rebuilds canonical_events + ticket_offers from the current `events` table
// (the real source of truth) using the same cross-source matching logic that
// powers the live price-comparison feature. Safe to run repeatedly — fully
// replaces the derived tables' contents each time rather than trying to
// incrementally patch them, since they're a materialized view of `events`,
// not independently-edited data. Does NOT touch `events`, click_events, or
// the live /api/events route.
//
// Was synchronous (awaited the whole rebuild before responding) — fine back
// when `events` was ~130k rows, but the TicketNetwork catalog ingest
// (2026-09-11, services/ticketnetwork.js) brought the table to ~340k rows,
// and a manual rebuild call at that size was observed live to hang for
// minutes and make the REST OF THE SITE briefly unresponsive (other
// requests, including GET /admin/stats, started timing out/502-ing while it
// ran) — the per-row sequential INSERTs inside one long request apparently
// saturate the single Node process/DB pool enough to starve everything
// else. Same background-response fix as /sync/* and /backfill/* above:
// respond immediately, keep running server-side, check GET /admin/health
// (syncType 'canonicalize') or Railway logs for the real result.
router.post('/canonicalize/rebuild', async (req, res) => {
  const providedKey = req.headers['x-sync-key'];
  const expectedKey = process.env.SYNC_SECRET_KEY;
  if (!expectedKey) {
    return res.status(503).json({ error: 'SYNC_SECRET_KEY is not configured on the server' });
  }
  if (!providedKey || providedKey !== expectedKey) {
    return res.status(403).json({ error: 'Invalid or missing sync key' });
  }

  const startedAt = new Date();
  res.json({ success: true, message: 'Canonical rebuild started in the background. Check GET /admin/health or Railway logs for completion.' });

  rebuildCanonicalEvents()
    .then((result) => logProviderSync({
      providerName: 'canonicalize', syncType: 'rebuild', startedAt, finishedAt: new Date(),
      recordsReceived: result.rawEventRows ?? null, recordsUpdated: result.canonicalEvents ?? null,
      status: 'success', errorMessage: result.skippedNoProvider > 0 ? `${result.skippedNoProvider} offer(s) skipped — no matching providers row` : null,
    }))
    .catch((error) => {
      console.error('Background canonical rebuild failed:', error);
      return logProviderSync({
        providerName: 'canonicalize', syncType: 'rebuild', startedAt, finishedAt: new Date(),
        recordsReceived: null, recordsUpdated: null, status: 'error', errorMessage: error.message,
      });
    });
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

// One-time reset, requested by the user to start Ticketmaster's data over
// from scratch rather than keep chasing whatever produced the current
// priced/unpriced split: deletes every raw events row with source =
// 'ticketmaster'. Leaves SeatGeek/TicketNetwork/official rows untouched.
// Safe to call even if already empty (zero-row DELETE). Run
// POST /admin/canonicalize/rebuild afterward so canonical_events/
// ticket_offers stop referencing the deleted rows, then
// POST /admin/sync/ticketmaster to repopulate fresh from the Discovery API.
//
// Runs in the background rather than awaiting the DELETE synchronously —
// the first live run of this route (2026-09-13, events table at ~340k rows
// across all sources) came back as a client-side "upstream error" from
// Railway's proxy, the same failure mode /sync/* and /backfill/* were
// already fixed for elsewhere in this file: a single-statement DELETE
// against a table this size can outlast the proxy's timeout even though
// Postgres keeps executing it server-side. Check GET /admin/health or
// Railway logs for the real row count deleted instead of the HTTP response.
router.post('/cleanup/ticketmaster-data', async (req, res) => {
  const providedKey = req.headers['x-sync-key'];
  const expectedKey = process.env.SYNC_SECRET_KEY;
  if (!expectedKey || !providedKey || providedKey !== expectedKey) {
    return res.status(403).json({ error: 'Invalid or missing sync key' });
  }

  const startedAt = new Date();
  res.json({
    success: true,
    message: 'Deleting all ticketmaster events in the background. Check GET /admin/health or Railway logs for completion, then run POST /admin/canonicalize/rebuild followed by POST /admin/sync/ticketmaster.',
  });

  pool.query(`DELETE FROM events WHERE source = 'ticketmaster'`)
    .then((deleted) => logProviderSync({
      providerName: 'ticketmaster', syncType: 'cleanup_delete', startedAt, finishedAt: new Date(),
      recordsReceived: null, recordsUpdated: deleted.rowCount, status: 'success', errorMessage: null,
    }))
    .catch((error) => {
      console.error('Background ticketmaster cleanup delete failed:', error);
      return logProviderSync({
        providerName: 'ticketmaster', syncType: 'cleanup_delete', startedAt, finishedAt: new Date(),
        recordsReceived: null, recordsUpdated: null, status: 'error', errorMessage: error.message,
      });
    });
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
//
// Respond immediately and run in the background (same fix as /sync/* above)
// rather than awaiting the whole batch synchronously. This used to await —
// fine for the default limit=100 (~100 events * ~200-500ms/call is well
// under any proxy timeout), but clearing a real backlog by hand needs a much
// larger limit, and at that size the batch can run for several minutes,
// which is exactly the shape of request Railway's proxy won't hold open
// (see the /sync/* comments above). A synchronous large-limit call was
// timing out client-side with no way to tell whether the batch even
// finished server-side. Check GET /admin/health or Railway logs for the
// real result instead of the HTTP response.
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
  res.json({ success: true, message: `Ticketmaster price backfill started in the background (limit=${limit}). Check GET /admin/health or Railway logs for completion.` });

  getProvider('ticketmaster').backfillPrices(limit)
    .then((result) => logProviderSync({
      providerName: 'ticketmaster', syncType: 'price_backfill', startedAt, finishedAt: new Date(),
      recordsReceived: result.checked ?? null, recordsUpdated: result.updated ?? null,
      status: result.success ? 'success' : 'error', errorMessage: result.error ?? backfillDiagnosticMessage(result),
    }))
    .catch((error) => {
      console.error('Background Ticketmaster price backfill failed:', error);
      return logProviderSync({
        providerName: 'ticketmaster', syncType: 'price_backfill', startedAt, finishedAt: new Date(),
        recordsReceived: null, recordsUpdated: null, status: 'error', errorMessage: error.message,
      });
    });
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
  res.json({ success: true, message: `SeatGeek price backfill started in the background (limit=${limit}). Check GET /admin/health or Railway logs for completion.` });

  getProvider('seatgeek').backfillPrices(limit)
    .then((result) => logProviderSync({
      providerName: 'seatgeek', syncType: 'price_backfill', startedAt, finishedAt: new Date(),
      recordsReceived: result.checked ?? null, recordsUpdated: result.updated ?? null,
      status: result.success ? 'success' : 'error', errorMessage: result.error ?? backfillDiagnosticMessage(result),
    }))
    .catch((error) => {
      console.error('Background SeatGeek price backfill failed:', error);
      return logProviderSync({
        providerName: 'seatgeek', syncType: 'price_backfill', startedAt, finishedAt: new Date(),
        recordsReceived: null, recordsUpdated: null, status: 'error', errorMessage: error.message,
      });
    });
});

// Targeted counterpart to POST /sync/seatgeek's broad regional discovery —
// walks the site's own soonest-upcoming events (the ones customers see
// first) and does a per-event SeatGeek search + isSameEvent match (see
// services/seatgeek.js's syncSeatGeekMatchesForExistingEvents for the full
// story) instead of bulk-fetching SeatGeek's whole catalog and hoping for
// overlap. ?limit= (default 100) is how many of our own soonest events to
// check, not how many SeatGeek results to fetch.
router.post('/sync/seatgeek-match-events', async (req, res) => {
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

  // Same reasoning as POST /sync/seatgeek: with a politeness delay per
  // request this can take a couple minutes for limit=100, which risks
  // Railway's proxy timeout if the caller waits synchronously. Respond
  // immediately; check GET /admin/health or Railway logs for completion.
  res.json({ success: true, message: `SeatGeek match sync started in the background (limit=${limit}). Check GET /admin/health or Railway logs for completion.` });

  syncSeatGeekMatchesForExistingEvents(limit)
    .then((result) => logProviderSync({
      providerName: 'seatgeek', syncType: 'match_existing', startedAt, finishedAt: new Date(),
      recordsReceived: result.checked ?? null, recordsUpdated: result.stored ?? null,
      status: result.success ? 'success' : 'error',
      errorMessage: result.error ?? (result.apiErrors > 0 ? `${result.apiErrors} API error(s) during search` : null),
    }))
    .catch((error) => {
      console.error('Background SeatGeek match sync failed:', error);
      return logProviderSync({
        providerName: 'seatgeek', syncType: 'match_existing', startedAt, finishedAt: new Date(),
        recordsReceived: null, recordsUpdated: null, status: 'error', errorMessage: error.message,
      });
    });
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
    const [events, priced, bySource, pricedBySource, canonical, offers, providers] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS count FROM events'),
      pool.query('SELECT COUNT(*)::int AS count FROM events WHERE min_price IS NOT NULL'),
      pool.query('SELECT source, COUNT(*)::int AS count FROM events GROUP BY source ORDER BY source'),
      // Same cut as eventsBySource, but only rows with a real price — lets
      // the dashboard show "X of Y SeatGeek events priced" instead of just
      // the platform-wide eventsWithPrice total, which on its own can't
      // tell whether one source's backfill is lagging the other's.
      pool.query('SELECT source, COUNT(*)::int AS count FROM events WHERE min_price IS NOT NULL GROUP BY source ORDER BY source'),
      pool.query('SELECT COUNT(*)::int AS count FROM canonical_events').catch(() => ({ rows: [{ count: null }] })),
      pool.query('SELECT COUNT(*)::int AS count FROM ticket_offers').catch(() => ({ rows: [{ count: null }] })),
      pool.query('SELECT name, active, affiliate_enabled FROM providers ORDER BY name').catch(() => ({ rows: [] })),
    ]);

    res.json({
      success: true,
      totalEvents: events.rows[0].count,
      eventsWithPrice: priced.rows[0].count,
      eventsBySource: bySource.rows,
      eventsWithPriceBySource: pricedBySource.rows,
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

// Diagnostic breakdown by referrer/session/landing-page — NOT shown on the
// main dashboard, added specifically to tell real visitor traffic apart
// from bots/scripts hitting POST /api/clicks directly (which skip the
// browser entirely, so they have no real referrer and often reuse or fake
// a session id). Read-only, same auth as the rest of this file.
router.get('/analytics/click-detail', requireAdminAccess, async (req, res) => {
  try {
    const [byReferrer, bySession, byLandingPage, recentSample] = await Promise.all([
      pool.query(`
        SELECT COALESCE(NULLIF(referrer, ''), '(none)') AS referrer, COUNT(*)::int AS count
        FROM click_events
        GROUP BY 1
        ORDER BY count DESC
        LIMIT 20
      `),
      pool.query(`
        SELECT session_id, COUNT(*)::int AS count,
               MIN(created_at) AS first_click, MAX(created_at) AS last_click,
               COUNT(DISTINCT event_row_id)::int AS distinct_events
        FROM click_events
        WHERE session_id IS NOT NULL
        GROUP BY session_id
        ORDER BY count DESC
        LIMIT 20
      `),
      pool.query(`
        SELECT COALESCE(NULLIF(landing_page, ''), '(none)') AS landing_page, COUNT(*)::int AS count
        FROM click_events
        GROUP BY 1
        ORDER BY count DESC
        LIMIT 20
      `),
      pool.query(`
        SELECT created_at, source, event_title, city, state, device_type, referrer, session_id
        FROM click_events
        ORDER BY created_at DESC
        LIMIT 30
      `),
    ]);

    res.json({
      success: true,
      byReferrer: byReferrer.rows,
      bySession: bySession.rows,
      byLandingPage: byLandingPage.rows,
      recentSample: recentSample.rows,
    });
  } catch (error) {
    console.error('Error computing click detail:', error);
    res.status(200).json({ success: false, error: error.message });
  }
});

// One-off diagnostic: the comprehensive Ticketmaster/SeatGeek syncs both
// came back with totalEvents: 0 (success: true) despite the older, known-
// working code paths being untouched — which points at something wrong
// with the API keys/quota themselves rather than the new sync logic
// (a bug in new code would still leave the old per-market fetches working).
// Makes one cheap, direct call to each provider's own API and reports the
// raw HTTP status/error back, without going through any of the sync
// machinery — read-only, same auth as the rest of this file.
router.get('/diagnostics/providers', requireAdminAccess, async (req, res) => {
  const results = {};

  const tmKey = process.env.TICKETMASTER_API_KEY;
  results.ticketmaster = { keyConfigured: !!tmKey };
  if (tmKey) {
    try {
      const r = await axios.get('https://app.ticketmaster.com/discovery/v2/events.json', {
        params: { apikey: tmKey, size: 1 },
      });
      results.ticketmaster.status = r.status;
      results.ticketmaster.eventCount = r.data?._embedded?.events?.length ?? 0;
      results.ticketmaster.pageInfo = r.data?.page ?? null;
    } catch (error) {
      results.ticketmaster.status = error.response?.status ?? null;
      results.ticketmaster.error = error.response?.data ?? error.message;
    }
  }

  const sgKey = process.env.SEATGEEK_CLIENT_ID;
  results.seatgeek = { keyConfigured: !!sgKey };
  if (sgKey) {
    try {
      // Sorted soonest-first (matches backfillMissingPrices' own queue order)
      // and per_page raised to 5 so we get real upcoming events to inspect,
      // not just whatever SeatGeek's default ordering happens to return.
      // 'taxonomies.name': 'concert' matches what services/seatgeek.js's own
      // sync calls actually filter on (see fetchSeatGeekConcerts etc.) —
      // omitting it the first time round surfaced SeatGeek's own unfiltered
      // "PARKING" pass listings instead of real events, which was a false
      // lead, not a real finding.
      const r = await axios.get('https://api.seatgeek.com/2/events', {
        params: {
          client_id: sgKey,
          per_page: 5,
          'taxonomies.name': 'concert',
          sort: 'datetime_local.asc',
          'datetime_local.gte': new Date().toISOString().slice(0, 10),
        },
      });
      results.seatgeek.status = r.status;
      results.seatgeek.eventCount = r.data?.events?.length ?? 0;
      results.seatgeek.meta = r.data?.meta ?? null;
      // Diagnostic for "backfill always reports no price at the source":
      // shows the LISTING endpoint's own stats for a few real soon-upcoming
      // events (what storeEvent/sync sees) side by side with the per-event
      // DETAIL endpoint's stats for the same ids (what backfillMissingPrices
      // actually reads via fetchSeatGeekEventById) — if these disagree with
      // what the backfill logs report, the bug is in how we read the detail
      // response, not a real data-source gap.
      const sampleEvents = (r.data?.events || []).map((e) => ({
        id: e.id,
        title: e.title,
        datetime_local: e.datetime_local,
        listingStats: e.stats ?? null,
      }));
      const detailChecks = [];
      for (const ev of sampleEvents) {
        try {
          const d = await axios.get(`https://api.seatgeek.com/2/events/${ev.id}`, { params: { client_id: sgKey } });
          detailChecks.push({ id: ev.id, detailStats: d.data?.stats ?? null, hasDataKey: Object.prototype.hasOwnProperty.call(d.data || {}, 'stats') });
        } catch (e2) {
          detailChecks.push({ id: ev.id, detailError: e2.response?.status ?? e2.message });
        }
      }
      results.seatgeek.sampleEvents = sampleEvents;
      results.seatgeek.detailChecks = detailChecks;
      // Rules out "pricing moved to a different field" — dumps every
      // top-level key SeatGeek's detail response actually has, plus the raw
      // stats object's own keys (if it has any at all), for the first
      // sample event only.
      if (sampleEvents[0]) {
        try {
          const d = await axios.get(`https://api.seatgeek.com/2/events/${sampleEvents[0].id}`, { params: { client_id: sgKey } });
          results.seatgeek.rawTopLevelKeys = Object.keys(d.data || {});
          results.seatgeek.rawStatsKeys = Object.keys(d.data?.stats || {});
          results.seatgeek.rawStatsValue = d.data?.stats;
        } catch (e3) {
          results.seatgeek.rawDumpError = e3.response?.status ?? e3.message;
        }
      }
    } catch (error) {
      results.seatgeek.status = error.response?.status ?? null;
      results.seatgeek.error = error.response?.data ?? error.message;
    }
  }

  // TicketNetwork, via the Impact.com affiliate Partner API (their real
  // catalog-based integration, not just tracked links). Confirmed working
  // credentials/endpoint live-tested from the browser against Impact.com's
  // dashboard; this repeats that same call server-to-server via axios,
  // since the browser-side call to the bulk Items endpoint failed with what
  // looked like a CORS restriction specific to that large resource (the
  // small /Campaigns and /Catalogs metadata endpoints worked fine in the
  // browser). Catalog 1872 ("Ticketnetwork Product Catalog API") is the
  // ~210k-item, auto-updating catalog meant for programmatic consumption.
  const tnSid = process.env.TICKETNETWORK_ACCOUNT_SID;
  const tnToken = process.env.TICKETNETWORK_AUTH_TOKEN;
  results.ticketnetwork = { keyConfigured: !!(tnSid && tnToken) };
  if (tnSid && tnToken) {
    try {
      const auth = 'Basic ' + Buffer.from(`${tnSid}:${tnToken}`).toString('base64');
      const pageSize = Math.min(parseInt(req.query.tnPageSize, 10) || 50, 100);
      const r = await axios.get(`https://api.impact.com/Mediapartners/${tnSid}/Catalogs/1872/Items`, {
        params: { PageSize: pageSize },
        headers: { Authorization: auth, Accept: 'application/json' },
      });
      results.ticketnetwork.status = r.status;
      results.ticketnetwork.rawTopLevelKeys = Object.keys(r.data || {});
      results.ticketnetwork.total = r.data?.['@total'] ?? null;
      // Impact's Items response shape isn't confirmed yet, so dump whatever
      // array-shaped field is actually present, plus one full sample item's
      // field list, so the real schema (price/name/date/venue/url fields)
      // can be read directly off this diagnostic before writing the
      // ingestion service.
      const possibleArrayKeys = Object.keys(r.data || {}).filter((k) => Array.isArray(r.data[k]));
      results.ticketnetwork.arrayFieldsFound = possibleArrayKeys;
      let items = null;
      for (const k of possibleArrayKeys) {
        if (r.data[k].length) { items = r.data[k]; break; }
      }
      if (items && items[0]) {
        results.ticketnetwork.sampleItemKeys = Object.keys(items[0]);
        results.ticketnetwork.sampleItem = items[0];
        results.ticketnetwork.sampleItemCount = items.length;
        // From the first-pass sample, Text1 looked like a "$min- $max" price
        // range string (CurrentPrice/OriginalPrice were both empty) and
        // Category looked like it holds the event type ("CONCERTS"). This
        // checks those hunches across a bigger, mixed sample before we build
        // the real mapping.
        results.ticketnetwork.categories = [...new Set(items.map((i) => i.Category))];
        results.ticketnetwork.text1Samples = items.slice(0, 20).map((i) => i.Text1);
        const priced = items.filter((i) => i.Text1 && i.Text1 !== '$0.00- $0.00' && i.Text1.trim() !== '');
        results.ticketnetwork.pricedCount = priced.length;
        results.ticketnetwork.pricedSampleItems = priced.slice(0, 5).map((i) => ({
          Name: i.Name, Labels: i.Labels, LaunchDate: i.LaunchDate, Gtin: i.Gtin, Mpn: i.Mpn,
          Category: i.Category, Text1: i.Text1, CurrentPrice: i.CurrentPrice, OriginalPrice: i.OriginalPrice,
        }));
      } else {
        results.ticketnetwork.rawBodySnippet = JSON.stringify(r.data).slice(0, 2000);
      }
    } catch (error) {
      results.ticketnetwork.status = error.response?.status ?? null;
      results.ticketnetwork.error = error.response?.data ?? error.message;
    }
  }

  res.json({ success: true, results });
});

// Read-only diagnostic: how many Ticketmaster events are the SAME real-world
// event as one already listed by TicketNetwork — i.e. how many canonical
// (merged/deduped) events carry offers from both sources. This reads the
// derived canonical_events/ticket_offers tables built by
// POST /admin/canonicalize/rebuild, so it reflects whatever data was present
// as of the LAST rebuild, not necessarily the very latest raw `events` rows
// — run a rebuild first if a just-completed sync should be reflected here.
router.get('/diagnostics/source-overlap', requireAdminAccess, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      WITH per_event AS (
        SELECT
          o.canonical_event_id,
          BOOL_OR(p.name = 'ticketmaster') AS has_ticketmaster,
          BOOL_OR(p.name = 'ticketnetwork') AS has_ticketnetwork,
          BOOL_OR(p.name = 'seatgeek') AS has_seatgeek
        FROM ticket_offers o
        JOIN providers p ON p.id = o.provider_id
        GROUP BY o.canonical_event_id
      )
      SELECT
        COUNT(*) FILTER (WHERE has_ticketmaster) AS ticketmaster_canonical_events,
        COUNT(*) FILTER (WHERE has_ticketnetwork) AS ticketnetwork_canonical_events,
        COUNT(*) FILTER (WHERE has_ticketmaster AND has_ticketnetwork) AS overlap_ticketmaster_and_ticketnetwork,
        COUNT(*) FILTER (WHERE has_ticketmaster AND NOT has_ticketnetwork) AS ticketmaster_only,
        COUNT(*) FILTER (WHERE has_ticketnetwork AND NOT has_ticketmaster) AS ticketnetwork_only
      FROM per_event;
    `);

    const canonicalizeLastRun = await pool.query(`
      SELECT finished_at FROM provider_sync_logs
      WHERE provider_name = 'canonicalize' AND sync_type = 'rebuild' AND status = 'success'
      ORDER BY finished_at DESC LIMIT 1
    `).catch(() => ({ rows: [] })); // tolerate provider_sync_logs not existing/queryable rather than failing the whole diagnostic

    res.json({
      success: true,
      ...rows[0],
      note: 'Counts are canonical (deduped) events, not raw rows — a Ticketmaster event and a TicketNetwork event only count as "overlap" when they were matched as the same real-world event by the canonicalize rebuild (utils/matching.js\'s isSameEvent). Run POST /admin/canonicalize/rebuild first if recent sync activity should be reflected here.',
      canonicalizeLastRunFinishedAt: canonicalizeLastRun.rows[0]?.finished_at ?? null,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Targeted counterpart to /diagnostics/source-overlap above: instead of
// reading the full-catalog canonicalize rebuild (which has been observed to
// take a very long time / possibly stall at the events table's current
// size — see /canonicalize/rebuild's comment), this checks JUST the
// closest `limit` (default 5000, matching POST /sync/ticketmaster-closest's
// default) upcoming Ticketmaster events against TicketNetwork directly,
// live, using the same isSameEvent matching (utils/matching.js) — no
// rebuild required, and it runs fast because it only loads TicketNetwork
// rows that fall inside the date range those Ticketmaster events actually
// span (a plain indexed BETWEEN on `date`), not the whole ~210k-row
// TicketNetwork catalog.
router.get('/diagnostics/closest-ticketmaster-overlap', requireAdminAccess, async (req, res) => {
  try {
    const requestedLimit = Number(req.query.limit);
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : 5000;

    const tmResult = await pool.query(
      `SELECT id, external_id, title, date, city, state, venue_name, source_url, min_price, source
       FROM events
       WHERE source = 'ticketmaster' AND date >= NOW()
       ORDER BY date ASC
       LIMIT $1`,
      [limit]
    );
    const tmRows = tmResult.rows;

    if (tmRows.length === 0) {
      return res.json({
        success: true,
        ticketmasterChecked: 0,
        overlapCount: 0,
        overlapPct: null,
        matches: [],
        note: 'No upcoming Ticketmaster events found — run POST /admin/sync/ticketmaster-closest first.',
      });
    }

    // Bound the TicketNetwork query to the date window the fetched
    // Ticketmaster events actually span (±1 day either end, matching the
    // ±1-day tolerance isSameDay allows — see utils/matching.js) instead of
    // pulling the entire TicketNetwork catalog into memory.
    const minDate = new Date(Math.min(...tmRows.map((r) => new Date(r.date).getTime())) - 24 * 60 * 60 * 1000);
    const maxDate = new Date(Math.max(...tmRows.map((r) => new Date(r.date).getTime())) + 24 * 60 * 60 * 1000);

    const tnResult = await pool.query(
      `SELECT id, external_id, title, date, city, state, venue_name, source_url, min_price, source
       FROM events
       WHERE source = 'ticketnetwork' AND date BETWEEN $1 AND $2`,
      [minDate, maxDate]
    );
    const tnRows = tnResult.rows;

    // Bucket TicketNetwork candidates by city (the cheap, high-selectivity
    // part of isSameEvent's match criteria) so each Ticketmaster row is only
    // compared against same-city candidates, not the whole tnRows array —
    // same O(n)-not-O(n^2) reasoning as mergeEventsAcrossSources/
    // rebuildCanonicalEvents.
    const tnByCity = new Map();
    for (const tn of tnRows) {
      const key = (tn.city || '').toLowerCase().trim();
      if (!tnByCity.has(key)) tnByCity.set(key, []);
      tnByCity.get(key).push(tn);
    }

    const matches = [];
    for (const tm of tmRows) {
      const candidates = tnByCity.get((tm.city || '').toLowerCase().trim()) || [];
      const match = candidates.find((tn) => isSameEvent(tm, tn));
      if (match) {
        matches.push({
          title: tm.title,
          city: tm.city,
          state: tm.state,
          ticketmaster: { id: tm.id, external_id: tm.external_id, date: tm.date, venue_name: tm.venue_name, min_price: tm.min_price, source_url: tm.source_url },
          ticketnetwork: { id: match.id, external_id: match.external_id, date: match.date, venue_name: match.venue_name, min_price: match.min_price, source_url: match.source_url },
        });
      }
    }

    res.json({
      success: true,
      ticketmasterChecked: tmRows.length,
      ticketnetworkCandidatesLoaded: tnRows.length,
      dateRangeChecked: { from: minDate, to: maxDate },
      overlapCount: matches.length,
      overlapPct: Number(((matches.length / tmRows.length) * 100).toFixed(1)),
      note: 'overlapCount is how many of the checked Ticketmaster events matched a TicketNetwork event for the SAME real-world show (utils/matching.js\'s isSameEvent — exact city/state + strong title or venue match, ±1-day tolerant of TicketNetwork\'s date-only listings). matches lists every confirmed pair.',
      matches,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Read-back for POST /sync/seatgeek-match-events — that sync runs in the
// background (live per-event SeatGeek API calls, too slow to wait on
// synchronously — see its comment), so this is how to check its results
// afterward: pure DB reads against what's already in the events table now
// instead of calling SeatGeek live.
//
// Deliberately does NOT reuse isSameEvent's full logic (unlike
// /diagnostics/closest-ticketmaster-overlap above) — running it here
// against the SeatGeek catalog surfaced real false positives in
// production: isSameEvent's weak-title/strong-venue fallback branch (added
// for team-sports matchups, see utils/matching.js's comment on it) matched
// completely unrelated recurring timed-entry attractions ("The Banksy
// Museum New York!" vs. "The Great Gatsby The Musical", repeated across
// every showtime) purely because both venues' names happened to share
// generic city-name tokens ("New York"). That branch was designed for
// isSameEvent's original use case — deduping within an already date/city-
// narrowed candidate pool built from full-catalog syncs — and isn't safe
// to reuse verbatim here. This diagnostic instead requires a STRONG direct
// title match on its own (same TITLE_STRONG_MATCH threshold isSameEvent
// uses for its strong-match branch), which is the reliable signal.
router.get('/diagnostics/first-events-seatgeek-match', requireAdminAccess, async (req, res) => {
  try {
    const requestedLimit = Number(req.query.limit);
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : 100;

    const ourResult = await pool.query(
      `SELECT id, external_id, title, date, city, state, venue_name, source_url, min_price, source
       FROM events
       WHERE source != 'seatgeek' AND date >= NOW()
       ORDER BY date ASC
       LIMIT $1`,
      [limit]
    );
    const ourRows = ourResult.rows;

    if (ourRows.length === 0) {
      return res.json({ success: true, checked: 0, matchCount: 0, matches: [], note: 'No upcoming events found.' });
    }

    const minDate = new Date(Math.min(...ourRows.map((r) => new Date(r.date).getTime())) - 2 * 24 * 60 * 60 * 1000);
    const maxDate = new Date(Math.max(...ourRows.map((r) => new Date(r.date).getTime())) + 2 * 24 * 60 * 60 * 1000);

    const sgResult = await pool.query(
      `SELECT id, external_id, title, date, city, state, venue_name, source_url, min_price
       FROM events
       WHERE source = 'seatgeek' AND date BETWEEN $1 AND $2`,
      [minDate, maxDate]
    );
    const sgRows = sgResult.rows;

    const sgByCity = new Map();
    for (const sg of sgRows) {
      const key = (sg.city || '').toLowerCase().trim();
      if (!sgByCity.has(key)) sgByCity.set(key, []);
      sgByCity.get(key).push(sg);
    }

    // Same threshold isSameEvent uses for its own strong-match branch
    // (utils/matching.js's TITLE_STRONG_MATCH, not exported — kept in sync
    // manually since it's a stable, rarely-changed constant).
    const TITLE_STRONG_MATCH = 0.6;

    const matches = [];
    for (const ours of ourRows) {
      const candidates = sgByCity.get((ours.city || '').toLowerCase().trim()) || [];
      const match = candidates.find((sg) =>
        isSameDay(ours.date, sg.date) &&
        (ours.state || '').toLowerCase().trim() === (sg.state || '').toLowerCase().trim() &&
        tokenSimilarity(ours.title, sg.title) >= TITLE_STRONG_MATCH
      );
      if (match) {
        matches.push({
          title: ours.title,
          city: ours.city,
          state: ours.state,
          date: ours.date,
          originalSource: ours.source,
          originalPrice: ours.min_price,
          seatgeekPrice: match.min_price,
          seatgeekUrl: match.source_url,
        });
      }
    }

    res.json({
      success: true,
      checked: ourRows.length,
      matchCount: matches.length,
      matchPct: Number(((matches.length / ourRows.length) * 100).toFixed(1)),
      note: 'Checks the same "first N soonest-upcoming events" set POST /sync/seatgeek-match-events uses, against SeatGeek rows already stored in the events table. Run that sync first if this looks stale.',
      matches,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
