// Site-wide visibility toggle. Was ['ticketnetwork', 'curated'] (set
// 2026-09-20) to temporarily hide Ticketmaster/SeatGeek events while they
// were still in the database. As of 2026-09-21, Ticketmaster and SeatGeek
// are no longer synced AND their existing rows have been purged from the
// events table (see backend/src/index.js's import comment and
// routes/admin.js's /cleanup/ticketmaster-data + /cleanup/seatgeek-data) —
// so there's nothing left for this list to hide, and it's set back to null
// (no restriction). Every call site below already treats null as "no
// restriction", so this is safe to leave in place going forward and only
// needs to be set again if a source needs hiding without deleting its data.
export const ACTIVE_SOURCES = null;

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
