// PERMANENT site-wide visibility rule for the raw `events` table (used by
// routes/events.js's raw-path listing, fetchDiscoverCandidates, and
// routes/sitemap.js — the canonical-layer path doesn't need this: see
// services/canonicalize.js's rebuild query, which excludes delisted rows at
// the source).
//
// HISTORY (2026-09-27): this used to hide every event with no price at all,
// on the premise that "no price from the source" reliably meant "sold out,
// nothing to buy." That held for TicketNetwork/SeatGeek, whose initial sync
// normally captures a full price range, but broke once Ticketmaster's
// coverage went worldwide (2026-09-26): Ticketmaster's bulk discovery
// endpoint returns a price for only a fraction of events, with the rest
// needing a separate, rate-limited per-event price backfill that can take
// weeks to fully catch up (see services/ticketmaster.js's
// backfillMissingPrices) — so "unpriced Ticketmaster event" overwhelmingly
// means "real, on-sale event whose price we haven't fetched yet," not "sold
// out."
//
// The user asked to stop hiding merely-unpriced events, but to keep hiding
// events that are ACTUALLY expired or sold out/delisted. Expiration is
// already handled by every call site's own `date >= NOW()` clause — this
// filter's job now is only the "sold out/delisted" half, via the
// price-independent delisted_at column (see services/ticketnetwork.js's
// stale-listing sweep, which sets/clears it based on that source's own
// feed) rather than price.
export function appendPricedOnlyFilter(whereClause) {
  return `${whereClause} AND delisted_at IS NULL`;
}
