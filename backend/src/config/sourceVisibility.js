// TEMPORARY site-wide visibility toggle. Originally set 2026-09-12 to hide
// both SeatGeek and Ticketmaster, showing only TicketNetwork. Updated the
// same day to bring Ticketmaster back (after a full comprehensive
// Ticketmaster catalog sync) while SeatGeek stays hidden — SeatGeek's
// affiliate pricing is still blocked on its own pending account approval, so
// its events would show with no price anyway.
//
// To restore normal behavior (show all three sources again), set this back
// to null — every call site below treats null as "no restriction" and
// reverts to its original query. That's the entire revert; nothing else
// needs to change.
export const ACTIVE_SOURCES = ['ticketnetwork', 'ticketmaster'];

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
