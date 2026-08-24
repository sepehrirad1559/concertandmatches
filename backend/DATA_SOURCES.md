# Data sources

ConcertAndMatches.com collects event and ticket data from exactly two places, both official, authenticated, documented REST APIs:

- **Ticketmaster Discovery API** (`app.ticketmaster.com/discovery/v2`) — `backend/src/services/ticketmaster.js`
- **SeatGeek Platform API** (`api.seatgeek.com/2`) — `backend/src/services/seatgeek.js`

Both require an API key issued by the provider and are called via their documented JSON endpoints (`axios.get`/`axios.post` against the base URLs above). Neither service fetches an HTML page and parses it — every request goes to a structured JSON API endpoint that exists specifically for programmatic access.

## Removed (2026-08-24)

The following were removed to keep the platform to official-API-only data collection:

- **Official-sites JSON-LD scraper** (`services/officialSites.js`, `services/officialSiteDiscovery.js`, `providers/OfficialSiteProvider.js`, the `official_sources` table, and the `/admin/schema/add-official-sources`, `/admin/official-sources`, `/admin/sync/official-sites`, `/admin/discover/artist-sites` routes, plus its daily scheduled job in `index.js`). This fetched arbitrary third-party festival/venue/artist pages with `axios.get` and regex-extracted `<script type="application/ld+json">` blocks from the raw HTML. Even though the *target* data was structured (schema.org JSON-LD), the *mechanism* was direct HTML fetching and parsing of external websites — exactly what this platform no longer does in any form.
- **StubHub integration skeleton** (`services/stubhub.js`, `providers/StubHubProvider.js`). This one actually targeted StubHub's real OAuth "Application-Only" API, not scraping — but it was explicitly documented as an unverified skeleton (placeholder endpoint URLs, field names not confirmed against a real account, no partner access ever obtained) and was never wired into any sync job or admin route. Removed for the same reason: an unconfirmed/unofficial integration has no place next to the two working official-API sources, and it wasn't doing anything in production anyway.

Historical rows these left behind (`events.source = 'official'`) are inert leftover data, not being refreshed by anything. Run `POST /admin/cleanup/official-source-data` once (with the `x-sync-key` header) to delete them and drop the `official_sources` table, then `POST /admin/canonicalize/rebuild` to refresh the derived tables.

## What was NOT touched

Nothing about *how* Ticketmaster/SeatGeek data is collected changed — both were already official-API-only. What changed is schema (see below) and the removal of the two mechanisms above.
