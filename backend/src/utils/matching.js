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
    .map((w) => WORD_ALIASES[w] || w)
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
  const titleScore = tokenSimilarity(a.artist_name || a.title, b.artist_name || b.title);

  if (titleScore >= TITLE_STRONG_MATCH) return true;
  if (venueScore >= VENUE_STRONG_MATCH && titleScore >= TITLE_FLOOR_FOR_VENUE_MATCH) return true;
  return false;
}
