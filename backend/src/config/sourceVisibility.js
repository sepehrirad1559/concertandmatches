// TEMPORARY site-wide visibility toggle. Re-enabled 2026-09-20 at the
// user's request to hide Ticketmaster and SeatGeek events "for now" —
// showing only TicketNetwork and the small hand-curated set (Rockefeller
// Center etc., source='curated'). Every call site below already treats
// this as "only list/count/sitemap events whose source is in this list",
// so setting it is the whole change; no other file needs touching.
//
// To fully revert back to showing all sources again, set this back to null
// — every call site already treats null as "no restriction".
export const ACTIVE_SOURCES = ['ticketnetwork', 'curated'];

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
