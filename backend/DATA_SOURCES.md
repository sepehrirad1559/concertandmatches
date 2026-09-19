# Data sources

ConcertAndMatches collects event and ticket data primarily from official, authenticated, documented REST APIs:

- **Ticketmaster Discovery API** (`app.ticketmaster.com/discovery/v2`) — `backend/src/services/ticketmaster.js`
- **SeatGeek Platform API** (`api.seatgeek.com/2`) — `backend/src/services/seatgeek.js`
- **TicketNetwork, via Impact.com's affiliate Partner API** (`api.impact.com`, Product Catalog id 1872) — `backend/src/services/ticketnetwork.js`. Not TicketNetwork's own API directly; their real, live, ~210k-item product catalog is exposed through Impact's documented affiliate catalog endpoint instead.

All three require credentials issued by the provider and are called via documented JSON endpoints. None of them fetches an HTML page and parses it — every request goes to a structured JSON API endpoint that exists specifically for programmatic access.

## Manually curated (not an API sync)

- **The Rockefeller Center** — `backend/src/services/curatedAttractions.js`. Joined via Impact.com (2026-09) alongside Pelago by Singapore Airlines. Investigated for a product-catalog-style feed the same way TicketNetwork's was (Impact.com's "Assets" tab, "Tracking Integration", and the "Has Product Catalog" brand-attribute filter) — none exists for this brand; it's a plain 10%-on-sale affiliate program, not a catalog-backed one. Its small, stable set of attractions (Top of the Rock, The Beam, SKYLIFT, guided tours, The Rink) is instead hand-entered as `events.source = 'curated'` rows, with prices read directly off rockefellercenter.com's own pricing page. These need periodic manual re-checking — nothing re-fetches the prices automatically, only the `date` column (re-stamped daily so the rows don't fall out of the `date >= NOW()` listing filter).
- **Pelago by Singapore Airlines** — deliberately NOT added as individual event rows. Same investigation came back the same way (no catalog feed), but Pelago's real inventory (thousands of tours/activities across many cities, changing constantly) can't be responsibly hand-maintained the way Rockefeller Center's handful of attractions can. It's surfaced instead as a single outbound promo card (`PartnerPromoBanner` in `frontend/src/App.jsx`) linking to Pelago's own site via its tracked affiliate link — not represented as platform inventory.
- **Hellotickets** and **Ticketclub** — approved on Impact.com 2026-09-19, deliberately NOT added as individual event rows, same reasoning as Pelago. Checked via a new read-only diagnostic (`GET /admin/diagnostics/impact-catalogs`, which lists every product catalog visible to this account — 17 total as of this check) rather than hand-inspecting each brand's Assets tab one at a time: neither Hellotickets nor Ticketclub has a catalog entry (only TicketNetwork, Vegas.com, and a handful of unrelated Shopify stores do). Both have large, constantly-changing ticket marketplace inventories, not a small stable set — so both get an outbound promo card in the same `PARTNER_PROMOS` list `PartnerPromoBanner` renders, linking to their own sites via tracked affiliate links (Hellotickets: `https://hellotickets.sjv.io/B59D91`, Ticketclub: `https://ticketclub.pxf.io/E0P5PP`).

## Removed (2026-08-24)

The following were removed to keep the platform to official-API-only data collection:

- **Official-sites JSON-LD scraper** (`services/officialSites.js`, `services/officialSiteDiscovery.js`, `providers/OfficialSiteProvider.js`, the `official_sources` table, and the `/admin/schema/add-official-sources`, `/admin/official-sources`, `/admin/sync/official-sites`, `/admin/discover/artist-sites` routes, plus its daily scheduled job in `index.js`). This fetched arbitrary third-party festival/venue/artist pages with `axios.get` and regex-extracted `<script type="application/ld+json">` blocks from the raw HTML. Even though the *target* data was structured (schema.org JSON-LD), the *mechanism* was direct HTML fetching and parsing of external websites — exactly what this platform no longer does in any form.
- **StubHub integration skeleton** (`services/stubhub.js`, `providers/StubHubProvider.js`). This one actually targeted StubHub's real OAuth "Application-Only" API, not scraping — but it was explicitly documented as an unverified skeleton (placeholder endpoint URLs, field names not confirmed against a real account, no partner access ever obtained) and was never wired into any sync job or admin route. Removed for the same reason: an unconfirmed/unofficial integration has no place next to the two working official-API sources, and it wasn't doing anything in production anyway.

Historical rows these left behind (`events.source = 'official'`) are inert leftover data, not being refreshed by anything. Run `POST /admin/cleanup/official-source-data` once (with the `x-sync-key` header) to delete them and drop the `official_sources` table, then `POST /admin/canonicalize/rebuild` to refresh the derived tables.

## What was NOT touched

Nothing about *how* Ticketmaster/SeatGeek data is collected changed — both were already official-API-only. What changed is schema (see below) and the removal of the two mechanisms above.
