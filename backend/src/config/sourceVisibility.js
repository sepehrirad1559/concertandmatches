// Site-wide visibility toggle. Was ['ticketnetwork', 'curated'] (set
// 2026-09-20) to temporarily hide Ticketmaster/SeatGeek events while they
// were still in the database, then null (2026-09-21, once Ticketmaster and
// SeatGeek were fully purged and unsynced — no restriction needed with
// nothing left to hide).
//
// PERMANENT as of 2026-09-27 (explicit user request): "only focus on
// Ticketmaster and Ticket Network" — SeatGeek is excluded from the platform
// on purpose, not because it happens to have no rows right now. Ticketmaster
// was re-added worldwide on 2026-09-26 (see backend/src/index.js), so this
// is no longer "nothing left to hide" — it's a real, permanent allowlist.
// 'curated' (small hand-picked attractions like The Rockefeller Center, see
// services/curatedAttractions.js) is kept since the user's instruction was
// about SeatGeek specifically, not curated content. If SeatGeek rows ever
// exist in the events table (they shouldn't — nothing syncs it), this list
// hides them without needing a data purge first; run
// POST /admin/cleanup/seatgeek-data to remove them outright.
export const ACTIVE_SOURCES = ['ticketmaster', 'ticketnetwork', 'curated'];

// Appends a `source = ANY(...)` condition to an existing WHERE clause
// string, pushing ACTIVE_SOURCES onto `params` and returning the next free
// paramCount — the same accumulator pattern every filter in routes/events.js
// already uses. No-ops (returns the inputs unchanged) when ACTIVE_SOURCES is
// null, so callers can use this unconditionally.
export function appendSourceFilter(whereClause, params, paramCount) {
  if (!ACTIVE_SOURCES) return { whereClause, paramCount };
  const nextClause = `${whereClause} AND source = ANY($${paramCount}::text[])`;
  params.push(ACTIVE_SOURCES);
  return { whereClause: nextClause, paramCount: paramCount + 1 };
}
