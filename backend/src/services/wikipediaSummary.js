// Real, non-fabricated "About [artist/venue]" blurbs for event pages
// (backend/src/routes/prerender.js), added 2026-11-19 to address the GSC
// "Soft 404" bucket -- Search Console flagged 45,606 pages as thin/
// boilerplate, which is an honest description of what an event page looked
// like before this: title, date, venue line, and a list of sellers, with
// nothing unique about it beyond those fields. A real Wikipedia summary of
// the actual artist/team/venue is genuine third-party factual content, not
// invented copy, and is shared across every event for that same artist/
// venue, which is exactly the kind of real differentiation Google's own
// guidance on thin content calls for.
//
// Mirrors frontend/src/App.jsx's fetchWikipediaImage() -- same direct-title
// lookup with a MediaWiki search-API fallback for titles that don't match
// exactly, same disambiguation-page exclusion -- but server-side, cached
// in-process (not per-browser-tab), and returns the real `extract` text
// instead of (or alongside, callers may ignore it) the thumbnail image.
// Never fabricates: any failure, timeout, disambiguation page, or
// suspiciously short/empty extract resolves to null, and the caller is
// expected to simply omit the section rather than show a placeholder.

const SUMMARY_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days for a real hit
const NEGATIVE_TTL_MS = 12 * 60 * 60 * 1000; // 12h for "nothing found", so a
// one-off miss (rate limit, transient network error, a genuinely obscure
// name) doesn't get permanently remembered as "no bio exists", while still
// sparing Wikipedia a repeat request on every single page render for the
// same miss within half a day.
const FETCH_TIMEOUT_MS = 1500; // short enough that a slow/unreachable
// Wikipedia can never meaningfully slow down this site's own page response
// -- see the AbortController usage below.

// query -> { extract, title, fetchedAt } | { extract: null, fetchedAt }
const cache = new Map();

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// A minimum length guard -- Wikipedia's summary endpoint sometimes returns
// a near-empty extract for a stub article ("X is a town."), which reads as
// barely more useful than no content at all. 40 chars is a low bar (one
// short real sentence clears it easily) deliberately kept loose so this
// only rejects genuinely unhelpful stubs, not just terse-but-real articles.
const MIN_EXTRACT_LENGTH = 40;

function isUsableExtract(data) {
  return !!data && data.type !== 'disambiguation' && typeof data.extract === 'string'
    && data.extract.trim().length >= MIN_EXTRACT_LENGTH;
}

async function fetchSummaryExtract(query) {
  const summaryUrl = (title) =>
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;

  try {
    const directRes = await fetchWithTimeout(summaryUrl(query));
    if (directRes.ok) {
      const data = await directRes.json();
      if (isUsableExtract(data)) {
        return { extract: data.extract.trim(), title: data.title || query };
      }
    }
  } catch {
    // network error / timeout on the direct lookup -- fall through to the
    // search fallback below, same as fetchWikipediaImage's own pattern.
  }

  try {
    const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&origin=*&srlimit=1`;
    const searchRes = await fetchWithTimeout(searchUrl);
    if (!searchRes.ok) return null;
    const searchData = await searchRes.json();
    const bestTitle = searchData?.query?.search?.[0]?.title;
    if (!bestTitle) return null;
    const fallbackRes = await fetchWithTimeout(summaryUrl(bestTitle));
    if (!fallbackRes.ok) return null;
    const fallbackData = await fallbackRes.json();
    if (!isUsableExtract(fallbackData)) return null;
    return { extract: fallbackData.extract.trim(), title: fallbackData.title || bestTitle };
  } catch {
    return null;
  }
}

// Returns { extract, title, url } for a genuine, cached Wikipedia summary
// of `query` (an artist/team/venue name), or null if nothing usable was
// found. `title` is Wikipedia's own canonical article title (may differ
// slightly from `query`, e.g. resolved via the search fallback) -- used to
// build a real, correctly-linking attribution URL back to the source
// article, which CC BY-SA attribution calls for and which also gives the
// page a genuine, relevant outbound citation rather than an unlinked claim.
export async function getWikipediaExtract(query) {
  if (!query || !query.trim()) return null;
  const key = query.trim();

  const cached = cache.get(key);
  if (cached) {
    const ttl = cached.extract ? SUMMARY_TTL_MS : NEGATIVE_TTL_MS;
    if (Date.now() - cached.fetchedAt < ttl) {
      return cached.extract ? { extract: cached.extract, title: cached.title, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(cached.title.replace(/ /g, '_'))}` } : null;
    }
  }

  const result = await fetchSummaryExtract(key).catch(() => null);
  cache.set(key, { extract: result?.extract || null, title: result?.title || null, fetchedAt: Date.now() });
  if (!result) return null;
  return { extract: result.extract, title: result.title, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(result.title.replace(/ /g, '_'))}` };
}
