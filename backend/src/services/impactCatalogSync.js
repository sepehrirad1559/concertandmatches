// =============================================================================
// impactCatalogSync.js
//
// Syncs baseline Ticketmaster "get-in" (lowest/original) pricing into our own
// database from Impact Radius's Media Partner Product Catalog API, instead of
// hitting Ticketmaster's own Discovery API or scraping. This is a BULK, daily
// catalog snapshot -- not real-time -- so it's intentionally architected as a
// memory-bounded streaming pipeline: download-to-disk, then stream-parse, then
// batch-upsert. None of the three stages ever holds the full feed in RAM at
// once, which matters because Impact catalog exports for a mid/large
// Ticketmaster affiliate account can run from tens of thousands to low
// millions of line items.
//
// Dependencies this module needs that are NOT already in this repo:
//   npm install stream-json stream-chain node-cron
// (pg is already a dependency; this module reuses index.js's shared pool.)
//
// Required environment variables:
//   IMPACT_ACCOUNT_SID             e.g. "IR12345678"
//   IMPACT_AUTH_TOKEN              Impact API auth token (Basic Auth password)
//   IMPACT_TICKETMASTER_CATALOG_ID the numeric/alphanumeric Catalog Id for the
//                                  Ticketmaster product catalog in your Impact
//                                  account (Media Partner > Catalogs)
//
// Optional:
//   IMPACT_CATALOG_SYNC_CRON       cron expression override (default: 3 AM daily)
//   IMPACT_CATALOG_SYNC_TZ         IANA timezone for the cron schedule
//                                  (default: server's local TZ)
// =============================================================================

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

import cron from 'node-cron';
import streamChainPkg from 'stream-chain';
const { chain } = streamChainPkg;
import streamJsonPkg from 'stream-json';
const { parser: jsonStreamParser } = streamJsonPkg;
import streamArrayPkg from 'stream-json/streamers/StreamArray.js';
const { streamArray } = streamArrayPkg;

// Reuses the one shared pool index.js already creates and exports, same
// convention every other service module in this codebase follows (see
// services/ticketmaster.js, services/seatgeek.js) -- rather than opening a
// second independent connection pool against the same database.
import { pool } from '../index.js';

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const IMPACT_ACCOUNT_SID = process.env.IMPACT_ACCOUNT_SID;
const IMPACT_AUTH_TOKEN = process.env.IMPACT_AUTH_TOKEN;
const IMPACT_TICKETMASTER_CATALOG_ID = process.env.IMPACT_TICKETMASTER_CATALOG_ID;

// Impact's Media Partner Catalogs "Items" endpoint returns the full catalog
// export for the given CatalogId as one JSON payload. Paging params
// (Page/PageSize) exist on some Impact catalog endpoints but the bulk export
// used here is the one meant for full-feed syncs like this one.
const IMPACT_CATALOG_ITEMS_URL = IMPACT_ACCOUNT_SID && IMPACT_TICKETMASTER_CATALOG_ID
  ? `https://api.impact.com/Mediapartners/${IMPACT_ACCOUNT_SID}/Catalogs/${IMPACT_TICKETMASTER_CATALOG_ID}/Items`
  : null;

// How many parsed catalog rows accumulate in memory before we flush a single
// bulk upsert statement. 500 is a reasonable middle ground for Postgres: big
// enough to amortize round-trip latency across a large feed, small enough
// that one bad batch is cheap to retry and the statement's parameter count
// (BATCH_SIZE * number of columns) stays well under Postgres's 65535 bind
// parameter ceiling.
const BATCH_SIZE = 500;

// Network retry policy for the initial download -- a transient 5xx or
// connection reset from Impact's edge shouldn't fail the whole nightly job.
const MAX_DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_RETRY_BASE_DELAY_MS = 2000;

const LOG_PREFIX = '[ImpactCatalogSync]';

// -----------------------------------------------------------------------------
// Schema bootstrap
//
// Dedicated staging table for Ticketmaster catalog baseline pricing, kept
// separate from the live `events`/`canonical_events` tables so this feed's
// (sometimes noisy or delayed) data never directly clobbers canonical
// event rows -- the app layer decides how/when to blend
// ticketmaster_catalog_prices.get_in_price into whatever it shows users.
// -----------------------------------------------------------------------------

async function ensureSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ticketmaster_catalog_prices (
      ticketmaster_event_id TEXT PRIMARY KEY,
      event_name            TEXT,
      event_date            TIMESTAMPTZ,
      venue_name            TEXT,
      get_in_price          NUMERIC(10, 2),
      currency              TEXT DEFAULT 'USD',
      source_sku            TEXT,
      source_url            TEXT,
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Lets downstream queries quickly ask "what's our freshest Ticketmaster
  // baseline price for event X priced before/after date Y" without a seq scan.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ticketmaster_catalog_prices_updated_at
      ON ticketmaster_catalog_prices (updated_at)
  `);
}

// -----------------------------------------------------------------------------
// Stage 1: Memory-efficient streaming download to disk
// -----------------------------------------------------------------------------

/**
 * Downloads the full Ticketmaster catalog export from Impact to a temp file
 * on disk, streaming the response body directly to the filesystem so the
 * payload is never buffered whole in process memory. Retries transient
 * network/5xx failures with exponential backoff.
 *
 * @returns {Promise<string>} absolute path to the downloaded temp file
 */
async function downloadCatalogToFile() {
  if (!IMPACT_CATALOG_ITEMS_URL) {
    throw new Error(
      'Missing Impact configuration: IMPACT_ACCOUNT_SID and ' +
      'IMPACT_TICKETMASTER_CATALOG_ID must both be set.'
    );
  }
  if (!IMPACT_AUTH_TOKEN) {
    throw new Error('Missing Impact configuration: IMPACT_AUTH_TOKEN must be set.');
  }

  // Unique filename per run so two overlapping invocations (e.g. a manual
  // trigger firing while the cron job is still running) never clobber each
  // other's in-progress download.
  const tempFilePath = path.join(
    os.tmpdir(),
    `ticketmaster_feed_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.json`
  );

  const basicAuthHeader =
    'Basic ' + Buffer.from(`${IMPACT_ACCOUNT_SID}:${IMPACT_AUTH_TOKEN}`).toString('base64');

  let lastError;
  for (let attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt++) {
    try {
      console.log(
        `${LOG_PREFIX} Downloading catalog (attempt ${attempt}/${MAX_DOWNLOAD_ATTEMPTS})...`
      );

      const response = await fetch(IMPACT_CATALOG_ITEMS_URL, {
        method: 'GET',
        headers: {
          Authorization: basicAuthHeader,
          Accept: 'application/json',
        },
      });

      if (!response.ok || !response.body) {
        // Capture a small amount of the error body for diagnostics without
        // risking logging a huge payload if Impact returns an HTML error page.
        const snippet = await response.text().catch(() => '');
        throw new Error(
          `Impact catalog download failed: HTTP ${response.status} ${response.statusText}. ` +
          `Body (truncated): ${snippet.slice(0, 300)}`
        );
      }

      // Convert the fetch Response's web ReadableStream into a Node stream
      // and pipe it straight to disk -- this is the memory-bounded part:
      // bytes flow from socket to file in chunks, never fully materialized.
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(tempFilePath));

      const { size } = await fsp.stat(tempFilePath);
      console.log(
        `${LOG_PREFIX} Download complete: ${(size / (1024 * 1024)).toFixed(2)} MB -> ${tempFilePath}`
      );

      return tempFilePath;
    } catch (err) {
      lastError = err;
      console.error(
        `${LOG_PREFIX} Download attempt ${attempt} failed: ${err.message}`
      );

      // Clean up a partial file before retrying so we never leave a
      // half-written temp file behind if a later attempt also fails.
      await fsp.unlink(tempFilePath).catch(() => {});

      if (attempt < MAX_DOWNLOAD_ATTEMPTS) {
        const delay = DOWNLOAD_RETRY_BASE_DELAY_MS * attempt;
        console.log(`${LOG_PREFIX} Retrying download in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw new Error(
    `Impact catalog download failed after ${MAX_DOWNLOAD_ATTEMPTS} attempts: ${lastError?.message}`
  );
}

// -----------------------------------------------------------------------------
// Field extraction
//
// Impact's Product Catalog feed schema is advertiser-controlled, so exact
// field names/casing can vary per Ticketmaster feed configuration and can
// change if Ticketmaster's Impact integration is reconfigured on their end.
// Rather than hard-coding one exact shape and silently dropping rows that
// don't match it, this pulls from a prioritized list of known/likely field
// names per logical value, so the sync keeps working across minor feed
// schema drift. If Ticketmaster's actual feed uses different field names
// than every alias listed here, add the real one to the relevant array --
// nothing else in the pipeline needs to change.
// -----------------------------------------------------------------------------

function firstDefined(item, keys) {
  for (const key of keys) {
    if (item[key] !== undefined && item[key] !== null && item[key] !== '') {
      return item[key];
    }
  }
  return null;
}

function parseMoney(rawValue) {
  if (rawValue === null || rawValue === undefined) return null;
  if (typeof rawValue === 'number') return Number.isFinite(rawValue) ? rawValue : null;
  // Strip currency symbols/commas ("$45.00", "45,00") before parsing.
  const cleaned = String(rawValue).replace(/[^0-9.]/g, '');
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseEventDate(rawValue) {
  if (!rawValue) return null;
  const parsed = new Date(rawValue);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Normalizes one raw catalog item into the shape upsertTicketmasterPrices
 * expects. Returns null (and the caller skips the row) if the item is
 * missing the one field we can't proceed without: a stable Ticketmaster
 * event id to key the upsert on.
 */
function extractEventFields(item) {
  const ticketmasterEventId = firstDefined(item, [
    'Sku', 'SKU', 'Id', 'ItemId', 'ProductId', 'EventId', 'TicketmasterEventId',
  ]);
  if (!ticketmasterEventId) return null;

  const eventName = firstDefined(item, ['Name', 'Title', 'ProductName', 'EventName']);

  const venueName = firstDefined(item, [
    'Venue', 'VenueName', 'Location',
  ]) ?? (item.AdvancedData && firstDefined(item.AdvancedData, ['Venue', 'VenueName']));

  const rawDate = firstDefined(item, [
    'EventDate', 'Date', 'StartDate', 'event_date',
  ]) ?? (item.AdvancedData && firstDefined(item.AdvancedData, ['EventDate', 'StartDate']));

  // "Get-in" price is the lowest available/original price for the event --
  // in Impact catalog exports this is most commonly the base `Price` field,
  // with `SalePrice`/`RetailPrice`/min-price variants used by some feeds as
  // an alternative or more precise signal. Preferring the more specific
  // "minimum/original price" fields first, falling back to the generic
  // Price field, keeps this correct across feed variants where both exist.
  const getInPrice = parseMoney(
    firstDefined(item, [
      'MinPrice', 'OriginalPrice', 'RetailPrice', 'SalePrice', 'Price', 'CurrentPrice',
    ])
  );

  const currency = firstDefined(item, ['Currency', 'CurrencyCode']) ?? 'USD';
  const sourceUrl = firstDefined(item, ['Url', 'TrackingLink', 'Link']);

  return {
    ticketmasterEventId: String(ticketmasterEventId),
    eventName: eventName ?? null,
    eventDate: parseEventDate(rawDate),
    venueName: venueName ?? null,
    getInPrice,
    currency,
    sourceSku: String(ticketmasterEventId),
    sourceUrl: sourceUrl ?? null,
  };
}

// -----------------------------------------------------------------------------
// Stage 3: Robust database upsert
// -----------------------------------------------------------------------------

/**
 * Bulk-upserts a batch of normalized Ticketmaster catalog rows.
 *
 * Deliberately batch-shaped (array in, one round trip out) rather than one
 * query per event: for a high-throughput daily sync processing tens of
 * thousands of rows, a per-row INSERT would mean tens of thousands of
 * network round trips to Postgres, which dominates total job time far more
 * than the actual write work does. Using UNNEST($1::text[], $2::text[], ...)
 * turns one batch into a single statement, which Postgres can execute as one
 * efficient multi-row operation -- while still keeping the exact
 * "INSERT ... ON CONFLICT DO UPDATE" semantics the spec calls for, so stale
 * prices are cleanly overwritten and no event row is ever duplicated.
 *
 * @param {import('pg').Pool} pool
 * @param {Array<ReturnType<typeof extractEventFields>>} eventBatch
 */
async function upsertTicketmasterPrices(pool, eventBatch) {
  if (!eventBatch || eventBatch.length === 0) return { upserted: 0 };

  const ids = [];
  const names = [];
  const dates = [];
  const venues = [];
  const prices = [];
  const currencies = [];
  const skus = [];
  const urls = [];

  for (const row of eventBatch) {
    ids.push(row.ticketmasterEventId);
    names.push(row.eventName);
    dates.push(row.eventDate); // node-postgres serializes JS Date / null correctly in a typed array param
    venues.push(row.venueName);
    prices.push(row.getInPrice);
    currencies.push(row.currency);
    skus.push(row.sourceSku);
    urls.push(row.sourceUrl);
  }

  const query = `
    INSERT INTO ticketmaster_catalog_prices
      (ticketmaster_event_id, event_name, event_date, venue_name,
       get_in_price, currency, source_sku, source_url, updated_at)
    SELECT
      unnest($1::text[]),
      unnest($2::text[]),
      unnest($3::timestamptz[]),
      unnest($4::text[]),
      unnest($5::numeric[]),
      unnest($6::text[]),
      unnest($7::text[]),
      unnest($8::text[]),
      NOW()
    ON CONFLICT (ticketmaster_event_id) DO UPDATE SET
      event_name   = EXCLUDED.event_name,
      event_date   = EXCLUDED.event_date,
      venue_name   = EXCLUDED.venue_name,
      get_in_price = EXCLUDED.get_in_price,
      currency     = EXCLUDED.currency,
      source_sku   = EXCLUDED.source_sku,
      source_url   = EXCLUDED.source_url,
      updated_at   = NOW()
  `;

  try {
    await pool.query(query, [ids, names, dates, venues, prices, currencies, skus, urls]);
    return { upserted: eventBatch.length };
  } catch (err) {
    // A malformed row (e.g. a date Postgres can't cast) could fail the whole
    // batch. Rather than losing the entire batch's worth of fresh prices,
    // fall back to one-row-at-a-time for just this batch so only the actual
    // bad row(s) are skipped -- the nightly job stays resilient to a single
    // dirty record in an otherwise-good feed.
    console.error(
      `${LOG_PREFIX} Batch upsert failed (${eventBatch.length} rows), falling back to ` +
      `per-row upsert to isolate the bad record(s): ${err.message}`
    );

    let upserted = 0;
    for (const row of eventBatch) {
      try {
        await pool.query(
          `
            INSERT INTO ticketmaster_catalog_prices
              (ticketmaster_event_id, event_name, event_date, venue_name,
               get_in_price, currency, source_sku, source_url, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
            ON CONFLICT (ticketmaster_event_id) DO UPDATE SET
              event_name   = EXCLUDED.event_name,
              event_date   = EXCLUDED.event_date,
              venue_name   = EXCLUDED.venue_name,
              get_in_price = EXCLUDED.get_in_price,
              currency     = EXCLUDED.currency,
              source_sku   = EXCLUDED.source_sku,
              source_url   = EXCLUDED.source_url,
              updated_at   = NOW()
          `,
          [
            row.ticketmasterEventId, row.eventName, row.eventDate, row.venueName,
            row.getInPrice, row.currency, row.sourceSku, row.sourceUrl,
          ]
        );
        upserted++;
      } catch (rowErr) {
        console.error(
          `${LOG_PREFIX} Skipping unrecoverable row (ticketmaster_event_id=` +
          `${row.ticketmasterEventId}): ${rowErr.message}`
        );
      }
    }
    return { upserted };
  }
}

// -----------------------------------------------------------------------------
// Stage 3.5: Merge catalog prices into the live `events` table
//
// ticketmaster_catalog_prices is a staging table -- nothing on the live site
// reads from it directly. This is the step that actually makes the catalog
// feed useful for "discover event prices": it pushes get_in_price into the
// same events.min_price / events.max_price columns that
// services/ticketmaster.js's real-time Discovery-API price backfill
// (backfillTicketmasterPrices) already writes to, matched on the same key
// events already uses for Ticketmaster rows -- external_id.
//
// This runs as an unconditional overwrite (not a COALESCE/fill-nulls-only),
// per the original spec ("cleanly overwrite stale baseline ticket prices
// with the fresh download data"): the nightly catalog snapshot is treated as
// the freshest available baseline price for every event it covers. It also
// stamps price_backfill_checked_at, so backfillTicketmasterPrices's own
// per-event query (`WHERE min_price IS NULL ORDER BY
// price_backfill_checked_at ASC NULLS FIRST`) naturally skips everything
// this catalog sync already priced tonight and spends its (rate-limited)
// API budget only on events the catalog feed didn't cover -- the two price
// sources complement each other instead of racing.
// -----------------------------------------------------------------------------

async function mergeCatalogPricesIntoEvents(pool) {
  const { rowCount } = await pool.query(`
    UPDATE events e
    SET
      min_price = cp.get_in_price,
      max_price = COALESCE(e.max_price, cp.get_in_price),
      price_backfill_checked_at = NOW()
    FROM ticketmaster_catalog_prices cp
    WHERE e.source = 'ticketmaster'
      AND e.external_id = cp.ticketmaster_event_id
      AND cp.get_in_price IS NOT NULL
      -- Only touch rows this run actually refreshed, not the whole staging
      -- table history, so a merge mid-way through a multi-day-old partial
      -- sync can't re-apply stale prices on top of newer Discovery-API data.
      AND cp.updated_at >= NOW() - INTERVAL '1 day'
  `);

  return { eventsPriced: rowCount };
}

// -----------------------------------------------------------------------------
// Stage 2: Memory-efficient streaming JSON parse + drive Stage 3 in batches
// -----------------------------------------------------------------------------

/**
 * Streams the downloaded catalog file off disk and incrementally parses the
 * top-level JSON array using stream-json, so the file's full contents are
 * never held as one in-memory JS array/string. Rows are accumulated into
 * fixed-size batches and flushed to the database as they fill, rather than
 * collecting every row before writing anything -- so peak memory stays
 * bounded by BATCH_SIZE, not by total feed size.
 *
 * @param {string} filePath
 * @param {import('pg').Pool} pool
 */
async function parseAndSyncCatalogFile(filePath, pool) {
  const pipelineChain = chain([
    fs.createReadStream(filePath),
    jsonStreamParser(),
    streamArray(), // emits { key, value } for each element of the top-level JSON array
  ]);

  let batch = [];
  let totalParsed = 0;
  let totalSkippedNoId = 0;
  let totalUpserted = 0;

  // `for await...of` on the stream-json chain both drives the parser AND
  // provides natural backpressure: because we `await` the DB flush inside
  // the loop body, the chain will not read/parse further bytes from disk
  // until the current batch's upsert has resolved. That's what keeps this
  // whole stage memory-bounded even on a multi-GB feed.
  for await (const { value: item } of pipelineChain) {
    totalParsed++;

    const extracted = extractEventFields(item);
    if (!extracted) {
      totalSkippedNoId++;
      continue;
    }

    batch.push(extracted);

    if (batch.length >= BATCH_SIZE) {
      const { upserted } = await upsertTicketmasterPrices(pool, batch);
      totalUpserted += upserted;
      console.log(
        `${LOG_PREFIX} Progress: ${totalParsed} parsed, ${totalUpserted} upserted so far...`
      );
      batch = [];
    }
  }

  // Flush whatever's left in the final partial batch.
  if (batch.length > 0) {
    const { upserted } = await upsertTicketmasterPrices(pool, batch);
    totalUpserted += upserted;
  }

  return { totalParsed, totalUpserted, totalSkippedNoId };
}

// -----------------------------------------------------------------------------
// Orchestration: the full nightly sync job
// -----------------------------------------------------------------------------

/**
 * Runs one full Ticketmaster-via-Impact catalog sync: download -> stream
 * parse -> batch upsert -> merge into live events -> cleanup. Safe to call
 * manually (e.g. from an admin route) as well as from the cron schedule
 * below. Uses this app's one shared `pool` (imported from index.js) unless
 * a different pool is explicitly passed in (useful for tests).
 *
 * @param {import('pg').Pool} [poolOverride]
 */
async function runTicketmasterCatalogSync(poolOverride) {
  const db = poolOverride ?? pool;
  const startedAt = Date.now();
  let tempFilePath = null;

  console.log(`${LOG_PREFIX} Job started at ${new Date(startedAt).toISOString()}`);

  try {
    await ensureSchema(db);

    tempFilePath = await downloadCatalogToFile();

    console.log(`${LOG_PREFIX} Parsing and syncing catalog into database...`);
    const { totalParsed, totalUpserted, totalSkippedNoId } =
      await parseAndSyncCatalogFile(tempFilePath, db);

    console.log(`${LOG_PREFIX} Merging fresh catalog prices into live events...`);
    const { eventsPriced } = await mergeCatalogPricesIntoEvents(db);

    const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(
      `${LOG_PREFIX} Job complete in ${durationSec}s. ` +
      `Parsed: ${totalParsed}, Upserted: ${totalUpserted}, Skipped (no id): ${totalSkippedNoId}, ` +
      `Live events priced: ${eventsPriced}.`
    );

    return { success: true, totalParsed, totalUpserted, totalSkippedNoId, eventsPriced, durationSec };
  } catch (err) {
    const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.error(
      `${LOG_PREFIX} Job FAILED after ${durationSec}s: ${err.message}\n${err.stack}`
    );
    // Re-throw so a caller invoking this directly (e.g. an admin "run now"
    // route) can surface the failure, while the cron wrapper below catches
    // it so one failed night never crashes the whole Node process.
    throw err;
  } finally {
    if (tempFilePath) {
      await fsp.unlink(tempFilePath).catch((cleanupErr) => {
        console.error(
          `${LOG_PREFIX} Warning: failed to delete temp file ${tempFilePath}: ${cleanupErr.message}`
        );
      });
    }
  }
}

// -----------------------------------------------------------------------------
// Stage 4: Automated daily scheduling
// -----------------------------------------------------------------------------

let scheduledTask = null;

/**
 * Registers the 3:00 AM daily cron job. Call this once at app boot (mirrors
 * how other scheduled jobs in this codebase are wired up in index.js).
 *
 * @param {import('pg').Pool} [poolOverride]
 */
function scheduleTicketmasterCatalogSync(poolOverride) {
  const cronExpression = process.env.IMPACT_CATALOG_SYNC_CRON || '0 3 * * *'; // 3:00 AM daily
  const cronOptions = process.env.IMPACT_CATALOG_SYNC_TZ
    ? { timezone: process.env.IMPACT_CATALOG_SYNC_TZ }
    : {};

  if (scheduledTask) {
    console.log(`${LOG_PREFIX} Schedule already registered; skipping duplicate registration.`);
    return scheduledTask;
  }

  scheduledTask = cron.schedule(
    cronExpression,
    async () => {
      try {
        await runTicketmasterCatalogSync(poolOverride);
      } catch (err) {
        // Already logged with full detail inside runTicketmasterCatalogSync;
        // this catch exists purely so an unhandled rejection inside the cron
        // callback can never take down the Node process.
        console.error(`${LOG_PREFIX} Scheduled run ended in failure (see above for details).`);
      }
    },
    cronOptions
  );

  console.log(
    `${LOG_PREFIX} Scheduled: "${cronExpression}"` +
    (cronOptions.timezone ? ` (timezone: ${cronOptions.timezone})` : ' (server local time)')
  );

  return scheduledTask;
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

export {
  runTicketmasterCatalogSync,
  scheduleTicketmasterCatalogSync,
  upsertTicketmasterPrices,
  mergeCatalogPricesIntoEvents,
  extractEventFields, // exported for unit testing against sample feed rows
  ensureSchema,
};
