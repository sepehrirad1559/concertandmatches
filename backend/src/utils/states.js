// Normalizes a US state (or Canadian province) value to its two-letter code
// so rows from sources that store different formats can still be compared.
//
// Root cause this fixes: TicketNetwork's catalog gives the state as a full
// name (e.g. "Wisconsin"), while Ticketmaster and SeatGeek store the
// two-letter abbreviation (e.g. "WI"). Both the live merge
// (routes/events.js mergeEventsAcrossSources) and the canonical rebuild
// (services/canonicalize.js rebuildCanonicalEvents) require an EXACT STRING
// match on (day, city, state) before ever attempting fuzzy title matching
// via isSameEvent — so "wisconsin" vs "wi" silently prevented two rows
// describing the same real event from ever being compared, even when city,
// venue, and date all agreed. Concrete example: "Western Illinois
// Leathernecks at Wisconsin Badgers Football" at Camp Randall Stadium,
// Madison — a Ticketmaster/SeatGeek row (state="WI") and a TicketNetwork row
// with the same real price (state="Wisconsin") never merged because of this.
//
// Applying this normalization at bucket-key time (rather than only at
// ingestion) fixes matching for ALL existing rows immediately on the next
// canonicalize rebuild / live request, with no need to backfill/migrate the
// already-stored `state` column values.
const STATE_NAME_TO_CODE = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS',
  missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM',
  'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH',
  oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI',
  'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX',
  utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA',
  'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
  'district of columbia': 'DC', 'washington dc': 'DC', 'washington d.c.': 'DC',
  // Territories occasionally seen in ticketing catalogs
  'puerto rico': 'PR', guam: 'GU',
  // Canadian provinces (a handful of cross-border venues show up in
  // ticketing catalogs)
  alberta: 'AB', 'british columbia': 'BC', manitoba: 'MB',
  'new brunswick': 'NB', 'newfoundland and labrador': 'NL',
  'nova scotia': 'NS', ontario: 'ON', 'prince edward island': 'PE',
  quebec: 'QC', saskatchewan: 'SK',
};

export function normalizeState(state) {
  const raw = (state || '').toLowerCase().trim();
  if (!raw) return '';
  // Both branches must return the same case — the bucket-key/isSameEvent
  // comparisons are case-sensitive string equality, and the dictionary
  // below stores its abbreviations uppercase, so the early "already an
  // abbreviation" branch has to uppercase too or e.g. "WI" (returned
  // lowercase here) would never equal "Wisconsin" normalized via the
  // dictionary to "WI" — the exact bug this file exists to prevent.
  if (raw.length <= 3) return raw.toUpperCase(); // already an abbreviation (2-3 chars)
  return STATE_NAME_TO_CODE[raw] || raw.toUpperCase();
}
