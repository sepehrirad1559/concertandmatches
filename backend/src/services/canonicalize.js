import { pool } from '../index.js';
import { isSameEvent } from '../utils/matching.js';
import { normalizeState } from '../utils/states.js';

// Builds the normalized canonical_events / ticket_offers tables (spec
// §4-§8) from the existing `events` table — the real source of truth,
// populated by the working Ticketmaster/SeatGeek sync. This is a
// materialized/derived layer: canonical_events and ticket_offers are fully
// rebuilt each run rather than incrementally patched, since nothing writes
// to them directly. That keeps this correct-by-construction (no risk of
// drift between two independently-updated copies of the same data) at the
// cost of doing full work each run — acceptable since this is triggered on
// demand (or, later, on a schedule) rather than on every request.
//
// Uses the exact same isSameEvent matching used by the live price-
// comparison feature (utils/matching.js), so a canonical event here groups
// rows the same way the merged cards on the site already do.
function normalizeTitle(title) {
  return (title || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// BLUE/GREEN REBUILD (2026-09-27): this used to build straight into the
// live canonical_events/ticket_offers tables inside one long transaction
// that opened with `TRUNCATE ticket_offers, canonical_events RESTART
// IDENTITY CASCADE`. TRUNCATE takes an ACCESS EXCLUSIVE lock on the
// truncated tables, and because everything happened in a single
// transaction, that lock was held for the ENTIRE rebuild — normally a few
// minutes, but observed live to run 13-20+ minutes when something (DB
// load, a slow connection) made the run itself slow. Every real request
// that reads canonical_events/ticket_offers (i.e. every public listing
// request) blocked behind that lock for the whole duration — confirmed via
// pg_stat_activity showing several real connections stuck for 180-400+s
// during one such run.
//
// The fix: never touch the live tables until the very end. Build a
// complete fresh copy into freshly-created `canonical_events_new`/
// `ticket_offers_new` tables (no lock contention with anything, since
// nothing else ever queries them), then swap them in with four plain
// `ALTER TABLE ... RENAME` statements inside one short transaction — an
// ACCESS EXCLUSIVE lock held for milliseconds, not minutes, regardless of
// how long the build itself takes. The previous run's data becomes
// `canonical_events_old`/`ticket_offers_old` and is dropped right after.
export async function rebuildCanonicalEvents() {
  const client = await pool.connect();
  try {
    const providerRows = await client.query('SELECT id, name FROM providers');
    const providerIdByName = new Map(providerRows.rows.map((p) => [p.name, p.id]));

    // delisted_at IS NULL (2026-09-27): a delisted row (a source's own sync
    // confirming it's sold out/pulled/gone — see services/ticketnetwork.js's
    // stale-listing sweep) is excluded from the rebuild ENTIRELY, rather than
    // filtered later by price. This is what makes canonical_events/
    // ticket_offers automatically consistent with the new price-independent
    // visibility model: an unpriced-but-still-listed row still comes through
    // here and can win/contribute to a group same as always, while a
    // delisted row contributes nothing (no offer, can't become best_price,
    // and a group made up ENTIRELY of delisted rows simply never gets a
    // canonical_events row at all).
    const eventsResult = await client.query('SELECT * FROM events WHERE delisted_at IS NULL ORDER BY date ASC');
    const rows = eventsResult.rows;

    // Group rows representing the same real-world event, same algorithm as
    // the live API's mergeEventsAcrossSources — INCLUDING its (day, city,
    // state) bucketing fix, which this function was missing until now.
    // `groups.find(...)` below used to re-scan the entire, ever-growing
    // `groups` array for every single row (O(n^2)) — the same bug
    // mergeEventsAcrossSources had before it was bucketed (see that
    // function's comment in routes/events.js). At the few-thousand-row
    // scale this ran at when first written that was slow but tolerable;
    // at the catalog's current size (100k+ events, the vast majority never
    // matching any existing group) it's on the order of tens of billions of
    // isSameEvent() calls — and because this whole loop is synchronous with
    // no `await` inside it, it doesn't just make ONE request slow, it
    // blocks Node's single event loop for the entire run, freezing every
    // other request the server is handling (including totally unrelated
    // public endpoints) until it finishes. isSameEvent() requires an exact
    // city+state match and, with rare ±1-day exceptions (see
    // registerInAdjacentBuckets below), an exact day match too (see
    // utils/matching.js), so bucketing by that same key first — exactly as
    // mergeEventsAcrossSources does — means each row only ever gets
    // compared against same-bucket candidates instead of every group formed
    // so far.
    const dayString = (date) => {
      const d = new Date(date);
      return Number.isNaN(d.getTime()) ? 'invalid-date' : d.toISOString().slice(0, 10);
    };
    const cityStatePart = (row) => `${(row.city || '').toLowerCase().trim()}|${normalizeState(row.state)}`;
    const bucketKey = (row) => `${dayString(row.date)}|${cityStatePart(row)}`;

    // Register a group under its own day bucket AND the adjacent (±1) day
    // buckets — same fix, same reason, as mergeEventsAcrossSources in
    // routes/events.js: isSameDay (utils/matching.js) tolerates a 1-day gap
    // whenever either side is a midnight-UTC value (TicketNetwork's
    // date-only LaunchDate always is), since a US/Canada evening show's
    // Ticketmaster/SeatGeek UTC timestamp can land on the calendar day AFTER
    // TicketNetwork's un-converted date-only value for the exact same real
    // event. Without also registering here, those candidates would never be
    // looked up against each other at all — this rebuild would keep merging
    // the "obviously same day" cases and silently missing this one.
    const registerInAdjacentBuckets = (group, date) => {
      const d = new Date(date);
      const cityState = cityStatePart(group.primary);
      if (Number.isNaN(d.getTime())) {
        const key = `invalid-date|${cityState}`;
        if (!bucketsByKey.has(key)) bucketsByKey.set(key, []);
        bucketsByKey.get(key).push(group);
        return;
      }
      const baseUTC = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
      for (const offset of [-1, 0, 1]) {
        const day = new Date(baseUTC + offset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const key = `${day}|${cityState}`;
        if (!bucketsByKey.has(key)) bucketsByKey.set(key, []);
        bucketsByKey.get(key).push(group);
      }
    };

    const groups = [];
    const bucketsByKey = new Map();
    for (const row of rows) {
      const key = bucketKey(row);
      const bucket = bucketsByKey.get(key);
      const match = bucket && bucket.find((g) => isSameEvent(g.primary, row));
      if (match) {
        match.rows.push(row);
      } else {
        const group = { primary: row, rows: [row] };
        groups.push(group);
        registerInAdjacentBuckets(group, row.date);
      }
    }

    // ---- Build into fresh staging tables — the live canonical_events/
    // ticket_offers are not touched until the swap far below. ----
    // Drop any leftover from a previous run that crashed before its own
    // cleanup (rare — e.g. the process was killed mid-rebuild) so the
    // CREATE TABLE below doesn't fail with "already exists".
    await client.query('DROP TABLE IF EXISTS ticket_offers_new CASCADE');
    await client.query('DROP TABLE IF EXISTS canonical_events_new CASCADE');

    // LIKE ... INCLUDING ALL clones columns, defaults, NOT NULL/CHECK
    // constraints, generated/identity columns, and every index — including
    // the primary key and the unique (provider_id, provider_offer_id) index
    // the ON CONFLICT below relies on — from whatever the live table's
    // actual current shape is (so this never drifts out of sync with the
    // many ADD COLUMN migrations applied over time). The one thing it never
    // copies is foreign keys, so those are added back explicitly next.
    await client.query('CREATE TABLE canonical_events_new (LIKE canonical_events INCLUDING ALL)');
    await client.query('CREATE TABLE ticket_offers_new (LIKE ticket_offers INCLUDING ALL)');

    // LIKE's copied `id` DEFAULT is `nextval('canonical_events_id_seq')` —
    // it still points at the ORIGINAL table's sequence, not a new one made
    // for this table. Left alone, that means canonical_events_new.id and
    // the live canonical_events.id would share one sequence object, and
    // since a SERIAL sequence is OWNED BY the column that first created it,
    // retiring the old table below with DROP ... CASCADE would cascade-drop
    // that shared sequence — silently stripping the id DEFAULT off the
    // table this rebuild just promoted to live. Giving each staging table
    // its own independent, freshly-owned sequence (reset to start at 1,
    // matching the old RESTART IDENTITY behavior) avoids that entirely.
    await client.query(`
      CREATE SEQUENCE canonical_events_new_id_seq OWNED BY canonical_events_new.id;
      ALTER TABLE canonical_events_new ALTER COLUMN id SET DEFAULT nextval('canonical_events_new_id_seq'::regclass);
      SELECT setval('canonical_events_new_id_seq', 1, false);
    `);
    await client.query(`
      CREATE SEQUENCE ticket_offers_new_id_seq OWNED BY ticket_offers_new.id;
      ALTER TABLE ticket_offers_new ALTER COLUMN id SET DEFAULT nextval('ticket_offers_new_id_seq'::regclass);
      SELECT setval('ticket_offers_new_id_seq', 1, false);
    `);

    await client.query(`
      ALTER TABLE canonical_events_new
        ADD CONSTRAINT canonical_events_new_primary_event_row_id_fkey
          FOREIGN KEY (primary_event_row_id) REFERENCES events(id) ON DELETE SET NULL
    `);
    await client.query(`
      ALTER TABLE ticket_offers_new
        ADD CONSTRAINT ticket_offers_new_canonical_event_id_fkey
          FOREIGN KEY (canonical_event_id) REFERENCES canonical_events_new(id) ON DELETE CASCADE,
        ADD CONSTRAINT ticket_offers_new_provider_id_fkey
          FOREIGN KEY (provider_id) REFERENCES providers(id),
        ADD CONSTRAINT ticket_offers_new_source_event_row_id_fkey
          FOREIGN KEY (source_event_row_id) REFERENCES events(id) ON DELETE SET NULL
    `);

    let canonicalCount = 0;
    let offerCount = 0;
    let skippedNoProvider = 0;
    // price_history rows can't be inserted yet: its existing foreign key
    // still points at whatever table is live-named `canonical_events` right
    // now (about to be retired), not at canonical_events_new, so an insert
    // referencing a canonical_events_new id would fail that check. Buffered
    // here and flushed once the swap below has made canonical_events_new
    // the live `canonical_events` and dropped that stale constraint.
    const priceHistoryBuffer = [];

    // How many groups to process between yields back to Node's event loop.
    // This whole loop is one long chain of awaited client.query() calls, but
    // those all resolve on the same pooled connection, so in practice the
    // run monopolizes the process for its entire duration and public
    // requests queue behind it unless we yield deliberately. An explicit
    // setImmediate every few hundred groups hands control back long enough
    // for pending I/O callbacks — i.e. other visitors' requests — to be
    // serviced. This no longer risks blocking those requests on a table
    // lock (the whole point of the staging-table rewrite above), but it
    // still keeps a long rebuild from starving the event loop itself.
    const YIELD_EVERY_N_GROUPS = 250;
    let groupsProcessed = 0;

    for (const group of groups) {
      const primary = group.primary;
      // Prefer whichever row in the group has the richest data for fields
      // that vary in completeness across sources (mirrors the live merge's
      // backfill-from-duplicates behavior).
      const imageRow = group.rows.find((r) => r.image_url) || primary;
      const artistRow = group.rows.find((r) => r.artist_name) || primary;
      // description is backfilled from a duplicate the same way image_url
      // and artist_name are, because the live merge in routes/events.js
      // backfills exactly those three fields (plus distance_km, which is
      // request-scoped and has no equivalent here). venue_address and
      // price_breakdown are deliberately NOT backfilled: the live merge
      // leaves both at the primary row's value, and the listing endpoint now
      // reads them from here, so backfilling would make the two paths
      // disagree.
      const descriptionRow = group.rows.find((r) => r.description) || primary;

      // Number of DISTINCT sources on this event, precomputed so the public
      // listing's default "most retailers first" ordering can be a plain
      // indexed column in ORDER BY instead of a count over ticket_offers per
      // candidate row. Distinct by SOURCE rather than by row on purpose:
      // that is what the live merge's offers.length counts (it collapses two
      // rows from one seller into a single offer), and it's what the listing
      // query's DISTINCT ON (provider) offer list returns. Rows whose source
      // has no providers row are excluded here for the same reason they're
      // skipped as offers below — they never become an offer at all.
      const offerSources = new Set(
        group.rows.filter((r) => providerIdByName.has(r.source)).map((r) => r.source)
      );

      // Excludes 'official' rows from the best-price comparison for the same
      // reason routes/events.js's live merge does — see that file's comment.
      // A festival/artist site's own JSON-LD price isn't a like-for-like
      // seller price, so it shouldn't be able to win best_price/best_source.
      // 'official' rows are historical leftovers from the removed
      // JSON-LD-scraping source (see DATA_SOURCES.md) — excluded from both
      // ends of the price range for the same reason the live merge
      // excludes them from best_price (routes/events.js), and because that
      // scraper no longer runs, so treating its old data as a current,
      // comparable seller price would be actively misleading. Run
      // POST /admin/cleanup/official-source-data to remove these rows
      // outright rather than just excluding them here.
      const priced = group.rows.filter((r) => r.min_price != null && r.source !== 'official');
      const best = priced.length > 0
        ? priced.reduce((a, b) => (Number(a.min_price) <= Number(b.min_price) ? a : b))
        : null;
      const worst = priced.length > 0
        ? priced.reduce((a, b) => (Number(a.min_price) >= Number(b.min_price) ? a : b))
        : null;

      const canonicalResult = await client.query(
        `INSERT INTO canonical_events_new
           (title, normalized_title, category, event_date, venue_name, city, state, country,
            latitude, longitude, image_url, artist_name, best_price, best_source,
            performer, highest_price,
            primary_event_row_id, description, venue_address, price_breakdown, offer_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
         RETURNING id`,
        [
          primary.title,
          normalizeTitle(primary.title),
          primary.category,
          primary.date,
          primary.venue_name,
          primary.city,
          primary.state,
          primary.country,
          primary.latitude,
          primary.longitude,
          imageRow.image_url,
          artistRow.artist_name,
          best ? best.min_price : null,
          best ? best.source : null,
          artistRow.artist_name, // performer — same value as artist_name under the spec's field name
          worst ? worst.min_price : null,
          // The representative RAW events.id for this merged event. This —
          // never canonical_events.id, which is reassigned every rebuild
          // (a fresh table each time now, same effective behavior as the
          // old RESTART IDENTITY) — is what the public listing endpoint
          // returns as each event's `id`, what the /event/:id-:slug detail
          // URLs and /go/event/:id affiliate redirects are built from, and
          // what click tracking logs against.
          primary.id,
          descriptionRow.description,
          primary.venue_address,
          // primary.price_breakdown comes back from the earlier `SELECT *
          // FROM events` already parsed into a native JS value (jsonb
          // columns round-trip that way in node-postgres) — here that's
          // an Array (e.g. [{max,min,type,currency}]) or null. Passing a
          // JS Array straight through as a query parameter does NOT
          // serialize it as JSON: node-postgres's default parameter
          // serializer treats plain arrays specially and encodes them as
          // a Postgres ARRAY literal ("{...}") instead, which is not
          // valid input for a jsonb column and made every single rebuild
          // since this column was added fail with "invalid input syntax
          // for type json", silently rolling back the whole transaction
          // (see the try/catch below) and leaving canonical_events stuck
          // on its last good pre-migration data. Re-stringifying here
          // gives Postgres the JSON text it actually expects.
          primary.price_breakdown != null ? JSON.stringify(primary.price_breakdown) : null,
          offerSources.size,
        ]
      );
      const canonicalId = canonicalResult.rows[0].id;
      canonicalCount++;

      for (const row of group.rows) {
        const providerId = providerIdByName.get(row.source);
        if (!providerId) {
          // Row is from a source not (yet) registered in the providers
          // table — skip rather than fail the whole rebuild.
          skippedNoProvider++;
          continue;
        }
        // Neither Ticketmaster's nor SeatGeek's bulk sync endpoint tells us
        // whether min_price includes fees, so total_price is left equal to
        // price (the only honest default) and price_type stays 'unknown'
        // rather than claiming 'base' or 'all_in' — see the migration
        // route's comment and DATA_SOURCES.md. fees/ticket_section/
        // ticket_row/ticket_quantity stay NULL for the same reason: the
        // bulk endpoints return an event-level price range, not individual
        // seat-level listings.
        const totalPrice = row.min_price;
        await client.query(
          `INSERT INTO ticket_offers_new
             (canonical_event_id, provider_id, provider_offer_id, source_event_row_id, price, max_price, currency, seller_url,
              last_updated, source_event_id, total_price, price_type, availability, affiliate_url)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           ON CONFLICT (provider_id, provider_offer_id) DO UPDATE SET
             canonical_event_id = EXCLUDED.canonical_event_id,
             price = EXCLUDED.price,
             max_price = EXCLUDED.max_price,
             seller_url = EXCLUDED.seller_url,
             last_updated = EXCLUDED.last_updated,
             total_price = EXCLUDED.total_price,
             availability = EXCLUDED.availability,
             affiliate_url = EXCLUDED.affiliate_url`,
          [
            canonicalId, providerId, row.external_id, row.id, row.min_price, row.max_price, 'USD', row.source_url,
            row.updated_at || new Date(), row.external_id, totalPrice, 'unknown',
            row.min_price != null ? 'available' : 'unknown', row.source_url,
          ]
        );
        offerCount++;

        // Buffered rather than inserted immediately — see the comment above
        // priceHistoryBuffer's declaration.
        priceHistoryBuffer.push({
          canonicalId, providerId, externalId: row.external_id, price: row.min_price, totalPrice,
        });
      }

      // Yield the event loop periodically (see YIELD_EVERY_N_GROUPS above)
      // so a multi-minute rebuild doesn't starve every concurrent public
      // request for its entire duration.
      groupsProcessed++;
      if (groupsProcessed % YIELD_EVERY_N_GROUPS === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    // ---- The swap: the only moment the live tables are touched. Four
    // plain renames in one short transaction — an ACCESS EXCLUSIVE lock on
    // canonical_events/ticket_offers held for milliseconds, not the whole
    // rebuild. ----
    await client.query('BEGIN');
    await client.query('ALTER TABLE ticket_offers RENAME TO ticket_offers_old');
    await client.query('ALTER TABLE canonical_events RENAME TO canonical_events_old');
    await client.query('ALTER TABLE canonical_events_new RENAME TO canonical_events');
    await client.query('ALTER TABLE ticket_offers_new RENAME TO ticket_offers');
    await client.query('COMMIT');

    // Retire the previous run's tables. CASCADE here only drops
    // price_history's foreign key (a dependent CONSTRAINT, since it
    // referenced the table object now named canonical_events_old) — it does
    // NOT delete price_history's rows. That's a real difference from the old
    // `TRUNCATE ... CASCADE`, which truncated (deleted the ROWS of) every
    // table with a foreign key into canonical_events, silently wiping
    // price_history on every single rebuild despite its own comment saying
    // it should accumulate — this rewrite fixes that as a side effect.
    // price_history is deliberately left without a foreign key afterward
    // (see the comment above the insert loop below) rather than re-added,
    // since a hard FK would just go stale again next rebuild anyway. Wrapped
    // so a cleanup hiccup here can't mask an otherwise-successful rebuild —
    // the swap above already succeeded and is live either way.
    try {
      await client.query('DROP TABLE IF EXISTS ticket_offers_old CASCADE');
      await client.query('DROP TABLE IF EXISTS canonical_events_old CASCADE');
    } catch (cleanupError) {
      console.error('Canonical rebuild: swap succeeded but dropping the retired tables failed (harmless — they\'ll be cleaned up next run):', cleanupError.message);
    }

    // Now that price_history's stale FK is gone, these ids (already
    // assigned above, and unaffected by the rename) can be logged safely.
    // price_history's real stable identity across rebuilds is
    // (provider_id, provider_offer_id) — canonical_event_id is only
    // meaningful relative to this run's snapshot, same as it always was.
    let priceHistoryInserted = 0;
    for (const entry of priceHistoryBuffer) {
      await client.query(
        `INSERT INTO price_history (canonical_event_id, provider_id, provider_offer_id, price, total_price)
         VALUES ($1,$2,$3,$4,$5)`,
        [entry.canonicalId, entry.providerId, entry.externalId, entry.price, entry.totalPrice]
      );
      priceHistoryInserted++;
      if (priceHistoryInserted % YIELD_EVERY_N_GROUPS === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    return {
      rawEventRows: rows.length,
      canonicalEvents: canonicalCount,
      ticketOffers: offerCount,
      skippedNoProvider,
    };
  } catch (error) {
    // Best-effort: clean up this run's staging tables so a failed attempt
    // doesn't block the next one with "relation already exists". If the
    // swap already happened by the time something failed (e.g. during the
    // price_history flush), these are no-ops — canonical_events_new/
    // ticket_offers_new no longer exist under those names, and the live
    // tables (already correctly swapped in) are untouched by any of this.
    await client.query('DROP TABLE IF EXISTS ticket_offers_new CASCADE').catch(() => {});
    await client.query('DROP TABLE IF EXISTS canonical_events_new CASCADE').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export default { rebuildCanonicalEvents };
