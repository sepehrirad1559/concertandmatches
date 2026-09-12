// TEMPORARY site-wide visibility toggle. Originally set 2026-09-12 to hide
// both SeatGeek and Ticketmaster, showing only TicketNetwork; later the same
// day Ticketmaster was brought back; now SeatGeek is brought back too, so
// this fully reverts to showing all three sources. Note: the separate,
// PERMANENT price filter (config/priceVisibility.js) still hides any event
// with no price at all, and as of this change essentially every SeatGeek
// event has no price (its affiliate pricing is still blocked on a pending
// account approval, and its free-tier Platform API stats are frequently
// empty even for events that are for sale) — so un-hiding SeatGeek here is
// necessary but likely not sufficient on its own for SeatGeek events to
// actually become visible; that's a data problem, not this toggle.
//
// Left as a no-op (null) rather than deleted: flip back to an array (e.g.
// ['ticketnetwork', 'ticketmaster']) if a source ever needs hiding again —
// every call site below already treats null as "no restriction".
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
