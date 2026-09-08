# Programmatic SEO Strategy — ConcertAndMatches.com

## What this is, honestly

This system generates server-rendered, indexable pages (artists, cities,
venues, leagues, teams) driven by an "SEO Opportunity Score" computed from
**real, measurable signals only**. It does not have access to Google Search
Console, Google Trends, or any third-party keyword-volume API — no
credentials for those exist in this codebase — so **no search-volume number
anywhere in this system is fabricated or estimated as if it were exact**.
Every page that exists is backed by real inventory in the `events` table at
the moment it's requested; pages are computed live, not pre-baked, so a page
disappears the moment the inventory behind it does (see "Freshness &
correctness" below).

## Signals actually used

| Signal | Source | What it measures |
|---|---|---|
| Inventory | `events` table: `COUNT(*)` per entity | How much real, current stock backs a page |
| Diversity | `events.source` distinct count | Whether there's a real multi-seller price to compare (the actual product) |
| Commercial intent | fraction of rows with `min_price IS NOT NULL` | Whether a visitor can actually see/compare a price |
| Demand | `click_events` joined to the entity, when available | Real on-site behavior — **caveat:** an analytics review on 2026-09-07 found ~2,075 of 2,078 logged clicks have null `referrer`/`session_id`, a pattern consistent with automated/bot traffic rather than real visitors (see `backend/src/routes/admin.js`'s comment on the disabled `/go` route). Click counts are therefore a **directional** signal today, not a verified demand number. |
| Freshness | days until the nearest event | A "buy tickets now" page pointing at events months away, or none at all, is a worse candidate |
| Heuristic league boost | a small hardcoded set (`HEURISTIC_HIGH_DEMAND_LEAGUES = {nfl, nba, ncaaFootball}`) | The **only** non-measured input in the whole system — a coarse prior that NFL/NBA/NCAA Football are broadly higher-demand categories than average, used only as a small tie-breaker on the demand axis. Explicitly labeled `heuristicBoost` in the code and flagged in each score's `breakdown.demandSource` field (`'real-click-data'` vs `'heuristic-floor-no-click-data-yet'`) so it's never presented as more certain than it is. |

No page is ever generated because a keyword exists in isolation — every
entity discovered (`discoverArtists`, `discoverCities`, `discoverVenues`,
`discoverTeams`, plus the fixed `LEAGUE_DEFS` set) is grouped directly off
the `events` table, so a page can only exist if there's at least one real
upcoming row behind it, and detail pages additionally 404 (rather than
render empty) if that inventory disappears between the index query and the
detail query — see "Freshness & correctness" below.

## Scoring formula

```
score = 0.25 * inventoryScore     (log-scaled event count)
      + 0.20 * diversityScore     (source count / 2, capped at 1.0)
      + 0.20 * commercialScore    (fraction of rows with a real price)
      + 0.20 * demandScore        (real clicks if any, else a flat 0.15 floor + optional heuristic bump)
      + 0.15 * freshnessScore     (1.0 within 30 days, 0.6 within 90, else 0.3)
```

Implemented in `backend/src/services/seoEngine.js`'s `scoreOpportunity()` —
kept as a single function so the weights, or the demand signal itself, can
be tuned or swapped for real search-volume data later without touching any
of the page-generation code.

### Tiers

| Tier | Threshold | Meaning |
|---|---|---|
| Tier 1 | score ≥ 0.55 | Strong on every axis — real inventory, multi-source pricing, near-term dates. Gets sitemap priority 0.8. |
| Tier 2 | score ≥ 0.35 | Solid, real inventory with some diversity/commercial signal. Priority 0.6. |
| Tier 3 | score ≥ 0.18 | Long-tail but still genuinely backed by real inventory. Priority 0.4. |
| Do Not Index | score < 0.18 | Filtered out before a page is ever generated — never reaches a route, never reaches the sitemap. |

The specific weights and thresholds are a reasonable starting point, not a
claimed-optimal formula — they're isolated in one place specifically so
they can be revised once real ranking/traffic data comes back from these
pages.

## Page types generated

All server-rendered (Express, not the React SPA) at the domain root, mirroring the existing `/guide` pattern:

- `/artists` (index) and `/artists/:slug` — one page per artist with ≥1 real upcoming event, grouped across sources.
- `/cities` (index) and `/cities/:slug/events|concerts|sports` — three intent variants per city, each independently gated on having real matching inventory (a city with concerts but no sports listings only gets `/events` and `/concerts`, not a hollow `/sports` page).
- `/venues` (index) and `/venues/:slug`.
- `/leagues` (index) and `/leagues/:slug` — 6 fixed top-level categories (nfl, concerts, nba, ncaa-football, theater, comedy) reusing the exact same category/keyword rules as the homepage's own category filter, so these always match what a visitor sees when they filter the homepage.
- `/teams` (index) and `/teams/:slug` — best-effort, extracted by parsing matchup titles ("Team A at Team B"); explicitly flagged `heuristic: true` and only generated when the same team name recurs across ≥2 real event rows (filters out one-off title-parsing noise). Disclosed on-page as extracted from listings and "may occasionally be imprecise."

Deliberately **not** built: a full cross-product of every possible
combination (e.g. every artist × every city × every date). Only
combinations with real, currently-queryable inventory behind them exist —
there is no static list of "possible" pages to generate from, only live
query results.

## Titles, meta descriptions, structure

Every page's `<title>`, meta description, and JSON-LD (`CollectionPage`
schema) are built from the actual query result for that specific page —
event count, cheapest real price across sellers, city/venue names — never
a template with only one token swapped. A page with no comparable price
(no `min_price` data yet) gets a description that says so instead of a
fabricated price. `<h2>` sections (e.g. "Cities on this tour" on an artist
page) only render when there's real data to put in them.

## Freshness & correctness

Nothing here is precomputed or cached — every page queries the live
`events` table on each request via the same `mergeEventsAcrossSources()`
used by the homepage, so a page always reflects current inventory. If the
underlying inventory disappears between when an index page linked to a
detail page and when a visitor (or Googlebot) actually requests it, the
detail route 404s with a clean, `noindex`-tagged not-found page rather than
rendering an empty shell — the same pattern already used by `/guide/:slug`.

## Real search-completion data (added 2026-09-08)

The system now includes one more genuinely real signal: actual Google
Autocomplete completions for a sample of this platform's top inventory
entities, stored in `backend/data/search-patterns.json`.

**What this is, precisely.** Google's autocomplete suggest endpoint returns
real completions based on aggregate searcher behavior — e.g. querying
"Hamilton tickets" returns things like `hamilton tickets broadway`,
`hamilton tickets okc`, `hamilton tickets san antonio`. Every phrase stored
is a verbatim string Google itself returned on the pull date. It carries no
volume number and no ranking by frequency — autocomplete order is Google's,
not a popularity score — so it is used only as a **confirmation signal**
("real searchers do phrase queries about this entity this way") and a
**content signal** (the literal phrases are shown to visitors under a "How
people search for this" heading on the relevant page, sourced verbatim, not
paraphrased or expanded).

**What this deliberately is not.** It is not AI-generated. An earlier
version of this conversation described a technique of having an AI "predict
text expansions" of seed topics into thousands of plausible-sounding search
phrases — that produces invented text with no real searcher behind it, no
matter how it's phrased. This system does not do that anywhere. Every
phrase in `search-patterns.json` came back from an actual HTTP call to
Google's suggest endpoint; nothing here was written by a language model.

**Coverage and cadence — read this before assuming it's comprehensive.**
This is a small, hand-pulled snapshot (18 entities as of the date above: the
6 fixed leagues, 6 of the current top real artists/shows, 3 top real teams,
3 top real cities), not a live or exhaustive system:

- It is **not** called from the production backend on page load. Google's
  suggest endpoint is undocumented and unofficial — there's no supported
  contract for repeated automated calls, and doing that from a production
  server risks rate-limiting or the IP being blocked, which would be a much
  worse outcome than simply not having this signal. So `search-patterns.json`
  is a static, checked-in file, and `seoEngine.js` only reads it.
- Refreshing it means running the same pulls again (one HTTP request per
  seed keyword) in a research session and replacing the file — there's no
  cron job or schedule for this. Ask for a refresh, or for it to be
  expanded to more entities, whenever it's useful; it isn't done
  automatically, and the file's own `pulledAt` field is the way to tell
  whether it's stale.
- An entity with no entry in the file isn't scored as "confirmed no
  interest" — `scoreOpportunity()` simply doesn't apply the bump, which is
  the honest default for "not yet checked," not "checked and found nothing."

## Known limitations (stated plainly, not glossed over)

- No real search-volume data. If GSC or Trends API access becomes
  available, wire it into `demandScore` in `scoreOpportunity()` — that's
  the one place designed to absorb it.
- Click-based demand signal is presently dominated by bot traffic (see
  table above) — until that's cleaned up, `demandScore` mostly runs on its
  heuristic floor, not real clicks.
- Team extraction is regex-based and best-effort; it can occasionally
  produce an imprecise or duplicate team name from an unusually formatted
  title. This is disclosed on every team page.
- Sitemap output is capped (`SITEMAP_URL_CAP * 3` entries) to stay well
  under the 50,000-URL sitemap protocol limit as the catalog grows.

## Reachability fix (prerequisite, shipped alongside this)

`frontend/vercel.json` previously had no proxy rewrite for any
server-rendered backend path — only a catch-all SPA rewrite. That meant
`/guide`, `/guide/:slug`, and `/sitemap.xml` were **never actually
reachable on the live domain** (confirmed by direct navigation before this
change — the URL silently fell back to the homepage SPA). Fixed by adding
explicit proxy rewrites for `/sitemap.xml`, `/guide(/:slug)`, and all new
`/artists`, `/cities`, `/venues`, `/leagues`, `/teams` paths, placed before
the catch-all rule (Vercel matches rewrites in array order).
