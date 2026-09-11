import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import 'express-async-errors';
import { Pool } from 'pg';

// Routes
import eventsRoutes from './routes/events.js';
import adminRoutes, { backfillDiagnosticMessage } from './routes/admin.js';
import clicksRoutes from './routes/clicks.js';
import redirectRoutes from './routes/redirect.js';
import sitemapRoutes from './routes/sitemap.js';
import prerenderRoutes from './routes/prerender.js';
import guidesRoutes from './routes/guides.js';
import seoPagesRoutes from './routes/seoPages.js';

// Price backfill — see scheduled job below.
import { backfillMissingPrices as backfillTicketmasterPrices } from './services/ticketmaster.js';
import { backfillMissingPrices as backfillSeatGeekPrices } from './services/seatgeek.js';
import { logProviderSync } from './utils/syncLog.js';

// Ticketmaster/SeatGeek event discovery — see scheduled job below. Until
// 2026-08 these only ever ran when someone manually POSTed to
// /admin/sync/ticketmaster or /admin/sync/seatgeek — meaning both the event
// catalog itself AND the cross-source price comparison (which depends on
// having enough overlapping coverage from both sources) went stale unless a
// human remembered to trigger a sync. This closes that gap the same way the
// price backfill and official-sites jobs already do.
import { syncAllEvents as syncTicketmasterEvents } from './services/ticketmaster.js';
import { syncSeatGeekEvents } from './services/seatgeek.js';
import { rebuildCanonicalEvents } from './services/canonicalize.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Database Connection
export const pool = new Pool({
user: process.env.DB_USER || 'eventflow',
host: process.env.DB_HOST || 'localhost',
database: process.env.DB_NAME || 'eventflow',
password: process.env.DB_PASSWORD || 'eventflow',
port: process.env.DB_PORT || 5432,
});

// Middleware
app.use(helmet());

// Allow the app's known frontend origins (custom domain + www + Vercel
// subdomain), plus whatever FRONTEND_URL is set to in the environment.
// This avoids breaking the site every time a new domain gets added.
const allowedOrigins = [
process.env.FRONTEND_URL,
'http://localhost:5173',
'https://concertandmatches.vercel.app',
'https://concertandmatches.com',
'https://www.concertandmatches.com',
].filter(Boolean);

app.use(cors({
origin: (origin, callback) => {
// Allow requests with no origin (server-to-server, curl, health checks)
if (!origin || allowedOrigins.includes(origin)) {
callback(null, true);
} else {
callback(new Error('Not allowed by CORS'));
}
},
credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Rate Limiting
const limiter = rateLimit({
windowMs: 15 * 60 * 1000,
max: 100,
message: 'Too many requests from this IP, please try again later.'
});
app.use('/api/', limiter);

// Health Check
app.get('/api/health', (req, res) => {
res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Routes
app.use('/api/events', eventsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/clicks', clicksRoutes);
// /go/event/:id IS the frontend's real "Buy Your Ticket" link (built in
// App.jsx via GO_BASE) — for a ticketmaster.com event it redirects straight
// through the real revenue-earning Impact.com tracked affiliate link. It
// was unmounted on 2026-09-07 after a click-analytics investigation found
// ~2,075 clicks logged with no referrer/session id and assumed, incorrectly,
// that the route wasn't linked from the frontend and could only be a bot
// scanning it directly — in fact it silently 404'd every real customer's
// ticket-purchase click from that point on (caught 2026-09-10: "when I
// click on buy your ticket it does not work"). Re-mounted with the actual
// missing anti-abuse protection instead: a dedicated rate limiter and a
// referer check (both in routes/redirect.js) rather than leaving the real
// buy-ticket flow broken.
app.use('/go', redirectRoutes);
app.use('/', sitemapRoutes);
app.use('/', guidesRoutes);
// Programmatic SEO pages (artists/cities/venues/leagues/teams) — see
// routes/seoPages.js and services/seoEngine.js. Mounted at root, same as
// guidesRoutes, so paths are reachable at e.g. /artists/:slug directly.
app.use('/', seoPagesRoutes);
app.use('/prerender', prerenderRoutes);

// 404 Handler
app.use((req, res) => {
res.status(404).json({ error: 'Route not found' });
});

// Error Handler
app.use((err, req, res, next) => {
console.error('Error:', err);
res.status(err.status || 500).json({
error: err.message || 'Internal Server Error',
status: err.status || 500
});
});

// Start Server
app.listen(PORT, () => {
console.log(`✅ Server running on port ${PORT}`);
console.log(`🌐 Allowed origins: ${allowedOrigins.join(', ')}`);
console.log(`📦 Database: ${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}`);
});

// Scheduled price backfill — many events get stored with min_price null
// because the bulk Ticketmaster/SeatGeek listing endpoints don't reliably
// report pricing (the price often only appears once you fetch the event's
// own detail page, and even then only once the source itself has a price to
// report — e.g. before an on-sale date, neither source has one yet). This
// runs the same backfill the /api/admin/backfill/* endpoints expose, but
// automatically, so pricing keeps filling in over time without anyone
// needing to trigger it by hand. Batched (600 events per source per run) and
// rate-limited internally.
//
// Raised from 300 to 600 alongside the date >= NOW() fix in each service's
// backfillMissingPrices() (see services/ticketmaster.js/seatgeek.js): before
// that fix, a stuck backlog of past events with permanently-unpriced rows
// could occupy the whole date-ASC queue forever, so no batch size would
// have helped — upcoming events (including next-day ones) were never
// reached no matter how many runs went by. With that starvation fixed, a
// bigger batch now actually buys real throughput: it clears the current
// backlog of near-term events noticeably faster (within roughly a day of
// scheduled runs instead of several), while staying just as safe against
// getting stuck again in the future, since any event that ages into the
// past simply drops out of the query on its own.
// Was once/day; raised to every 6 hours (4x/day) so prices on existing
// events fill in and refresh far sooner after a sync — see
// EVENT_SYNC_INTERVAL_MS below for the shared reasoning on how far this can
// go before risking Ticketmaster's daily API quota (roughly 5,000 calls/day
// on the free Discovery API tier; each backfilled event costs one call per
// source, so a full 600-event batch on both sources is up to ~1,200 calls —
// ~2,400 Ticketmaster calls/day at 4 runs/day, plus ~240/day from the event
// sync below, comfortably under the 5,000/day quota with headroom left for
// manual /admin/sync|backfill/* triggers too).
const BACKFILL_INTERVAL_MS = 6 * 60 * 60 * 1000;
const BACKFILL_BATCH_SIZE = 600;

async function runScheduledPriceBackfill() {
console.log('🔄 Running scheduled price backfill...');
let startedAt = new Date();
try {
const tmResult = await backfillTicketmasterPrices(BACKFILL_BATCH_SIZE);
console.log('Ticketmaster backfill result:', tmResult);
await logProviderSync({
  providerName: 'ticketmaster', syncType: 'price_backfill', startedAt, finishedAt: new Date(),
  recordsReceived: tmResult.checked ?? null, recordsUpdated: tmResult.updated ?? null,
  status: tmResult.success ? 'success' : 'error', errorMessage: tmResult.error ?? backfillDiagnosticMessage(tmResult),
});
} catch (err) {
console.error('Ticketmaster backfill failed:', err);
await logProviderSync({ providerName: 'ticketmaster', syncType: 'price_backfill', startedAt, finishedAt: new Date(), status: 'error', errorMessage: err.message });
}
startedAt = new Date();
try {
const sgResult = await backfillSeatGeekPrices(BACKFILL_BATCH_SIZE);
console.log('SeatGeek backfill result:', sgResult);
await logProviderSync({
  providerName: 'seatgeek', syncType: 'price_backfill', startedAt, finishedAt: new Date(),
  recordsReceived: sgResult.checked ?? null, recordsUpdated: sgResult.updated ?? null,
  status: sgResult.success ? 'success' : 'error', errorMessage: sgResult.error ?? backfillDiagnosticMessage(sgResult),
});
} catch (err) {
console.error('SeatGeek backfill failed:', err);
await logProviderSync({ providerName: 'seatgeek', syncType: 'price_backfill', startedAt, finishedAt: new Date(), status: 'error', errorMessage: err.message });
}
}

// First run 5 minutes after boot (so it doesn't compete with startup
// traffic), then every BACKFILL_INTERVAL_MS after that.
setTimeout(runScheduledPriceBackfill, 5 * 60 * 1000);
setInterval(runScheduledPriceBackfill, BACKFILL_INTERVAL_MS);

// Official-sites discovery + JSON-LD scraping job — REMOVED. It fetched
// arbitrary third-party pages and parsed structured data out of their raw
// HTML, which is direct website scraping regardless of the data being
// machine-readable JSON-LD. See backend/DATA_SOURCES.md for the full list
// of data-collection mechanisms this platform uses (Ticketmaster and
// SeatGeek's official, authenticated REST APIs only) and what was removed.
// Run POST /admin/cleanup/official-source-data once to remove the events
// this job already collected.

// Ticketmaster + SeatGeek event discovery — keeps the actual event catalog
// (and therefore the cross-source price-comparison coverage) fresh without
// anyone needing to remember to trigger it by hand. SeatGeek's sync is now
// region-segmented (venue.state, one call per US state + Canadian province —
// see services/seatgeek.js's fetchSeatGeekEventsByRegion) instead of a
// single globally-sorted feed, so its coverage actually spreads across the
// country the way Ticketmaster's per-market fetch does. SEATGEEK_PER_STATE
// is 300 (raised from the Ticketmaster-matching 100 after measuring that
// region-segmentation alone plateaued around a 3% cross-source overlap
// rate — see services/seatgeek.js's syncSeatGeekEvents comment; paginated
// internally since SeatGeek's API caps a single request at 100). Rebuilds
// the canonical_events/ticket_offers tables afterward so the admin-facing
// derived tables reflect the new data immediately rather than only on the
// next manual /admin/canonicalize/rebuild call.
// ROOT CAUSE (found 2026-09-11) of Ticketmaster prices essentially never
// filling in — this WAS 6 hours (4x/day), on the theory (see the old
// comment, preserved in git history) that a full run cost "~60 Ticketmaster
// calls". That estimate only counted fetchAllUSEvents/fetchAllCanadianEvents/
// the per-market sports variants — it completely left out the two heaviest
// calls syncTicketmasterEvents (syncAllEvents in services/ticketmaster.js)
// also makes every run: fetchTicketmasterSportsEventsNationwide (2
// countries x 2 classifications x 8 months = 32 calls) and, far bigger,
// fetchAllTicketmasterEventsNationwide — EVERY segment x EVERY country x
// EVERY month ahead, each paged up to 5 deep (2 x 5 x 9 = 90 combos, up to
// 450 calls at peak). Real cost per run is ~250-550 Ticketmaster calls, not
// ~60 — at 4 runs/day that's up to ~2,200/day from discovery ALONE, before
// the price-backfill job above (up to ~2,400/day) gets a single call in.
// Confirmed live via GET /admin/diagnostics/providers returning a bare
// Ticketmaster 429 "Rate limit quota violation" on the simplest possible
// single-event call, and backfill logs showing it exhausted on the very
// FIRST call of nearly every scheduled run — i.e. the comprehensive
// discovery sync was routinely burning the entire daily quota before
// backfill (the thing that actually puts a visible price on an event) ever
// got to run, which is exactly why Ticketmaster price coverage was stuck
// around ~6% (2,961 of 47,147) despite the COALESCE clobbering fix earlier
// this session working correctly.
//
// Fix: back to once/24h. Event LISTINGS (what discovery finds) don't
// meaningfully change hour to hour the way ticket PRICES do, so there's
// little real value in re-running the full nationwide/every-segment sweep
// 4x/day — but there's a lot of value in leaving the day's quota mostly
// free for backfillMissingPrices to actually work through the ~44k
// currently-unpriced events. New math: ~250-550/day from discovery + up to
// ~2,400/day from backfill (unchanged, still every 6h) ≈ 2,650-2,950/day,
// comfortably under the ~5,000/day quota with real headroom left for manual
// /admin/sync|backfill/* triggers and this diagnostic route. If you upgrade
// to a paid Ticketmaster tier with a higher quota, this can safely go lower
// again — watch GET /admin/health / provider_sync_logs for status:'error'
// rows (or a 429 in error_message) after any change here, since a
// rate-limited run fails loudly there, not silently.
const EVENT_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const SEATGEEK_PER_STATE = 300;

async function runScheduledEventSync() {
console.log('🔄 Running scheduled Ticketmaster sync...');
let startedAt = new Date();
try {
const tmResult = await syncTicketmasterEvents();
console.log('Ticketmaster sync result:', tmResult);
await logProviderSync({
  providerName: 'ticketmaster', syncType: 'discovery', startedAt, finishedAt: new Date(),
  recordsReceived: tmResult.totalEvents ?? null,
  status: tmResult.success ? 'success' : 'error', errorMessage: tmResult.error ?? null,
});
} catch (err) {
console.error('Ticketmaster sync failed:', err);
await logProviderSync({ providerName: 'ticketmaster', syncType: 'discovery', startedAt, finishedAt: new Date(), status: 'error', errorMessage: err.message });
}

console.log('🔄 Running scheduled SeatGeek sync...');
startedAt = new Date();
try {
const sgResult = await syncSeatGeekEvents(SEATGEEK_PER_STATE);
console.log('SeatGeek sync result:', sgResult);
await logProviderSync({
  providerName: 'seatgeek', syncType: 'discovery', startedAt, finishedAt: new Date(),
  recordsReceived: sgResult.totalEvents ?? null,
  status: sgResult.success ? 'success' : 'error', errorMessage: sgResult.error ?? null,
});
} catch (err) {
console.error('SeatGeek sync failed:', err);
await logProviderSync({ providerName: 'seatgeek', syncType: 'discovery', startedAt, finishedAt: new Date(), status: 'error', errorMessage: err.message });
}

console.log('🔄 Rebuilding canonical events after event sync...');
try {
const rebuildResult = await rebuildCanonicalEvents();
console.log('Canonicalize rebuild result:', rebuildResult);
} catch (err) {
console.error('Canonicalize rebuild failed:', err);
}
}

// Staggered 20 minutes after boot (after the price-backfill job's 5-minute
// slot — this is the heavier of the two jobs, so it goes last), then every
// EVENT_SYNC_INTERVAL_MS after that.
setTimeout(runScheduledEventSync, 20 * 60 * 1000);
setInterval(runScheduledEventSync, EVENT_SYNC_INTERVAL_MS);
