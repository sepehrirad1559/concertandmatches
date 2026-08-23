import { pool } from '../index.js';
import { isSameEvent } from '../utils/matching.js';

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

export async function rebuildCanonicalEvents() {
  const client = await pool.connect();
  try {
    const providerRows = await client.query('SELECT id, name FROM providers');
    const providerIdByName = new Map(providerRows.rows.map((p) => [p.name, p.id]));

    const eventsResult = await client.query('SELECT * FROM events ORDER BY date ASC');
    const rows = eventsResult.rows;

    // Group rows representing the same real-world event, same algorithm as
    // the live API's mergeEventsAcrossSources.
    const groups = [];
    for (const row of rows) {
      const match = groups.find((g) => isSameEvent(g.primary, row));
      if (match) {
        match.rows.push(row);
      } else {
        groups.push({ primary: row, rows: [row] });
      }
    }

    await client.query('BEGIN');
    // Derived tables only — never touches `events` or `click_events`.
    await client.query('TRUNCATE ticket_offers, canonical_events RESTART IDENTITY CASCADE');

    let canonicalCount = 0;
    let offerCount = 0;
    let skippedNoProvider = 0;

    for (const group of groups) {
      const primary = group.primary;
      // Prefer whichever row in the group has the richest data for fields
      // that vary in completeness across sources (mirrors the live merge's
      // backfill-from-duplicates behavior).
      const imageRow = group.rows.find((r) => r.image_url) || primary;
      const artistRow = group.rows.find((r) => r.artist_name) || primary;

      // Excludes 'official' rows from the best-price comparison for the same
      // reason routes/events.js's live merge does — see that file's comment.
      // A festival/artist site's own JSON-LD price isn't a like-for-like
      // seller price, so it shouldn't be able to win best_price/best_source.
      const priced = group.rows.filter((r) => r.min_price != null && r.source !== 'official');
      const best = priced.length > 0
        ? priced.reduce((a, b) => (Number(a.min_price) <= Number(b.min_price) ? a : b))
        : null;

      const canonicalResult = await client.query(
        `INSERT INTO canonical_events
           (title, normalized_title, category, event_date, venue_name, city, state, country,
            latitude, longitude, image_url, artist_name, best_price, best_source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
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
        await client.query(
          `INSERT INTO ticket_offers
             (canonical_event_id, provider_id, provider_offer_id, source_event_row_id, price, max_price, currency, seller_url, last_updated)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (provider_id, provider_offer_id) DO UPDATE SET
             canonical_event_id = EXCLUDED.canonical_event_id,
             price = EXCLUDED.price,
             max_price = EXCLUDED.max_price,
             seller_url = EXCLUDED.seller_url,
             last_updated = EXCLUDED.last_updated`,
          [canonicalId, providerId, row.external_id, row.id, row.min_price, row.max_price, 'USD', row.source_url, row.updated_at || new Date()]
        );
        offerCount++;
      }
    }

    await client.query('COMMIT');
    return {
      rawEventRows: rows.length,
      canonicalEvents: canonicalCount,
      ticketOffers: offerCount,
      skippedNoProvider,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export default { rebuildCanonicalEvents };
