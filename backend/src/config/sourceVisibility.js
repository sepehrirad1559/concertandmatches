// TEMPORARY site-wide visibility toggle. Requested 2026-09-12: hide every
// SeatGeek and Ticketmaster event and show only TicketNetwork events across
// the platform's public browsing surfaces (homepage list/search/discover
// sections, autocomplete, event detail/merge, sitemap).
//
// To restore normal behavior (show all sources again), set this back to
// null — every call site below treats null as "no restriction" and reverts
// to its original query. That's the entire revert; nothing else needs to
// change.
export const ACTIVE_SOURCES = ['ticketnetwork'];

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
