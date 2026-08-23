import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import 'express-async-errors';
import { Pool } from 'pg';

// Routes
import eventsRoutes from './routes/events.js';
import adminRoutes from './routes/admin.js';
import clicksRoutes from './routes/clicks.js';
import redirectRoutes from './routes/redirect.js';
import sitemapRoutes from './routes/sitemap.js';
import prerenderRoutes from './routes/prerender.js';

// Price backfill — see scheduled job below.
import { backfillMissingPrices as backfillTicketmasterPrices } from './services/ticketmaster.js';
import { backfillMissingPrices as backfillSeatGeekPrices } from './services/seatgeek.js';
import { logProviderSync } from './utils/syncLog.js';

// Official-sites discovery + sync — see scheduled job below.
import { discoverArtistOfficialSites } from './services/officialSiteDiscovery.js';
import { syncOfficialSites } from './services/officialSites.js';

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
app.use('/go', redirectRoutes);
app.use('/', sitemapRoutes);
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
// needing to trigger it by hand. Batched (300 events per source per run) and
// rate-limited internally, so each run only takes a couple of minutes.
const BACKFILL_INTERVAL_MS = 24 * 60 * 60 * 1000; // once a day
const BACKFILL_BATCH_SIZE = 300;

async function runScheduledPriceBackfill() {
console.log('🔄 Running scheduled price backfill...');
let startedAt = new Date();
try {
const tmResult = await backfillTicketmasterPrices(BACKFILL_BATCH_SIZE);
console.log('Ticketmaster backfill result:', tmResult);
await logProviderSync({
  providerName: 'ticketmaster', syncType: 'price_backfill', startedAt, finishedAt: new Date(),
  recordsReceived: tmResult.checked ?? null, recordsUpdated: tmResult.updated ?? null,
  status: tmResult.success ? 'success' : 'error', errorMessage: tmResult.error ?? null,
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
  status: sgResult.success ? 'success' : 'error', errorMessage: sgResult.error ?? null,
});
} catch (err) {
console.error('SeatGeek backfill failed:', err);
await logProviderSync({ providerName: 'seatgeek', syncType: 'price_backfill', startedAt, finishedAt: new Date(), status: 'error', errorMessage: err.message });
}
}

// First run 5 minutes after boot (so it doesn't compete with startup
// traffic), then every 24 hours after that.
setTimeout(runScheduledPriceBackfill, 5 * 60 * 1000);
setInterval(runScheduledPriceBackfill, BACKFILL_INTERVAL_MS);

// Official-sites discovery + sync — makes the "obtain offers from official
// concert websites" feature fully automatic instead of requiring someone to
// hand-research and POST new URLs. Each run: (1) looks up artists already in
// our own events table against Ticketmaster's Attractions API to find any
// new official homepages, adding them to official_sources, then (2) syncs
// every active official_sources row (old and newly-discovered) for
// schema.org/JSON-LD events, same as the manual /admin/sync/official-sites
// endpoint. Runs daily — new artists show up gradually as Ticketmaster/
// SeatGeek syncs bring in new events, so there's no need to run more often.
const OFFICIAL_SITES_INTERVAL_MS = 24 * 60 * 60 * 1000; // once a day
const OFFICIAL_SITES_DISCOVERY_BATCH = 15;

async function runScheduledOfficialSitesJob() {
console.log('🔎 Running scheduled official-sites discovery...');
let startedAt = new Date();
try {
const discoverResult = await discoverArtistOfficialSites(OFFICIAL_SITES_DISCOVERY_BATCH);
console.log('Official-sites discovery result:', discoverResult);
await logProviderSync({
  providerName: 'official', syncType: 'discovery_search', startedAt, finishedAt: new Date(),
  recordsReceived: discoverResult.candidatesChecked ?? null, recordsUpdated: discoverResult.discovered ?? null,
  status: discoverResult.success ? 'success' : 'error', errorMessage: discoverResult.error ?? null,
});
} catch (err) {
console.error('Official-sites discovery failed:', err);
await logProviderSync({ providerName: 'official', syncType: 'discovery_search', startedAt, finishedAt: new Date(), status: 'error', errorMessage: err.message });
}

console.log('🔄 Running scheduled official-sites sync...');
startedAt = new Date();
try {
const { rows } = await pool.query(
  'SELECT id, url, label, category FROM official_sources WHERE active = true ORDER BY id'
);
const syncResult = rows.length > 0
  ? await syncOfficialSites(rows)
  : { success: true, sitesProcessed: 0, totalEventsFound: 0, totalEventsStored: 0, sitesWithErrors: 0 };
console.log('Official-sites sync result:', syncResult);
await logProviderSync({
  providerName: 'official', syncType: 'discovery', startedAt, finishedAt: new Date(),
  recordsReceived: syncResult.totalEventsFound ?? null, recordsUpdated: syncResult.totalEventsStored ?? null,
  status: syncResult.success ? 'success' : 'error', errorMessage: syncResult.sitesWithErrors ? `${syncResult.sitesWithErrors} site(s) failed` : null,
});
} catch (err) {
console.error('Official-sites sync failed:', err);
await logProviderSync({ providerName: 'official', syncType: 'discovery', startedAt, finishedAt: new Date(), status: 'error', errorMessage: err.message });
}
}

// Staggered 10 minutes after boot (after price backfill's 5-minute slot),
// then daily after that — same pattern as the price backfill job above.
setTimeout(runScheduledOfficialSitesJob, 10 * 60 * 1000);
setInterval(runScheduledOfficialSitesJob, OFFICIAL_SITES_INTERVAL_MS);
