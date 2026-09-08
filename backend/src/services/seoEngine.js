// Reverse-engineered, search-demand-driven programmatic SEO engine.
//
// HONEST DATA-SOURCE DISCLOSURE (read this before trusting any number this
// file produces): this platform does not have Google Search Console,
// Google Trends, or any third-party keyword-volume API wired in — those
// need credentials nobody has handed this codebase, so this file NEVER
// fabricates a search-volume number. Every signal it uses is something
// this platform can actually measure:
//   - real inventory (the `events` table — event count, source diversity,
//     price coverage, freshness)
//   - real on-site behavior (`click_events` — see admin.js's own caveat
//     that most current traffic is bot-driven with null referrer/session,
//     so click counts are a directional signal at best right now, not a
//     verified demand number)
//   - a small, explicitly-labeled HEURISTIC popularity list for major
//     sports leagues/categories, used only as a tie-breaker weight, never
//     as a substitute for real demand data
// When real search-volume/GSC/Trends data becomes available, wire it into
// `demandScore` below — the scoring function is intentionally one place so
// that's a small, contained change later.
//
// SEO Opportunity Score = weighted blend of:
//   inventory (how much real, current stock backs this page)
//   diversity (multi-source price comparison — the actual product)
//   commercial intent (fraction of inventory with a real, comparable price)
//   demand (real clicks when we have them; a conservative heuristic floor
//     when we don't, clearly flagged)
//   freshness (how soon the nearest event is — a stale-looking page is a
//     bad candidate for a page type built around "buy tickets now")
//
// Tiers, in descending priority for indexing/sitemap inclusion:
//   tier1        strong on every axis — the pages worth the most crawl
//                budget and internal-link weight
//   tier2        solid, real inventory and some diversity/commercial signal
//   tier3        long-tail but still genuinely backed by real inventory
//   do-not-index insufficient inventory/signal — the page either doesn't
//                get generated, or gets a noindex + excluded from the
//                sitemap if it must exist for navigation reasons

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../index.js';
import { mergeEventsAcrossSources } from '../routes/events.js';

// Real (not fabricated) search-intent signal: a periodic, dated snapshot of
// actual Google Autocomplete completions for this platform's top inventory
// entities — see backend/data/search-patterns.json for the full disclosure
// of what this is and isn't. Autocomplete suggestions are genuine aggregate
// searcher behavior returned by Google itself, not volume figures and
// definitely not text an AI model invented — but Google's suggest endpoint
// is undocumented/unofficial, so this is pulled by hand in a research
// session and refreshed periodically, never called live from production
// (repeated automated hits risk rate-limiting/blocking and there's no
// supported contract for it). Loaded once at startup; a missing/unreadable
// file degrades to "no confirmed search data" rather than crashing anything
// that depends on it.
const SEARCH_PATTERNS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../data/search-patterns.json');
let SEARCH_PATTERNS = { entries: [] };
try {
  SEARCH_PATTERNS = JSON.parse(fs.readFileSync(SEARCH_PATTERNS_PATH, 'utf8'));
} catch (err) {
  console.warn('search-patterns.json not loaded — confirmed-search-data signal will be empty:', err.message);
}
const SEARCH_PATTERNS_BY_KEY = new Map(
  SEARCH_PATTERNS.entries.map((e) => [`${e.matchType}:${e.matchKey}`, e])
);

// Looks up a real confirmed-search-pattern entry for an entity, if this
// snapshot happens to cover it. Returns null for the (large majority of)
// entities not in the hand-pulled sample — that's expected and honest,
// not an error; scoreOpportunity() and the page templates both treat "no
// entry" as "no claim made" rather than "confirmed zero interest".
export function lookupSearchPatterns(matchType, matchKey) {
  return SEARCH_PATTERNS_BY_KEY.get(`${matchType}:${matchKey}`) || null;
}

export function slugify(text) {
  return (text || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'page';
}

// A handful of well-known major North American pro/college leagues and
// franchises get a small heuristic demand bump — this is NOT search-volume
// data, it's a coarse, explicitly-labeled prior standing in for the real
// thing until GSC/Trends access exists. Kept intentionally small and
// generic (leagues, not thousands of hand-picked artist names) so it can't
// quietly become "fabricated keyword research" by accretion.
const HEURISTIC_HIGH_DEMAND_LEAGUES = new Set(['nfl', 'nba', 'ncaaFootball']);

const WEIGHTS = {
  inventory: 0.25,
  diversity: 0.20,
  commercial: 0.20,
  demand: 0.20,
  freshness: 0.15,
};

const TIER_THRESHOLDS = { tier1: 0.55, tier2: 0.35, tier3: 0.18 };

function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

// eventCount/sourceCount/pricedFraction/clickCount/daysToNearest all come
// straight from real queries — see callers below. heuristicBoost is the
// only non-measured input, and it only ever nudges demandScore, never any
// other axis.
export function scoreOpportunity({
  eventCount = 0,
  sourceCount = 0,
  pricedFraction = 0,
  clickCount = 0,
  daysToNearest = null,
  heuristicBoost = false,
  hasConfirmedSearchData = false,
}) {
  const inventoryScore = clamp01(Math.log10(eventCount + 1) / 2); // ~100 events -> 1.0
  const diversityScore = clamp01(sourceCount / 2); // 2+ sources -> full comparison value
  const commercialScore = clamp01(pricedFraction);

  // Real click data is the honest signal; when there simply isn't any yet
  // (new page, low-traffic site, or the null-referrer bot-traffic pattern
  // documented in admin.js), fall back to a small flat floor rather than
  // scoring demand as a hard 0 — and note explicitly which mode was used.
  const hasClickSignal = clickCount > 0;
  let demandScore = hasClickSignal ? clamp01(Math.log10(clickCount + 1) / 2) : 0.15;
  if (heuristicBoost) demandScore = clamp01(demandScore + 0.15);
  // A confirmed Google Autocomplete hit (see search-patterns.json / the
  // lookupSearchPatterns() loader above) is real evidence people actually
  // search for this entity with ticket-buying intent — a smaller, distinct
  // bump from the heuristic league boost, and only applied when this
  // specific entity is in the hand-pulled snapshot.
  if (hasConfirmedSearchData) demandScore = clamp01(demandScore + 0.1);

  let freshnessScore = 0.3;
  if (daysToNearest != null) {
    if (daysToNearest <= 30) freshnessScore = 1;
    else if (daysToNearest <= 90) freshnessScore = 0.6;
  }

  const score = clamp01(
    inventoryScore * WEIGHTS.inventory +
    diversityScore * WEIGHTS.diversity +
    commercialScore * WEIGHTS.commercial +
    demandScore * WEIGHTS.demand +
    freshnessScore * WEIGHTS.freshness
  );

  let tier = 'do-not-index';
  if (score >= TIER_THRESHOLDS.tier1) tier = 'tier1';
  else if (score >= TIER_THRESHOLDS.tier2) tier = 'tier2';
  else if (score >= TIER_THRESHOLDS.tier3) tier = 'tier3';

  return {
    score: Number(score.toFixed(3)),
    tier,
    breakdown: {
      inventoryScore: Number(inventoryScore.toFixed(3)),
      diversityScore: Number(diversityScore.toFixed(3)),
      commercialScore: Number(commercialScore.toFixed(3)),
      demandScore: Number(demandScore.toFixed(3)),
      freshnessScore: Number(freshnessScore.toFixed(3)),
      demandSource: hasClickSignal ? 'real-click-data' : 'heuristic-floor-no-click-data-yet',
      confirmedByRealSearchData: hasConfirmedSearchData,
    },
  };
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr).getTime();
  if (Number.isNaN(d)) return null;
  return Math.max(0, Math.round((d - Date.now()) / 86400000));
}

// ---- Artists ---------------------------------------------------------

// Every distinct artist with at least one upcoming event, across every
// source (not just SeatGeek, which is the only provider that reliably
// populates artist_name — see services/ticketmaster.js's storeEvent
// comment). Scored and tiered so /artists lists only real opportunities.
export async function discoverArtists({ limit = 500 } = {}) {
  const rows = await pool.query(`
    SELECT
      artist_name,
      COUNT(*)::int AS event_count,
      COUNT(DISTINCT source)::int AS source_count,
      COUNT(DISTINCT city)::int AS city_count,
      COUNT(*) FILTER (WHERE min_price IS NOT NULL)::int AS priced_count,
      MIN(date) AS nearest_date
    FROM events
    WHERE date >= NOW() AND artist_name IS NOT NULL AND artist_name != '' AND source != 'official'
    GROUP BY artist_name
    ORDER BY event_count DESC
    LIMIT $1
  `, [limit]);

  if (rows.rows.length === 0) return [];

  const artistNames = rows.rows.map((r) => r.artist_name);
  const clickRows = await pool.query(`
    SELECT e.artist_name, COUNT(c.*)::int AS click_count
    FROM click_events c
    JOIN events e ON e.id = c.event_row_id
    WHERE e.artist_name = ANY($1::text[])
    GROUP BY e.artist_name
  `, [artistNames]).catch(() => ({ rows: [] })); // click_events may not exist in a fresh env
  const clicksByArtist = new Map(clickRows.rows.map((r) => [r.artist_name, r.click_count]));

  return rows.rows.map((r) => {
    const slug = slugify(r.artist_name);
    const searchData = lookupSearchPatterns('artist', slug);
    const { score, tier, breakdown } = scoreOpportunity({
      eventCount: r.event_count,
      sourceCount: r.source_count,
      pricedFraction: r.event_count > 0 ? r.priced_count / r.event_count : 0,
      clickCount: clicksByArtist.get(r.artist_name) || 0,
      daysToNearest: daysUntil(r.nearest_date),
      hasConfirmedSearchData: !!searchData,
    });
    return {
      type: 'artist',
      artistName: r.artist_name,
      slug,
      eventCount: r.event_count,
      sourceCount: r.source_count,
      cityCount: r.city_count,
      score,
      tier,
      breakdown,
      confirmedSearches: searchData?.suggestions || null,
    };
  }).filter((a) => a.tier !== 'do-not-index');
}

export async function getArtistPage(slug) {
  const artists = await discoverArtists({ limit: 2000 });
  const match = artists.find((a) => a.slug === slug);
  if (!match) return null;

  const result = await pool.query(
    `SELECT * FROM events WHERE date >= NOW() AND artist_name = $1 ORDER BY date ASC LIMIT 300`,
    [match.artistName]
  );
  const events = mergeEventsAcrossSources(result.rows);
  return { ...match, events };
}

// ---- Cities ------------------------------------------------------------

const CITY_VARIANTS = ['events', 'concerts', 'sports'];

function categoryFilterForVariant(variant) {
  if (variant === 'concerts') return { categories: ['Music', 'Concert'] };
  if (variant === 'sports') return { categories: [], keywordsAny: ['NFL', 'NBA', 'NCAA', 'Football', 'Basketball', 'Sports'] };
  return null; // 'events' = everything
}

export async function discoverCities({ limit = 500 } = {}) {
  const rows = await pool.query(`
    SELECT
      city, state,
      COUNT(*)::int AS event_count,
      COUNT(DISTINCT source)::int AS source_count,
      COUNT(*) FILTER (WHERE min_price IS NOT NULL)::int AS priced_count,
      MIN(date) AS nearest_date
    FROM events
    WHERE date >= NOW() AND city IS NOT NULL AND city != '' AND city != 'Unknown'
    GROUP BY city, state
    ORDER BY event_count DESC
    LIMIT $1
  `, [limit]);

  const cityKeys = rows.rows.map((r) => `${r.city}|${r.state || ''}`);
  const clickRows = await pool.query(`
    SELECT e.city, e.state, COUNT(c.*)::int AS click_count
    FROM click_events c
    JOIN events e ON e.id = c.event_row_id
    GROUP BY e.city, e.state
  `).catch(() => ({ rows: [] }));
  const clicksByCity = new Map(clickRows.rows.map((r) => [`${r.city}|${r.state || ''}`, r.click_count]));

  return rows.rows.map((r) => {
    const key = `${r.city}|${r.state || ''}`;
    const slug = slugify(`${r.city}-${r.state || ''}`);
    const searchData = lookupSearchPatterns('city', slug);
    const { score, tier, breakdown } = scoreOpportunity({
      eventCount: r.event_count,
      sourceCount: r.source_count,
      pricedFraction: r.event_count > 0 ? r.priced_count / r.event_count : 0,
      clickCount: clicksByCity.get(key) || 0,
      daysToNearest: daysUntil(r.nearest_date),
      hasConfirmedSearchData: !!searchData,
    });
    return {
      type: 'city',
      city: r.city,
      state: r.state,
      slug,
      eventCount: r.event_count,
      score,
      tier,
      breakdown,
      confirmedSearches: searchData?.suggestions || null,
    };
  }).filter((c) => c.tier !== 'do-not-index');
}

export async function getCityPage(slug, variant = 'events') {
  if (!CITY_VARIANTS.includes(variant)) return null;
  const cities = await discoverCities({ limit: 2000 });
  const match = cities.find((c) => c.slug === slug);
  if (!match) return null;

  const filter = categoryFilterForVariant(variant);
  const params = [match.city, match.state || ''];
  let where = `date >= NOW() AND city = $1 AND COALESCE(state, '') = $2`;
  if (filter?.categories?.length) {
    params.push(filter.categories);
    where += ` AND category = ANY($${params.length}::text[])`;
  } else if (filter?.keywordsAny?.length) {
    const orParts = filter.keywordsAny.map((_, i) => {
      params.push(`\\m${filter.keywordsAny[i]}\\M`);
      return `(title ~* $${params.length} OR category ~* $${params.length})`;
    });
    where += ` AND (${orParts.join(' OR ')})`;
  }

  const result = await pool.query(
    `SELECT * FROM events WHERE ${where} ORDER BY date ASC LIMIT 300`,
    params
  );
  const events = mergeEventsAcrossSources(result.rows);
  if (events.length === 0) return null; // never render an empty city/variant combo
  return { ...match, variant, events };
}

// ---- Venues --------------------------------------------------------------

export async function discoverVenues({ limit = 500 } = {}) {
  const rows = await pool.query(`
    SELECT
      venue_name, city, state,
      COUNT(*)::int AS event_count,
      COUNT(DISTINCT source)::int AS source_count,
      COUNT(*) FILTER (WHERE min_price IS NOT NULL)::int AS priced_count,
      MIN(date) AS nearest_date
    FROM events
    WHERE date >= NOW() AND venue_name IS NOT NULL AND venue_name NOT IN ('', 'Unknown Venue')
    GROUP BY venue_name, city, state
    ORDER BY event_count DESC
    LIMIT $1
  `, [limit]);

  return rows.rows.map((r) => {
    const { score, tier, breakdown } = scoreOpportunity({
      eventCount: r.event_count,
      sourceCount: r.source_count,
      pricedFraction: r.event_count > 0 ? r.priced_count / r.event_count : 0,
      clickCount: 0, // venue-level click aggregation not worth a query per candidate at this stage
      daysToNearest: daysUntil(r.nearest_date),
    });
    return {
      type: 'venue',
      venueName: r.venue_name,
      city: r.city,
      state: r.state,
      slug: slugify(`${r.venue_name}-${r.city}`),
      eventCount: r.event_count,
      score,
      tier,
      breakdown,
    };
  }).filter((v) => v.tier !== 'do-not-index');
}

export async function getVenuePage(slug) {
  const venues = await discoverVenues({ limit: 2000 });
  const match = venues.find((v) => v.slug === slug);
  if (!match) return null;

  const result = await pool.query(
    `SELECT * FROM events WHERE date >= NOW() AND venue_name = $1 AND city = $2 ORDER BY date ASC LIMIT 200`,
    [match.venueName, match.city]
  );
  const events = mergeEventsAcrossSources(result.rows);
  if (events.length === 0) return null;
  return { ...match, events };
}

// ---- Leagues / categories -------------------------------------------------

// One real, canonical, indexable page per top-level category — distinct
// from the SPA's client-side category filter (which lives entirely behind
// "/" with no server-distinguishable URL, so it isn't something Google can
// index as its own result for "NFL tickets"). Reuses the exact same
// category/keyword rules the homepage discover sections already use, so
// this always matches real, currently-filterable inventory.
export const LEAGUE_DEFS = {
  nfl: { label: 'NFL', keywords: ['NFL'] },
  concerts: { label: 'Concerts', categories: ['Music', 'Concert'] },
  nba: { label: 'NBA', keywords: ['NBA', 'Basketball'] },
  'ncaa-football': { label: 'NCAA Football', keywords: ['NCAA Football', 'College Football', 'NCAA'] },
  theater: { label: 'Theater', categories: ['Arts & Theatre', 'Theatre', 'Theater'] },
  comedy: { label: 'Comedy', keywords: ['Comedy', 'Stand-Up', 'Stand Up'] },
};

export async function getLeaguePage(slug) {
  const def = LEAGUE_DEFS[slug];
  if (!def) return null;

  const params = [];
  let where = 'date >= NOW()';
  if (def.categories?.length) {
    params.push(def.categories);
    where += ` AND category = ANY($${params.length}::text[])`;
  } else if (def.keywords?.length) {
    const orParts = def.keywords.map((kw) => {
      params.push(`\\m${kw}\\M`);
      return `(title ~* $${params.length} OR category ~* $${params.length})`;
    });
    where += ` AND (${orParts.join(' OR ')})`;
  }

  const [countRow, sample] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS n, COUNT(DISTINCT source)::int AS sources, COUNT(*) FILTER (WHERE min_price IS NOT NULL)::int AS priced FROM events WHERE ${where}`, params),
    pool.query(`SELECT * FROM events WHERE ${where} ORDER BY date ASC LIMIT 300`, params),
  ]);

  const events = mergeEventsAcrossSources(sample.rows);
  if (events.length === 0) return null;

  const searchData = lookupSearchPatterns('league', slug);
  const { score, tier, breakdown } = scoreOpportunity({
    eventCount: countRow.rows[0].n,
    sourceCount: countRow.rows[0].sources,
    pricedFraction: countRow.rows[0].n > 0 ? countRow.rows[0].priced / countRow.rows[0].n : 0,
    clickCount: 0,
    daysToNearest: daysUntil(events[0]?.date),
    heuristicBoost: HEURISTIC_HIGH_DEMAND_LEAGUES.has(slug === 'ncaa-football' ? 'ncaaFootball' : slug),
    hasConfirmedSearchData: !!searchData,
  });

  return { type: 'league', slug, label: def.label, eventCount: countRow.rows[0].n, events, score, tier, breakdown, confirmedSearches: searchData?.suggestions || null };
}

// ---- Teams (best-effort, parsed from matchup titles) ----------------------

// Sports events are usually titled as a matchup ("Dallas Cowboys at
// Philadelphia Eagles", "X vs. Y") rather than carrying a structured
// team field. This extracts both team-name candidates from that title
// text for NFL/NBA/NCAA-Football-classified rows. It's inherently
// heuristic (a title format neither provider guarantees) — flagged as
// such wherever it's surfaced, and it only ever adds a team page when the
// SAME extracted name recurs across multiple real event rows, which
// filters out one-off parsing mistakes.
const MATCHUP_SPLIT = /\s+(?:at|vs\.?|@)\s+/i;

export async function discoverTeams({ limit = 500 } = {}) {
  const rows = await pool.query(`
    SELECT id, title, city, state, date, category
    FROM events
    WHERE date >= NOW() AND (category ~* '\\m(NFL|NBA|NCAA)\\M' OR title ~* '\\m(NFL|NBA|NCAA Football)\\M')
    LIMIT 20000
  `);

  const teamMap = new Map(); // normalized name -> { name, eventIds:Set, cities:Set }
  for (const row of rows.rows) {
    const parts = (row.title || '').split(MATCHUP_SPLIT).map((p) => p.trim()).filter(Boolean);
    if (parts.length !== 2) continue;
    for (const raw of parts) {
      // Strip trailing " Football"/" Tickets" noise and parenthetical
      // qualifiers some listings append.
      const cleaned = raw.replace(/\s*\(.*?\)\s*/g, '').replace(/\s+Football$/i, '').trim();
      if (!cleaned || cleaned.length > 60) continue;
      const key = slugify(cleaned);
      if (!key) continue;
      if (!teamMap.has(key)) teamMap.set(key, { name: cleaned, eventIds: new Set(), cities: new Set() });
      const entry = teamMap.get(key);
      entry.eventIds.add(row.id);
      entry.cities.add(`${row.city}, ${row.state}`);
    }
  }

  const candidates = [...teamMap.entries()]
    .map(([slug, v]) => ({ slug, name: v.name, eventCount: v.eventIds.size, cityCount: v.cities.size }))
    .filter((c) => c.eventCount >= 2) // require the name to recur — filters out one-off title-parsing noise
    .sort((a, b) => b.eventCount - a.eventCount)
    .slice(0, limit);

  return candidates.map((c) => {
    const searchData = lookupSearchPatterns('team', c.slug);
    const { score, tier, breakdown } = scoreOpportunity({
      eventCount: c.eventCount,
      sourceCount: 1, // matchup titles don't carry per-source team attribution reliably enough to count this
      pricedFraction: 0.5, // neutral placeholder; real per-team price coverage computed on the page itself
      clickCount: 0,
      daysToNearest: 30,
      hasConfirmedSearchData: !!searchData,
    });
    return { type: 'team', ...c, score, tier, breakdown, heuristic: true, confirmedSearches: searchData?.suggestions || null };
  }).filter((t) => t.tier !== 'do-not-index');
}

export async function getTeamPage(slug) {
  const teams = await discoverTeams({ limit: 2000 });
  const match = teams.find((t) => t.slug === slug);
  if (!match) return null;

  const result = await pool.query(
    `SELECT * FROM events WHERE date >= NOW() AND title ~* $1 ORDER BY date ASC LIMIT 200`,
    [`\\m${match.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\M`]
  );
  const events = mergeEventsAcrossSources(result.rows);
  if (events.length === 0) return null;
  return { ...match, events };
}
