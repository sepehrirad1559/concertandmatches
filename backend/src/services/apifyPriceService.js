// Live "get-in" price patch for Ticketmaster/SeatGeek events whose bulk
// sync APIs come back with no price at all (see services/ticketmaster.js's
// and services/seatgeek.js's backfillMissingPrices — this is the next
// fallback tier for whatever's left after THAT backfill also comes up
// empty, e.g. an off-sale/pulled listing whose detail endpoint genuinely
// never returns priceRanges, but whose live public page still shows a
// price). Scrapes the public event page via Apify and caches the result so
// a page a hundred visitors hit in one afternoon only gets scraped once.
//
// ACTOR CONFIG — READ BEFORE DEPLOYING:
// APIFY_TICKETMASTER_ACTOR_ID / APIFY_SEATGEEK_ACTOR_ID default to Apify's
// own generic `apify/web-scraper` actor (a real, published Apify actor —
// https://apify.com/apify/web-scraper — that runs a headless Chromium page
// and executes the `pageFunction` string you hand it, so it works against
// any dynamic site without needing a site-specific actor to exist). This is
// the safe default because a specific paid/community actor like the
// `parseforge/ticketmaster-scraper` mentioned when this was speced up is
// NOT something I can verify exists, is maintained, or accepts the input
// shape assumed below — Apify's actor store changes constantly and actors
// get deprecated/renamed. If you have a specific actor you've already
// verified in the Apify console (its Input tab shows the real schema),
// point APIFY_TICKETMASTER_ACTOR_ID/APIFY_SEATGEEK_ACTOR_ID at it and
// rewrite that platform's `buildInput`/`extractPrice` pair below to match
// its actual input/output shape — everything else in this file (caching,
// dedupe, fallback, data contract) stays the same regardless of which
// actor does the actual scraping.
//
// LEGAL/ToS NOTE: scraping Ticketmaster's and SeatGeek's public pages
// likely runs against both sites' Terms of Service, separately from
// whether it's technically blocked. That's a business-risk call only you
// can make — flagging it once here rather than building it in silently.
import { ApifyClient } from 'apify-client';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- Client init --------------------------------------------------------
// Safe to import this module even when APIFY_TOKEN isn't configured yet
// (e.g. local dev, or before the env var is set in Railway) — client stays
// null and getLiveMarketPrice() below fails soft into the estimation
// fallback instead of throwing at import time and crashing the whole
// server's require/import chain.
const APIFY_TOKEN = process.env.APIFY_TOKEN || null;
const client = APIFY_TOKEN ? new ApifyClient({ token: APIFY_TOKEN }) : null;
if (!APIFY_TOKEN) {
  console.warn('⚠️  APIFY_TOKEN not configured — getLiveMarketPrice() will always fall through to the TicketNetwork-estimate fallback.');
}

// ---- Cache ----------------------------------------------------------------
// In-memory Map for hot-path speed (this runs in a request path, not just a
// background job — a page view can call this directly, see integration
// notes below) plus a JSON file so the cache survives a Railway
// redeploy/restart instead of going cold and re-scraping everything at
// once right after every deploy.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours, per spec
const CACHE_FILE = path.join(__dirname, '.apify-price-cache.json');

const cache = new Map(); // key: eventUrl -> { result, cachedAt }

function loadCacheFromDisk() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    const now = Date.now();
    let loaded = 0;
    for (const [url, entry] of Object.entries(raw)) {
      // Don't resurrect stale entries — no point carrying dead weight into
      // memory, and it keeps the periodic prune (below) simple.
      if (entry?.cachedAt && now - entry.cachedAt < CACHE_TTL_MS) {
        cache.set(url, entry);
        loaded++;
      }
    }
    console.log(`💾 apifyPriceService: loaded ${loaded} cached price(s) from disk`);
  } catch (error) {
    // A corrupt/unreadable cache file should never take the server down —
    // just start cold.
    console.warn('apifyPriceService: could not load price cache from disk, starting empty:', error.message);
  }
}
loadCacheFromDisk();

// Debounced disk write: several calls can resolve within the same tick
// (e.g. a homepage rendering several event cards at once), and there's no
// need to fsync on every single one of them.
let writeScheduled = false;
function scheduleCacheWrite() {
  if (writeScheduled) return;
  writeScheduled = true;
  setTimeout(() => {
    writeScheduled = false;
    try {
      const asObject = Object.fromEntries(cache);
      fs.writeFileSync(CACHE_FILE, JSON.stringify(asObject), 'utf8');
    } catch (error) {
      // Same reasoning as loadCacheFromDisk: caching is an optimization,
      // not a correctness requirement — a failed write just means the next
      // restart starts cold, never a reason to error out a live request.
      console.warn('apifyPriceService: could not persist price cache to disk:', error.message);
    }
  }, 2000);
}

function getCached(eventUrl) {
  const entry = cache.get(eventUrl);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt >= CACHE_TTL_MS) {
    cache.delete(eventUrl);
    return null;
  }
  return entry.result;
}

function setCached(eventUrl, result) {
  // Never cache an isEstimated result as if it were a real scrape — an
  // estimate is cheap to recompute (it's just local math against whatever
  // TicketNetwork price the caller passes in) and SHOULD be re-derived
  // every time in case the underlying TicketNetwork price has moved, and
  // more importantly we want the next call to try a real scrape again
  // rather than being stuck serving a 6-hour-old guess.
  if (result.isEstimated) return;
  cache.set(eventUrl, { result, cachedAt: Date.now() });
  scheduleCacheWrite();
}

// ---- In-flight dedupe ------------------------------------------------------
// If two requests for the same uncached URL land close together (real
// traffic pattern: an event page and a "similar events" card both resolve
// around the same time), don't fire two separate Apify actor runs — that
// doubles the Apify credit cost and the wait, for a value the first call is
// already about to produce. Same pattern as ticketmaster.js's
// backfillInProgress flag, just keyed per-URL instead of being a single
// global flag.
const inFlight = new Map(); // key: eventUrl -> Promise<result>

// ---- Per-platform actor config ---------------------------------------------
// buildInput(url): the actor's INPUT object.
// extractPrice(datasetItems): pulls the lowest price (number) out of
// whatever the actor's dataset items look like, or null if none found.
//
// apify/web-scraper's pageFunction runs INSIDE the scraped page (Puppeteer
// context) after the page's own JS has rendered — `waitFor` here is what
// satisfies requirement #2's "wait for the page to fully load JS elements"
// rather than a fixed sleep, which is both slower than necessary and less
// reliable against a slow page.
function genericLowestPricePageFunction() {
  // NOTE: this whole function body is serialized to a string and shipped
  // to the actor — it cannot close over anything from this file. Keep it
  // self-contained.
  return async function pageFunction(context) {
    const { page, request, log } = context;
    await page.waitForSelector('body', { timeout: 15000 }).catch(() => {});
    // Give client-side rendered price widgets a beat to finish painting —
    // ticket marketplace pages commonly fetch pricing async after first
    // paint. A short bounded wait, not a blind long sleep.
    await page
      .waitForFunction(
        () => /\$\s?\d/.test(document.body ? document.body.innerText : ''),
        { timeout: 12000 }
      )
      .catch(() => {});

    const prices = await page.evaluate(() => {
      const text = document.body ? document.body.innerText : '';
      const matches = text.match(/\$\s?(\d{1,4}(?:,\d{3})*(?:\.\d{2})?)/g) || [];
      return matches
        .map((m) => parseFloat(m.replace(/[$,\s]/g, '')))
        .filter((n) => Number.isFinite(n) && n > 0 && n < 100000); // filters out stray non-price $ mentions (e.g. "$0", promo copy) without being an exact-site-specific selector
    });

    const lowest = prices.length ? Math.min(...prices) : null;
    log.info(`Extracted ${prices.length} candidate price(s) from ${request.url}, lowest=${lowest}`);
    return { url: request.url, lowestPrice: lowest };
  };
}

const ACTOR_CONFIG = {
  ticketmaster: {
    actorId: process.env.APIFY_TICKETMASTER_ACTOR_ID || 'apify/web-scraper',
    buildInput: (url) => ({
      startUrls: [{ url }],
      pageFunction: genericLowestPricePageFunction().toString(),
      proxyConfiguration: { useApifyProxy: true },
      waitUntil: ['networkidle2'],
    }),
    extractPrice: (items) => items?.[0]?.lowestPrice ?? null,
  },
  seatgeek: {
    actorId: process.env.APIFY_SEATGEEK_ACTOR_ID || 'apify/web-scraper',
    buildInput: (url) => ({
      startUrls: [{ url }],
      pageFunction: genericLowestPricePageFunction().toString(),
      proxyConfiguration: { useApifyProxy: true },
      waitUntil: ['networkidle2'],
    }),
    extractPrice: (items) => items?.[0]?.lowestPrice ?? null,
  },
};

const ACTOR_RUN_TIMEOUT_SECS = 90;
const ACTOR_RUN_MEMORY_MB = 1024;

async function runActor(platform, eventUrl) {
  const config = ACTOR_CONFIG[platform];
  if (!config) throw new Error(`apifyPriceService: unsupported platform "${platform}" (expected "ticketmaster" or "seatgeek")`);

  const run = await client.actor(config.actorId).call(config.buildInput(eventUrl), {
    timeout: ACTOR_RUN_TIMEOUT_SECS,
    memory: ACTOR_RUN_MEMORY_MB,
  });

  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  const price = config.extractPrice(items);
  if (price == null) {
    throw new Error(`Actor run ${run.id} completed but returned no extractable price`);
  }
  return price;
}

/**
 * Resolves the live "get-in" (lowest) ticket price for a Ticketmaster or
 * SeatGeek event page, using a cached value when available, a fresh Apify
 * scrape otherwise, and a TicketNetwork-derived estimate if the scrape
 * fails or is unavailable.
 *
 * @param {string} eventUrl - the public event page to scrape (source_url).
 * @param {'ticketmaster'|'seatgeek'} platform
 * @param {Object} [options]
 * @param {number|null} [options.fallbackTicketNetworkPrice] - this exact
 *   event's matched TicketNetwork get-in price (canonical_event_id match —
 *   see integration notes), used for the 0.80 estimate when scraping fails.
 *   Pass null/omit if no TicketNetwork match exists; the function then
 *   returns success:false rather than fabricating a number from nothing.
 * @returns {Promise<{success: boolean, getInPrice: number|null, isEstimated: boolean, timestamp: string, error?: string}>}
 */
export async function getLiveMarketPrice(eventUrl, platform, options = {}) {
  const { fallbackTicketNetworkPrice = null } = options;

  if (!eventUrl || !ACTOR_CONFIG[platform]) {
    return {
      success: false,
      getInPrice: null,
      isEstimated: false,
      timestamp: new Date().toISOString(),
      error: `Invalid arguments: eventUrl and a supported platform ("ticketmaster"|"seatgeek") are required (got platform="${platform}")`,
    };
  }

  const cached = getCached(eventUrl);
  if (cached) return cached;

  if (inFlight.has(eventUrl)) {
    return inFlight.get(eventUrl);
  }

  const promise = (async () => {
    // No Apify token configured — skip straight to the fallback rather
    // than attempting a client call that would just throw.
    if (!client) {
      return buildEstimateOrFailure(fallbackTicketNetworkPrice, 'APIFY_TOKEN not configured');
    }

    try {
      const price = await runActor(platform, eventUrl);
      const result = {
        success: true,
        getInPrice: Math.round(price * 100) / 100,
        isEstimated: false,
        timestamp: new Date().toISOString(),
      };
      setCached(eventUrl, result);
      return result;
    } catch (error) {
      // Requirement #4: never let a scrape failure (timeout, anti-bot
      // block, actor error, no price found on the page) crash or error out
      // the live site — fall back to the TicketNetwork-derived estimate.
      console.warn(`apifyPriceService: scrape failed for ${eventUrl} (${platform}):`, error.message);
      return buildEstimateOrFailure(fallbackTicketNetworkPrice, error.message);
    }
  })();

  inFlight.set(eventUrl, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(eventUrl);
  }
}

function buildEstimateOrFailure(fallbackTicketNetworkPrice, reason) {
  if (fallbackTicketNetworkPrice != null && Number.isFinite(fallbackTicketNetworkPrice) && fallbackTicketNetworkPrice > 0) {
    return {
      success: true,
      getInPrice: Math.round(fallbackTicketNetworkPrice * 0.8 * 100) / 100,
      isEstimated: true,
      timestamp: new Date().toISOString(),
    };
  }
  // No scrape AND no TicketNetwork match to estimate from — be honest that
  // there is no price rather than inventing one. Caller should treat
  // success:false the same as "leave min_price as it was."
  return {
    success: false,
    getInPrice: null,
    isEstimated: false,
    timestamp: new Date().toISOString(),
    error: `No live price scraped and no TicketNetwork match to estimate from (${reason})`,
  };
}

// ---- Database-update-loop integration --------------------------------------
// This is the "drop it into my existing update loop" half of the module:
// walks events that are STILL min_price IS NULL after the regular
// Ticketmaster/SeatGeek API backfill (services/ticketmaster.js's and
// services/seatgeek.js's own backfillMissingPrices), tries a live scrape for
// each, and stores whatever it gets (real or estimated) back onto the row.
//
// Reuses the same price_backfill_checked_at column/ordering those two
// services already use (added by POST /admin/schema/add-price-backfill-tracking)
// so this slots into the exact same starvation-safe queue instead of
// needing its own tracking column — an event that's been checked recently
// by EITHER backfill path moves to the back of both queues together, which
// is the right behavior since there's no point re-trying an event this
// tier just failed on again a minute later via the other tier.
//
// Requires POST /admin/schema/add-apify-price-tracking to have been run
// once (adds events.min_price_is_estimated) before this is called.
let apifyBackfillInProgress = false;

export const backfillMissingPricesViaApify = async (limit = 50) => {
  if (apifyBackfillInProgress) {
    return { success: false, error: 'An Apify live-price backfill is already running — try again once it finishes (check GET /admin/health).' };
  }
  apifyBackfillInProgress = true;
  try {
    const { rows } = await pool.query(
      `SELECT id, source, source_url
       FROM events
       WHERE source IN ('ticketmaster', 'seatgeek') AND min_price IS NULL AND date >= NOW() AND source_url IS NOT NULL
       ORDER BY price_backfill_checked_at ASC NULLS FIRST, date ASC
       LIMIT $1`,
      [limit]
    );

    let scraped = 0;
    let estimated = 0;
    let noPriceAvailable = 0;

    for (const row of rows) {
      // Best-effort match to this exact event's TicketNetwork offer via the
      // canonical layer (see services/canonicalize.js) — this only finds a
      // match if POST /admin/canonicalize/rebuild has run since this event
      // was synced, same freshness caveat every other canonical-layer
      // consumer already has. No match just means the estimate fallback
      // below has nothing to work from and returns success:false, same as
      // any other unpriced event this tier can't help with yet.
      const tnMatch = await pool.query(
        `SELECT tn_offer.price
         FROM ticket_offers this_offer
         JOIN ticket_offers tn_offer ON tn_offer.canonical_event_id = this_offer.canonical_event_id
         JOIN providers tn_provider ON tn_provider.id = tn_offer.provider_id AND tn_provider.name = 'ticketnetwork'
         WHERE this_offer.source_event_row_id = $1 AND tn_offer.price IS NOT NULL
         LIMIT 1`,
        [row.id]
      );
      const fallbackTicketNetworkPrice = tnMatch.rows[0]?.price != null ? parseFloat(tnMatch.rows[0].price) : null;

      const result = await getLiveMarketPrice(row.source_url, row.source, { fallbackTicketNetworkPrice });

      if (result.success) {
        await pool.query(
          `UPDATE events SET
             min_price = $1, max_price = COALESCE(max_price, $1),
             min_price_is_estimated = $2, price_backfill_checked_at = NOW(), updated_at = NOW()
           WHERE id = $3`,
          [result.getInPrice, result.isEstimated, row.id]
        );
        if (result.isEstimated) estimated++; else scraped++;
      } else {
        // Same starvation-avoidance rule as the Ticketmaster/SeatGeek
        // backfills: stamp the checked-at timestamp even on failure so this
        // row rotates to the back of the queue instead of eating every
        // future batch's budget.
        await pool.query(`UPDATE events SET price_backfill_checked_at = NOW() WHERE id = $1`, [row.id]);
        noPriceAvailable++;
      }
    }

    return {
      success: true,
      checked: rows.length,
      scraped,
      estimated,
      noPriceAvailable,
    };
  } finally {
    apifyBackfillInProgress = false;
  }
};

export default { getLiveMarketPrice, backfillMissingPricesViaApify };
