// Utilities for matching "the same real-world event" across data sources
// (Ticketmaster, SeatGeek) so the events API can merge duplicate listings
// into a single card with one offer per source — the actual comparison
// layer — instead of showing the same concert twice.

// Low-signal words stripped before comparing titles/artist names. Removing
// these means "Beyoncé World Tour" and "Beyoncé" score as a strong match
// instead of being dragged down by words one source includes and the other
// doesn't.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'at', 'in', 'on', 'of', 'presents', 'presented',
  'tour', 'live', 'world', 'concert', 'featuring', 'feat', 'ft', 'with',
  'special', 'guest', 'guests', 'tickets', 'tickets!',
]);

// A few British/American spelling variants that differ between
// Ticketmaster and SeatGeek venue names ("Theatre" vs "Theater", etc.).
const WORD_ALIASES = {
  theatre: 'theater',
  centre: 'center',
  amphitheatre: 'amphitheater',
  // Sports-specific: SeatGeek/Ticketmaster team names are sometimes given
  // with an abbreviated city and sometimes spelled out, and this differs
  // by source/team in ways WORD_ALIASES needs to bridge explicitly (no
  // general abbreviation-expansion logic exists here) — otherwise "LA
  // Lakers" vs "Los Angeles Lakers" scores as barely-related token sets
  // despite being the same team. Each maps to a SPACE-SEPARATED expansion
  // (possibly multiple words) — normalizeTokens below splits these back
  // out into individual tokens so "la" still overlaps with the separate
  // "los" and "angeles" tokens the spelled-out side produces.
  // Deliberately excludes ambiguous short words that are also common
  // English words in real titles ("no" for New Orleans being the obvious
  // one — aliasing it would risk "No Doubt" or similar picking up stray
  // "new orleans" tokens) — the day+city+state prefilter in isSameEvent
  // makes a false merge unlikely even so, but there's no upside to adding
  // that risk for one team's abbreviation.
  la: 'los angeles', ny: 'new york', sf: 'san francisco', gs: 'golden state',
  dc: 'washington', okc: 'oklahoma city',
};

// Lowercase, strip accents/punctuation, collapse whitespace, normalize a
// few spelling variants, and drop stopwords — leaves a token list that's
// robust to the small wording differences between two APIs describing the
// same show.
export function normalizeTokens(text) {
  if (!text) return [];
  const cleaned = text
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return [];

  return cleaned
    .split(' ')
    .filter(Boolean)
    // WORD_ALIASES values may be multi-word ("la" -> "los angeles") —
    // flatMap + re-split so an abbreviation expands into the same
    // individual tokens the spelled-out form would produce, not one fused
    // token that would never overlap with anything.
    .flatMap((w) => (WORD_ALIASES[w] || w).split(' '))
    .filter((w) => !STOPWORDS.has(w));
}

// Dice coefficient over token sets (2 * overlap / total tokens). Robust to
// word order and to one string containing extra words the other doesn't.
// Returns 0..1.
export function tokenSimilarity(a, b) {
  const setA = new Set(normalizeTokens(a));
  const setB = new Set(normalizeTokens(b));
  if (setA.size === 0 || setB.size === 0) return 0;
  let overlap = 0;
  for (const t of setA) if (setB.has(t)) overlap++;
  return (2 * overlap) / (setA.size + setB.size);
}

// Same calendar day, compared via UTC date components rather than exact
// timestamps — tolerant of the small start-time/timezone-formatting
// differences between sources without needing to guess a threshold.
export function isSameDay(dateA, dateB) {
  if (!dateA || !dateB) return false;
  const a = new Date(dateA);
  const b = new Date(dateB);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return false;
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

// Best-effort "is this the same real-world event" check across two rows
// from DIFFERENT sources. Two listings are only merged when they're on the
// same day and in the same city/state (cheap, exact, and reliable), AND
// the artist/title strings are a strong match on their own OR (a weaker
// title match backed by a strong venue-name match).
//
// Earlier this only required EITHER a venue match OR a title match, which
// turned out to be unsafe in production: big multi-use venues (arenas,
// residency venues like Sphere, amphitheaters) host a different act every
// night, so "same venue, same day" alone merged completely unrelated shows
// — e.g. a real case where a Ticketmaster "Chance The Rapper" listing got
// merged with a SeatGeek "Jack Harlow" listing purely because they shared
// a venue and date. Requiring at least SOME title/artist token overlap
// even in the venue-match branch (TITLE_FLOOR) closes that hole — real
// duplicates of the same show still share artist-name tokens even when
// venue names are formatted differently, but two different artists never
// do. The tradeoff is this will occasionally miss a genuine duplicate
// where one source's title is a fully generic string with zero overlap;
// that's the safer failure mode for a price-comparison feature than
// showing two different concerts as if they were "offers" for one event.
const TITLE_STRONG_MATCH = 0.6;
const VENUE_STRONG_MATCH = 0.5;
const TITLE_FLOOR_FOR_VENUE_MATCH = 0.15;

export function isSameEvent(a, b) {
  if (!a || !b) return false;
  if (a.source === b.source) return false; // only merge ACROSS sources
  if (!isSameDay(a.date, b.date)) return false;
  if ((a.city || '').toLowerCase().trim() !== (b.city || '').toLowerCase().trim()) return false;
  if ((a.state || '').toLowerCase().trim() !== (b.state || '').toLowerCase().trim()) return false;

  const venueScore = tokenSimilarity(a.venue_name, b.venue_name);

  // Two ways to compare "what is this event of/about", and we take
  // whichever scores higher — they diverge specifically for team sports.
  // Ticketmaster's artist_name is never populated (concerts or sports —
  // see ticketmaster.js's storeEvent, which has no artist_name column in
  // its INSERT at all), so `a.artist_name || a.title` always falls back to
  // Ticketmaster's title, which for a game is the full matchup ("Dallas
  // Cowboys at Philadelphia Eagles"). SeatGeek DOES populate artist_name
  // (performers[0].name), but for a team-sports event that's only ONE
  // team, not the matchup — so comparing artist-name-preferring fields
  // ends up comparing a two-team title against a one-team name, a much
  // weaker signal than comparing SeatGeek's own (also full-matchup) title
  // against Ticketmaster's. For concerts this rarely matters since
  // artist_name and title usually describe the same thing there; for
  // sports it was the main reason same-game listings from both sources
  // failed to merge into one comparison card.
  const artistPreferredScore = tokenSimilarity(a.artist_name || a.title, b.artist_name || b.title);
  const titleOnlyScore = tokenSimilarity(a.title, b.title);
  const titleScore = Math.max(artistPreferredScore, titleOnlyScore);

  if (titleScore >= TITLE_STRONG_MATCH) return true;
  if (venueScore >= VENUE_STRONG_MATCH && titleScore >= TITLE_FLOOR_FOR_VENUE_MATCH) return true;
  return false;
}
