import axios from 'axios';
import { pool } from '../index.js';

// Automatically discovers official artist/performer websites and feeds them
// into official_sources, so the JSON-LD scraper (services/officialSites.js)
// gets new candidates on its own instead of relying on someone hand-picking
// URLs. This closes the loop the user asked for: "find these websites
// automatically and continuously" rather than one-off manual curl calls.
//
// Source of discovery: Ticketmaster's own Attractions API, which we already
// have an authorized key for (same TICKETMASTER_API_KEY used for event
// sync). Ticketmaster attraction records include `externalLinks.homepage`
// — the artist's own official site, as Ticketmaster itself has recorded
// it — which is exactly the kind of authorized-source data point this
// platform is built around. This avoids needing a separate search API key
// and avoids guessing/hallucinating URLs.

const TICKETMASTER_API_KEY = process.env.TICKETMASTER_API_KEY;
const TICKETMASTER_BASE_URL = 'https://app.ticketmaster.com/discovery/v2';

// Domains that technically appear in `externalLinks.homepage` sometimes but
// aren't what we mean by "official site" for JSON-LD scraping purposes —
// social platforms, other ticket marketplaces, wikis, streaming profiles.
const NON_OFFICIAL_DOMAIN_RE = /facebook\.com|instagram\.com|twitter\.com|x\.com|tiktok\.com|youtube\.com|spotify\.com|wikipedia\.org|bandsintown\.com|songkick\.com|ticketmaster\.com|seatgeek\.com|stubhub\.com|vividseats\.com|viagogo\.com/i;

function isPlausibleOfficialUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (!/^https?:\/\//i.test(url)) return false;
  return !NON_OFFICIAL_DOMAIN_RE.test(url);
}

async function findAttractionHomepage(artistName) {
  const { data } = await axios.get(`${TICKETMASTER_BASE_URL}/attractions.json`, {
    params: { apikey: TICKETMASTER_API_KEY, keyword: artistName, size: 1 },
    timeout: 10000,
  });
  const attraction = data?._embedded?.attractions?.[0];
  const homepage = attraction?.externalLinks?.homepage?.[0]?.url;
  return isPlausibleOfficialUrl(homepage) ? homepage : null;
}

// Looks at artists already in our own events table (populated by the
// Ticketmaster/SeatGeek syncs) that don't yet have an official_sources row,
// looks each one up via Ticketmaster's Attractions API, and adds any
// official homepage it finds. Runs a bounded batch per call so it can be
// scheduled repeatedly without ever doing a huge burst against
// Ticketmaster's rate limits.
export async function discoverArtistOfficialSites(batchSize = 15) {
  if (!TICKETMASTER_API_KEY) {
    return { success: false, error: 'TICKETMASTER_API_KEY not configured' };
  }

  const { rows: candidates } = await pool.query(
    `SELECT DISTINCT e.artist_name
     FROM events e
     WHERE e.artist_name IS NOT NULL AND e.artist_name <> ''
       AND NOT EXISTS (
         SELECT 1 FROM official_sources os WHERE os.label = e.artist_name
       )
     ORDER BY e.artist_name
     LIMIT $1`,
    [batchSize]
  );

  const discovered = [];
  const skipped = [];

  for (const { artist_name } of candidates) {
    try {
      const homepage = await findAttractionHomepage(artist_name);
      if (!homepage) {
        skipped.push({ artist: artist_name, reason: 'no plausible homepage found' });
      } else {
        const existing = await pool.query('SELECT id FROM official_sources WHERE url = $1', [homepage]);
        if (existing.rows.length > 0) {
          skipped.push({ artist: artist_name, reason: 'url already tracked' });
        } else {
          await pool.query(
            `INSERT INTO official_sources (url, label, category, active) VALUES ($1, $2, 'Artist', true)`,
            [homepage, artist_name]
          );
          discovered.push({ artist: artist_name, url: homepage });
        }
      }
    } catch (error) {
      skipped.push({ artist: artist_name, reason: error.message });
    }
    // Ticketmaster's free-tier rate limit is 5 requests/sec — stay well
    // under it since this can run unattended and shouldn't risk tripping
    // the same key the event sync depends on.
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  return {
    success: true,
    candidatesChecked: candidates.length,
    discovered: discovered.length,
    sites: discovered,
    skipped,
  };
}

export default { discoverArtistOfficialSites };
