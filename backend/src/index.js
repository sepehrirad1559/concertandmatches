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

import { logProviderSync } from './utils/syncLog.js';

// Ticketmaster scheduled discovery/backfill RESTORED 2026-09-26 at the
// user's request ("since we have the api approved for ticketmaster, go
// ahead and add all kind of the events from all countries") — reversing the
// 2026-09-21 removal below. Also expanded services/ticketmaster.js's own
// fetches to search worldwide (no country restriction) instead of the old
// hardcoded US/CA-only scope — see the WORLDWIDE COVERAGE comment there.
// Uses the bounded syncClosestEvents (5,000 soonest-by-date events per run,
// cursoring forward each day — see its own comment in services/
// ticketmaster.js) rather than the unbounded syncAllEvents/
// fetchAllTicketmasterEventsNationwide: worldwide + every segment fully
// paginated could be a very large one-shot pull, and this job needs to
// finish reliably every day, not risk running for hours or blowing through
// Ticketmaster's daily API quota in one run. The one-time initial backfill
// to seed the catalog right away used the heavier comprehensive sync
// directly via POST /admin/sync/ticketmaster (see chat/session notes) —
// this scheduled job is just the ongoing, incremental keep-it-current step.
//
// SeatGeek's scheduled discovery/backfill remain REMOVED (2026-09-21, "we no
// longer need data from seatgeek and ticketmaster, remove their data from
// our platform") — the user's 2026-09-26 request named Ticketmaster only.
// services/seatgeek.js, providers/SeatGeekProvider.js, and its manual
// POST /admin/sync|backfill/seatgeek routes are still left in place —
// unused, not deleted — so re-enabling it later is the same small change as
// this one was, not rebuilding the integration from scratch.
import { syncClosestEvents as syncClosestTicketmasterEvents, backfillMissingPrices as backfillTicketmasterPrices } from './services/ticketmaster.js';
import { rebuildCanonicalEvents } from './services/canonicalize.js';

// TicketNetwork catalog sync (Impact.com affiliate feed) — services/
// ticketnetwork.js already exported a scheduleTicketNetworkSync() meant to
// run this automatically every 24h, but nothing ever called it: it wasn't
// imported here or anywhere else, so the only way this ever ran was a
// human manually POSTing to /admin/sync/ticketnetwork. That's why the
// provider health table showed no TicketNetwork discovery run for ~6
// days — the last one was the last manual trigger. Folded into
// runScheduledEventSync below (rather than calling the dead
// scheduleTicketNetworkSync, which has its own separate setInterval and
// doesn't write to provider_sync_logs) so it gets the same 24h cadence,
// staggering, and dashboard-visible logging as Ticketmaster/SeatGeek/
// curated already have.
import { syncTicketNetworkEvents } from './services/ticketnetwork.js';

// Curated attractions (e.g. Rockefeller Center) — see
// services/curatedAttractions.js. Not an external API sync: this just
// re-stamps a fixed, hand-maintained list's `date` column forward so the
// rows never fall out of the `date >= NOW()` listing filter.
import { syncCuratedAttractions } from './services/curatedAttractions.js';

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

// Scheduled Ticketmaster price backfill — RESTORED 2026-09-26 alongside the
// discovery step below (SeatGeek's stays removed, see the import comment
// above). Only 300 events/day (not the same 5,000 as discovery) since this
// hits Ticketmaster's per-event detail endpoint once per row, subject to
// its own separate 5-req/sec quota (see backfillMissingPrices' comments in
// services/ticketmaster.js) — this just needs to keep chipping away at
// whatever discovery leaves unpriced, not clear the whole backlog in one run.

// Official-sites discovery + JSON-LD scraping job — REMOVED. It fetched
// arbitrary third-party pages and parsed structured data out of their raw
// HTML, which is direct website scraping regardless of the data being
// machine-readable JSON-LD. See backend/DATA_SOURCES.md for the full list
// of data-collection mechanisms this platform uses (Ticketmaster and
// SeatGeek's official, authenticated REST APIs only) and what was removed.
// Run POST /admin/cleanup/official-source-data once to remove the events
// this job already collected.

// EVENT_SYNC_INTERVAL_MS (24h) and the staggered boot delay below predate
// both the 2026-09-21 removal and this 2026-09-26 restoration of
// Ticketmaster — unaffected either way.
const EVENT_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function runScheduledEventSync() {
console.log('🔄 Running scheduled Ticketmaster sync (worldwide, closest 5,000 by date)...');
let startedAt = new Date();
try {
  const tmResult = await syncClosestTicketmasterEvents(5000);
  console.log('Ticketmaster sync result:', tmResult);
  await logProviderSync({
    providerName: 'ticketmaster', syncType: 'closest-by-date', startedAt, finishedAt: new Date(),
    recordsReceived: tmResult.totalStored ?? null,
    status: tmResult.success ? 'success' : 'error',
    errorMessage: tmResult.error ?? (tmResult.apiErrorCount > 0 ? `${tmResult.apiErrorCount} API error(s): ${JSON.stringify(tmResult.sampleApiErrors)}` : null),
  });
} catch (err) {
  console.error('Ticketmaster sync failed:', err);
  await logProviderSync({ providerName: 'ticketmaster', syncType: 'closest-by-date', startedAt, finishedAt: new Date(), status: 'error', errorMessage: err.message });
}

console.log('🔄 Backfilling Ticketmaster prices...');
startedAt = new Date();
try {
  const tmPriceResult = await backfillTicketmasterPrices(300);
  console.log('Ticketmaster price backfill result:', tmPriceResult);
  await logProviderSync({
    providerName: 'ticketmaster', syncType: 'price_backfill', startedAt, finishedAt: new Date(),
    recordsUpdated: tmPriceResult.updated ?? null,
    status: tmPriceResult.success ? 'success' : 'error',
    errorMessage: tmPriceResult.error ?? null,
  });
} catch (err) {
  console.error('Ticketmaster price backfill failed:', err);
  await logProviderSync({ providerName: 'ticketmaster', syncType: 'price_backfill', startedAt, finishedAt: new Date(), status: 'error', errorMessage: err.message });
}

console.log('🔄 Running scheduled TicketNetwork sync...');
startedAt = new Date();
try {
// No maxPages — a full pass over the ~210k-item catalog, same as a
// manual POST /admin/sync/ticketnetwork with no ?maxPages given. Runs as
// part of this already-backgrounded 24h job, so there's no proxy-timeout
// concern the way there is for the HTTP-triggered admin route.
const tnResult = await syncTicketNetworkEvents({});
console.log('TicketNetwork sync result:', tnResult);
await logProviderSync({
  providerName: 'ticketnetwork', syncType: 'discovery', startedAt, finishedAt: new Date(),
  recordsReceived: tnResult.totalEvents ?? null,
  status: tnResult.success ? 'success' : 'error',
  errorMessage: tnResult.error ?? (tnResult.apiErrorCount > 0 ? `${tnResult.apiErrorCount} API error(s): ${JSON.stringify(tnResult.sampleApiErrors)}` : null),
});
} catch (err) {
console.error('TicketNetwork sync failed:', err);
await logProviderSync({ providerName: 'ticketnetwork', syncType: 'discovery', startedAt, finishedAt: new Date(), status: 'error', errorMessage: err.message });
}

console.log('🔄 Refreshing curated attractions (Rockefeller Center)...');
startedAt = new Date();
try {
const curatedResult = await syncCuratedAttractions();
console.log('Curated attractions refresh result:', curatedResult);
await logProviderSync({
  providerName: 'curated', syncType: 'discovery', startedAt, finishedAt: new Date(),
  recordsReceived: curatedResult.totalEvents ?? null,
  status: curatedResult.success ? 'success' : 'error',
  errorMessage: curatedResult.errors ? JSON.stringify(curatedResult.errors) : null,
});
} catch (err) {
console.error('Curated attractions refresh failed:', err);
await logProviderSync({ providerName: 'curated', syncType: 'discovery', startedAt, finishedAt: new Date(), status: 'error', errorMessage: err.message });
}

console.log('🔄 Rebuilding canonical events after event sync...');
startedAt = new Date();
try {
const rebuildResult = await rebuildCanonicalEvents();
console.log('Canonicalize rebuild result:', rebuildResult);
// Logged the same way as the post-backfill rebuild above (and as
// POST /admin/canonicalize/rebuild) so GET /admin/diagnostics/providers'
// "last successful rebuild" lookup sees scheduled runs too, not only
// manually-triggered ones. Previously this run wrote nothing at all to
// provider_sync_logs, so a daily rebuild looked identical to no rebuild.
await logProviderSync({
  providerName: 'canonicalize', syncType: 'rebuild', startedAt, finishedAt: new Date(),
  recordsReceived: rebuildResult.rawEventRows ?? null, recordsUpdated: rebuildResult.canonicalEvents ?? null,
  status: 'success',
  errorMessage: rebuildResult.skippedNoProvider > 0 ? `${rebuildResult.skippedNoProvider} offer(s) skipped — no matching providers row` : null,
});
} catch (err) {
console.error('Canonicalize rebuild failed:', err);
await logProviderSync({ providerName: 'canonicalize', syncType: 'rebuild', startedAt, finishedAt: new Date(), status: 'error', errorMessage: err.message });
}
}

// Concurrency guard — found 2026-09-21 while diagnosing why the provider
// health table showed TicketNetwork/curated/canonicalize stuck a full day
// behind Ticketmaster: every git push triggers a Railway redeploy, which
// restarts this Node process, which re-arms the "20 minutes after boot"
// timer below with NO check for whether a cycle already ran recently. A
// full cycle (Ticketmaster -> SeatGeek -> TicketNetwork's ~210k-item catalog
// -> curated -> canonicalize) easily takes over 20 minutes — especially
// now that TicketNetwork's step geocodes every not-yet-seen city (see
// services/geocode.js), which can add real time on a run that hits many
// new cities. Two (or more) deploys in the same day means a second boot
// fires a second full cycle before the first one reaches its later steps,
// and the process restarting again for the NEXT deploy kills that cycle
// mid-run — which is exactly why TicketNetwork/curated/canonicalize sat
// on yesterday's timestamps while Ticketmaster (the first, fastest step)
// kept getting fresh ones: every redeploy re-started the sequence from the
// top without ever reaching the end.
let isEventSyncRunning = false;
async function runScheduledEventSyncGuarded() {
  if (isEventSyncRunning) {
    console.log('⏭️  Skipping scheduled event sync — a run is already in progress (likely from a recent redeploy re-arming the boot timer while the prior cycle is still going).');
    return;
  }
  isEventSyncRunning = true;
  try {
    await runScheduledEventSync();
  } finally {
    isEventSyncRunning = false;
  }
}

// Only the BOOT-triggered run needs the "did a cycle already finish
// recently?" check — a redeploy shouldn't restart today's cycle just
// because the process happened to restart. The recurring setInterval below
// still fires every EVENT_SYNC_INTERVAL_MS regardless, which is the normal
// once-a-day cadence this is supposed to have.
async function maybeRunEventSyncOnBoot() {
  try {
    const { rows } = await pool.query(
      `SELECT started_at FROM provider_sync_logs
       WHERE provider_name = 'canonicalize' AND sync_type = 'rebuild' AND status = 'success'
       ORDER BY started_at DESC LIMIT 1`
    );
    const lastRun = rows[0]?.started_at ? new Date(rows[0].started_at) : null;
    const hoursSinceLastRun = lastRun ? (Date.now() - lastRun.getTime()) / (60 * 60 * 1000) : Infinity;
    // 20h, not 24h: leaves room for the boot run to still happen a bit
    // early on a genuinely new day, without re-triggering off a same-day
    // redeploy shortly after a cycle actually completed.
    if (hoursSinceLastRun < 20) {
      console.log(`⏭️  Skipping boot-triggered event sync — the last full cycle completed ${hoursSinceLastRun.toFixed(1)}h ago, within the 20h guard window. (A redeploy restarted this process, but today's sync already ran.)`);
      return;
    }
  } catch (err) {
    console.error('Could not check last event sync time — proceeding with boot-triggered sync anyway:', err.message);
  }
  await runScheduledEventSyncGuarded();
}

// Staggered 20 minutes after boot (after the price-backfill job's 5-minute
// slot — this is the heavier of the two jobs, so it goes last), then every
// EVENT_SYNC_INTERVAL_MS after that.
setTimeout(maybeRunEventSyncOnBoot, 20 * 60 * 1000);
setInterval(runScheduledEventSyncGuarded, EVENT_SYNC_INTERVAL_MS);
