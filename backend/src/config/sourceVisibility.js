// Site-wide visibility toggle. History: ['ticketnetwork', 'curated'] (set
// 2026-09-20) to temporarily hide Ticketmaster/SeatGeek, then null
// (2026-09-21, once both were fully purged). "Permanent" SeatGeek exclusion
// set 2026-09-27 ("only focus on Ticketmaster and Ticket Network"), and
// Ticketmaster itself separately discontinued 2026-10-08 — both reversed
// 2026-10-10 (explicit user request: business model is to pull availability
// and price range from all three major sellers — Ticketmaster, TicketNetwork,
// and SeatGeek — and show customers the price range across them). All three
// real sources plus 'curated' are active again; null would mean "no
// restriction" and isn't needed while this is a real, deliberate allowlist.
export const ACTIVE_SOURCES = ['ticketmaster', 'ticketnetwork', 'seatgeek', 'curated'];

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
