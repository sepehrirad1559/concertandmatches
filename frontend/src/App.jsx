// build-refresh marker 2
import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import AdminPage from './AdminPage.jsx';
import './App.css';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:30001/api';

// The backend's non-/api redirect/tracking endpoint lives at the same
// origin as the API, just without the /api suffix (see backend/src/index.js
// — app.use('/go', redirectRoutes) is mounted at the app root).
const GO_BASE = API_URL.replace(/\/api\/?$/, '');

// Slug used in the shareable per-event URL (/event/:id-:slug) — cosmetic
// only. The leading numeric id (see buildEventPath) is what's actually
// looked up; the slug just makes the URL readable and keyword-relevant.
// Mirrors backend/src/routes/sitemap.js's slugify so sitemap URLs and
// in-app-generated URLs agree (not that it matters for lookups, but it
// avoids a confusing mismatch if anyone compares them).
function slugify(text) {
  return (text || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'event';
}

function buildEventPath(event) {
  const slug = slugify(`${event.title || event.artist_name || 'event'}-${event.city || ''}`);
  return `/event/${event.id}-${slug}`;
}

// Pulls the numeric event id back out of a /event/:id-:slug URL. Only the
// leading digits matter — the rest is decorative.
function parseEventIdFromPath(pathname) {
  const match = /^\/event\/(\d+)/.exec(pathname || '');
  return match ? match[1] : null;
}

// Anonymous per-browser-session id for click analytics — not tied to any
// account, just lets the backend tell "3 clicks from one visitor" apart
// from "3 clicks from 3 visitors". Regenerates each tab session; nothing
// personally identifying is collected (see routes/clicks.js).
const CLICK_SESSION_ID = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

// Fire-and-forget click logging. Deliberately never blocks or interferes
// with the outbound link it's attached to — no preventDefault, no await
// before navigation, and any failure here (network hiccup, ad blocker) is
// swallowed rather than surfaced, because a ticket purchase must never be
// blocked by an analytics call failing.
function logTicketClick(offer, event) {
  try {
    const payload = JSON.stringify({
      eventRowId: offer?.event_row_id ?? null,
      source: offer?.source ?? null,
      title: event?.title ?? null,
      city: event?.city ?? null,
      state: event?.state ?? null,
      landingPage: typeof window !== 'undefined' ? window.location.pathname : null,
      sessionId: CLICK_SESSION_ID,
    });
    const url = `${API_URL}/clicks`;
    if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
      navigator.sendBeacon(url, new Blob([payload], { type: 'application/json' }));
    } else {
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: true }).catch(() => {});
    }
  } catch (_err) {
    // Analytics must never break the actual "take me to the seller" click.
  }
}

// ---- Lightweight, anonymous per-browser personalization signal, used by
// the "Recommended for You" discovery section (there's no login/account
// system on this site, so this — plus location and overall popularity — is
// the only "user information/preference" available for a returning
// visitor). Every time a visitor clicks through to a seller for an event,
// we bump a tally of that event's category in localStorage; the two
// categories with the highest tally are sent to GET /events/discover as a
// small ranking boost. Never blocks anything and is skipped entirely if
// localStorage is unavailable (private browsing, storage disabled, etc).
const CATEGORY_INTEREST_KEY = 'cm_category_interest';

function bumpCategoryInterest(category) {
  if (!category) return;
  try {
    const raw = window.localStorage.getItem(CATEGORY_INTEREST_KEY);
    const tally = raw ? JSON.parse(raw) : {};
    tally[category] = (tally[category] || 0) + 1;
    window.localStorage.setItem(CATEGORY_INTEREST_KEY, JSON.stringify(tally));
  } catch (_err) {
    // Personalization is a nice-to-have, never worth breaking a real click over.
  }
}

function getPreferredCategories(max = 2) {
  try {
    const raw = window.localStorage.getItem(CATEGORY_INTEREST_KEY);
    if (!raw) return [];
    const tally = JSON.parse(raw);
    return Object.entries(tally)
      .sort((a, b) => b[1] - a[1])
      .slice(0, max)
      .map(([category]) => category);
  } catch (_err) {
    return [];
  }
}

// ---- Visitor location, resolved for the discovery sections below (Popular/
// Recommended/Trending/by-category). Two sources, tried in this order:
//  1. A ZIP code the visitor typed in (see the homepage's ZIP input) —
//     looked up via zippopotam.us (free, no API key, CORS-enabled), which
//     returns the ZIP's place name and coordinates directly — exactly the
//     "identify the nearest city associated with that ZIP code" the spec
//     asks for, with no separate reverse-geocoding step needed.
//  2. Browser geolocation (already used elsewhere on this page for
//     nearest-first sorting) — reverse-geocoded to a city name via
//     bigdatacloud's free, keyless, CORS-enabled reverse-geocode API, since
//     geolocation alone gives coordinates but not a city name to put in the
//     "Trending Events Near {city}" heading.
// Cached in localStorage so a returning visitor doesn't need to re-enter
// their ZIP or re-prompt for geolocation every visit.
const LOCATION_CACHE_KEY = 'cm_location';

function loadCachedLocation() {
  try {
    const raw = window.localStorage.getItem(LOCATION_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_err) {
    return null;
  }
}

function saveCachedLocation(loc) {
  try {
    window.localStorage.setItem(LOCATION_CACHE_KEY, JSON.stringify(loc));
  } catch (_err) {
    // Non-fatal — the location just won't persist across visits.
  }
}

async function resolveZipLocation(zip) {
  const response = await fetch(`https://api.zippopotam.us/us/${encodeURIComponent(zip)}`);
  if (!response.ok) throw new Error('ZIP code not found');
  const data = await response.json();
  const place = data.places && data.places[0];
  if (!place) throw new Error('ZIP code not found');
  return {
    city: place['place name'],
    state: place['state abbreviation'],
    lat: parseFloat(place.latitude),
    lng: parseFloat(place.longitude),
    source: 'zip',
    zip,
  };
}

async function reverseGeocodeCity(lat, lng) {
  const response = await fetch(
    `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=en`
  );
  if (!response.ok) throw new Error('Reverse geocode failed');
  const data = await response.json();
  const city = data.city || data.locality || null;
  if (!city) throw new Error('Reverse geocode returned no city');
  return { city, state: data.principalSubdivisionCode ? data.principalSubdivisionCode.split('-').pop() : null, lat, lng, source: 'geolocation' };
}

function formatDate(dateStr) {
  if (!dateStr) return 'Date TBA';
  try {
    const d = new Date(dateStr);
    const datePart = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    // Some providers only give us a bare date with no real time-of-day, which
    // lands on local midnight — showing "12:00 AM" for those would be
    // misleading, so only append a time when one was actually reported.
    if (d.getHours() === 0 && d.getMinutes() === 0) return datePart;
    const timePart = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    return `${datePart} • ${timePart}`;
  } catch {
    return dateStr;
  }
}

function formatDistance(distanceKm) {
  if (distanceKm == null) return null;
  const miles = distanceKm * 0.621371;
  if (miles < 1) return 'Less than 1 mi away';
  return `${miles.toFixed(0)} mi away`;
}

// Returns every ticket price tier we know about for an event, sorted low to
// high. Ticketmaster sometimes reports several tiers (e.g. Standard vs. VIP)
// in `price_breakdown`; when that's not available we fall back to the single
// min/max range already stored on the event. Returns [] if no pricing at all
// is known (e.g. "Price TBA" events).
function getTicketPriceTiers(event) {
  let tiers = [];
  if (event.price_breakdown) {
    try {
      const parsed = typeof event.price_breakdown === 'string'
        ? JSON.parse(event.price_breakdown)
        : event.price_breakdown;
      if (Array.isArray(parsed)) tiers = parsed;
    } catch {
      tiers = [];
    }
  }
  if (tiers.length === 0 && (event.min_price != null || event.max_price != null)) {
    tiers = [{ type: 'Price', min: event.min_price, max: event.max_price }];
  }
  return tiers
    .filter((t) => t.min != null || t.max != null)
    .map((t) => ({
      // Ticketmaster's own priceRanges entries default to type "Standard"
      // when Ticketmaster itself doesn't name the tier (see storeEvent in
      // services/ticketmaster.js) — that's not a real tier name, just a
      // placeholder, so treat it the same as "no tier name at all" and show
      // the generic "Price" label (which then becomes "Price range" below
      // when there are two distinct values). A genuinely named tier (e.g.
      // "VIP") keeps its own name.
      label: (t.type && t.type !== 'Standard') ? t.type : 'Price',
      min: t.min != null ? Number(t.min) : null,
      max: t.max != null ? Number(t.max) : null,
    }))
    .sort((a, b) => {
      const aMin = a.min != null ? a.min : a.max;
      const bMin = b.min != null ? b.min : b.max;
      return aMin - bMin;
    });
}

// Compact "Ticketmaster from $45 · SeatGeek from $52" line for the event
// card grid, cheapest first — the at-a-glance comparison. Returns null
// when there's nothing to compare (a single offer, or no priced offers).
const OFFER_SOURCE_NAMES = { ticketmaster: 'Ticketmaster', seatgeek: 'SeatGeek' };

function formatOffersComparison(event) {
  const offers = Array.isArray(event.offers) ? event.offers : [];
  if (offers.length < 2) return null;
  const parts = offers
    .filter((o) => o.min_price != null)
    .sort((a, b) => Number(a.min_price) - Number(b.min_price))
    .map((o) => `${OFFER_SOURCE_NAMES[o.source] || o.source} from $${Number(o.min_price).toFixed(0)}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

function formatPrice(event) {
  if (event.min_price == null && event.max_price == null) return 'Price TBA';
  if (event.min_price != null && event.max_price != null && event.min_price !== event.max_price) {
    return `$${Number(event.min_price).toFixed(0)} - $${Number(event.max_price).toFixed(0)}`;
  }
  const p = event.min_price != null ? event.min_price : event.max_price;
  return `$${Number(p).toFixed(0)}`;
}

// Impact.com tracked deep-link base for the approved Ticketmaster affiliate
// program (account-specific campaign/media-partner/ad IDs). Wrapping any
// ticketmaster.com URL in this base means clicks are tracked and referred
// sales earn commission. Format: <base>?u=<url-encoded destination>.
const TICKETMASTER_TRACKED_BASE = 'https://ticketmaster.evyy.net/c/7649497/264167/4272';

function trackedTicketmasterLink(destinationUrl) {
  return `${TICKETMASTER_TRACKED_BASE}?u=${encodeURIComponent(destinationUrl)}`;
}

// Ticketmaster is a live, tracked affiliate link (program approved). SeatGeek
// is still a plain (non-tracked) link — its affiliate application is
// pending. Swap it in for its network's tracked deep link once approved.
//
// We only ever know an event was actually found on the seller(s) it came
// from — that's literally how it got into our database — so we only ever
// show links for sellers we can confirm actually have this event, never a
// blind keyword search to a seller we don't know is listing it (and
// StubHub has no integration at all, so it never appears here).
//
// When the same real-world event was found on more than one seller (see
// the backend's cross-source merge), `event.offers` has one entry per
// seller and this returns one link per offer — the actual price-comparison
// list. Falls back to the older single-source shape (event.source /
// event.source_url) if `offers` isn't present, so this keeps working
// against any cached/older API response shape.
function buildFindTicketsLinks(event) {
  const q = encodeURIComponent(event.title || event.artist_name || '');
  const sourceMeta = {
    ticketmaster: {
      name: 'Ticketmaster',
      buildUrl: (url) => trackedTicketmasterLink(url || `https://www.ticketmaster.com/search?q=${q}`),
    },
    seatgeek: {
      name: 'SeatGeek',
      buildUrl: (url) => url || `https://seatgeek.com/search?search=${q}`,
    },
    // TicketNetwork, via the (already-approved) Impact.com affiliate
    // catalog — see backend/src/services/ticketnetwork.js. Unlike
    // Ticketmaster, the stored source_url IS ALREADY the full Impact.com
    // tracked affiliate link (goto.ticketnetwork.com/...), so this needs no
    // extra wrapping, same as SeatGeek's link above.
    ticketnetwork: {
      name: 'TicketNetwork',
      buildUrl: (url) => url || `https://www.ticketnetwork.com/tickets/search?q=${q}`,
    },
    // Official festival/venue/artist/band sites (see services/officialSites.js
    // on the backend) — these are NOT a seller and have no affiliate
    // relationship, so this deliberately never wraps the URL in a tracked
    // link, never claims a price/BEST PRICE badge (min/maxPrice are forced
    // null below regardless of what the scraper found, since a JSON-LD
    // price here is often a festival pass rather than a directly comparable
    // per-ticket price), and never routes through /go (that redirect's
    // domain whitelist is intentionally limited to known ticket sellers).
    // It's purely "here's the event's own official page" for the visitor.
    official: {
      name: 'Official Site',
      buildUrl: (url) => url || null,
    },
  };

  const offers = Array.isArray(event.offers) && event.offers.length > 0
    ? event.offers
    : (event.source ? [{ source: event.source, source_url: event.source_url, min_price: event.min_price, max_price: event.max_price }] : []);

  const confirmedLinks = offers
    .filter((o) => sourceMeta[o.source])
    .map((o) => ({
      source: o.source,
      name: sourceMeta[o.source].name,
      url: sourceMeta[o.source].buildUrl(o.source_url),
      minPrice: o.source === 'official' ? null : o.min_price,
      maxPrice: o.source === 'official' ? null : o.max_price,
      isBest: event.best_source ? o.source === event.best_source : false,
      // Official links never route through the /go affiliate redirect — see
      // the comment above — so they always use their own url directly.
      eventRowId: o.source === 'official' ? null : (o.event_row_id ?? null),
    }))
    .filter((link) => link.url)
    // Cheapest first when we know prices, so the best deal is the first
    // thing shown rather than something you have to scan for. Unpriced
    // offers (including official-site links, which are never priced here)
    // sort after every priced seller offer.
    .sort((a, b) => {
      if (a.minPrice != null && b.minPrice != null) return a.minPrice - b.minPrice;
      if (a.minPrice != null) return -1;
      if (b.minPrice != null) return 1;
      return 0;
    });

  // TicketNetwork used to get a button on every event — a blind search link
  // to ticketnetwork.com, since we have no TicketNetwork inventory data
  // (that requires their separate Mercury Web Services API, which we don't
  // have credentials for yet) to confirm an event is actually listed there.
  // That meant visitors could click "Buy on TicketNetwork" for an event
  // TicketNetwork doesn't even sell, only to land on a search with no
  // results. Per product decision, TicketNetwork is removed until we have
  // real inventory data (see docs/ticketnetwork-mws-application-draft.md) —
  // same "confirmed listings only" rule as every other seller above.
  return confirmedLinks;
}

// Shown wherever outbound ticket links appear. Required by the FTC whenever
// a page contains (or may soon contain) affiliate links.
function AffiliateDisclosure() {
  return (
    <p style={{ fontSize: '12px', color: '#888', marginTop: '16px' }}>
      Disclosure: ConcertAndMatches is an independent event discovery site. We don't sell tickets
      ourselves — links above take you to the seller's site to complete your purchase, and we may
      earn a commission on qualifying purchases at no extra cost to you.
    </p>
  );
}

// Quick category filters shown between the search bar and the events list.
// `category` values are matched against the events.category column (OR'd,
// comma-joined); `keywords` are matched against title/artist/venue text
// (also OR'd) for leagues/genres that aren't their own category in the data.
// Both are ANDed with whatever the customer types in the main search box.
// Tile styling deliberately mirrors what the big ticket marketplaces do for
// their own category/genre filter chips (StubHub's "All types / Sports /
// Concerts / Theater & Comedy" pills, SeatGeek's "Location / Date" pills,
// etc.): a flat white tile with a thin colored border, not a bold colored
// gradient fill. The accent color is still per-category (so the row stays
// visually scannable) but only shows up as the border/icon/active-fill
// color now, matching that flatter, whiter competitor look.
const EVENT_CATEGORIES = [
  {
    id: 'nfl',
    label: 'NFL',
    emoji: '🏈',
    keywords: ['NFL'],
    accent: '#013369',
  },
  {
    id: 'concerts',
    label: 'Concerts',
    emoji: '🎤',
    category: ['Music', 'Concert'],
    accent: '#8e2de2',
  },
  {
    id: 'nba',
    label: 'NBA',
    emoji: '🏀',
    keywords: ['NBA', 'Basketball'],
    accent: '#1d428a',
  },
  {
    id: 'ncaaf',
    label: 'NCAA Football',
    emoji: '🎓',
    keywords: ['NCAA Football', 'College Football', 'NCAA'],
    accent: '#002d62',
  },
  {
    id: 'theater',
    label: 'Theater',
    emoji: '🎭',
    category: ['Arts & Theatre'],
    accent: '#6a0dad',
  },
  {
    id: 'comedy',
    label: 'Comedy',
    emoji: '😂',
    keywords: ['Comedy', 'Stand-Up', 'Stand Up'],
    accent: '#c9660b',
  },
];

function CategoryTiles({ activeCategoryId, onSelect }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))',
        gap: '12px',
        marginBottom: '20px',
      }}>
      <button
        type="button"
        className="cm-tile"
        onClick={() => {
          onSelect(null);
          document.getElementById('featured-events')?.scrollIntoView({ behavior: 'smooth' });
        }}
        style={{
          background: activeCategoryId === null ? '#1a0733' : '#fff',
          border: activeCategoryId === null ? '2px solid #1a0733' : '1px solid var(--cm-border)',
          borderRadius: '16px',
          padding: '18px 8px',
          color: activeCategoryId === null ? '#fff' : '#222',
          cursor: 'pointer',
          textAlign: 'center',
          boxShadow: activeCategoryId === null ? 'var(--cm-shadow-md)' : 'var(--cm-shadow-sm)',
        }}>
        <div style={{ fontSize: '32px', marginBottom: '8px' }}>🎟️</div>
        <div style={{ fontWeight: 'bold', fontSize: '18px' }}>All</div>
      </button>
      {EVENT_CATEGORIES.map((cat) => {
        const isActive = activeCategoryId === cat.id;
        return (
          <button
            key={cat.id}
            type="button"
            className="cm-tile"
            onClick={() => {
              onSelect(isActive ? null : cat.id);
              document.getElementById('featured-events')?.scrollIntoView({ behavior: 'smooth' });
            }}
            style={{
              background: isActive ? cat.accent : '#fff',
              border: isActive ? `2px solid ${cat.accent}` : '1px solid var(--cm-border)',
              borderRadius: '16px',
              padding: '18px 8px',
              color: isActive ? '#fff' : '#222',
              cursor: 'pointer',
              textAlign: 'center',
              boxShadow: isActive ? 'var(--cm-shadow-md)' : 'var(--cm-shadow-sm)',
            }}>
            <div style={{ fontSize: '32px', marginBottom: '8px' }}>{cat.emoji}</div>
            <div style={{ fontWeight: 'bold', fontSize: '18px' }}>{cat.label}</div>
          </button>
        );
      })}
    </div>
  );
}

// A single event card — extracted from the main "Featured Events" grid so
// the event-discovery sections below (Popular/Recommended/Trending/by-
// category) can share the exact same card instead of duplicating this
// markup seven more times.
function EventCard({ event, onSelect }) {
  const priceLabel = (event.min_price != null || event.max_price != null) ? formatPrice(event) : null;
  const fromPrice = event.min_price != null ? event.min_price : event.max_price;
  return (
    <div
      className="cm-card"
      onClick={() => onSelect(event)}
      style={{
        border: '1px solid var(--cm-border)',
        borderRadius: 'var(--cm-radius)',
        overflow: 'hidden',
        cursor: 'pointer',
        backgroundColor: '#fff',
        boxShadow: 'var(--cm-shadow-sm)',
      }}>
      <div style={{ position: 'relative' }}>
        {event.image_url && (
          <img
            src={event.image_url}
            alt={event.title}
            loading="lazy"
            decoding="async"
            style={{ width: '100%', height: '150px', objectFit: 'cover', display: 'block' }}
          />
        )}
        {priceLabel && (
          <span style={{
            position: 'absolute',
            top: '10px',
            right: '10px',
            backgroundColor: 'rgba(26,7,51,0.82)',
            color: 'white',
            fontSize: '11px',
            fontWeight: 'bold',
            letterSpacing: '0.02em',
            padding: '5px 10px',
            borderRadius: '999px',
            backdropFilter: 'blur(2px)',
          }}>
            FROM ${Number(fromPrice).toFixed(0)}
          </span>
        )}
        {formatDistance(event.distance_km) && (
          <span style={{
            position: 'absolute',
            top: '10px',
            left: '10px',
            backgroundColor: 'rgba(76,175,80,0.92)',
            color: 'white',
            fontSize: '11px',
            fontWeight: 'bold',
            padding: '5px 10px',
            borderRadius: '999px',
          }}>
            🚗 {formatDistance(event.distance_km)}
          </span>
        )}
      </div>
      <div style={{ padding: '14px 16px 16px' }}>
        <h4 style={{ fontSize: '16px', lineHeight: 1.3, marginBottom: '6px' }}>{event.title}</h4>
        <p style={{ fontSize: '13px', color: '#666', margin: '2px 0' }}>📅 {formatDate(event.date)}</p>
        <p style={{ fontSize: '13px', color: '#666', margin: '2px 0' }}>📍 {event.city}{event.state ? `, ${event.state}` : ''}</p>
        {formatOffersComparison(event) && (
          <p style={{ fontSize: '12px', color: '#666', margin: '2px 0 10px' }}>
            {formatOffersComparison(event)}
          </p>
        )}
        <button
          className="cm-btn"
          onClick={(e) => { e.stopPropagation(); onSelect(event); }}
          style={{
            marginTop: '12px',
            padding: '10px 16px',
            cursor: 'pointer',
            width: '100%',
            display: 'block',
            border: 'none',
            backgroundColor: '#8b0000',
            color: 'white',
            fontWeight: 'bold',
            borderRadius: '10px',
            letterSpacing: '0.01em',
          }}>
          Find Tickets
        </button>
      </div>
    </div>
  );
}

// One event-discovery row (Popular Events / Recommended for You / Trending
// Events Near {city} / Concerts / Sports / Theater / Comedy) — a heading
// plus up to 5 EventCards in the same responsive grid the main listing
// uses. Renders nothing while loading or once it's clear the platform has
// no events at all for this section, rather than showing an empty heading.
// Every discover section (Popular/Recommended/Trending/by-category) pages
// its own events client-side, PAGE_SIZE at a time, capped at MAX_PAGES —
// replaces the old "View all {title} →" link with a "‹ 1 of 7 ›" control so
// a visitor can browse each row in place instead of jumping down to the
// Featured Events grid. Featured Events itself is unaffected — it keeps its
// own "Load More" pagination further down the page.
const DISCOVER_PAGE_SIZE = 5;
const DISCOVER_MAX_PAGES = 7;

function EventSection({ title, events, loading, onSelect }) {
  const [page, setPage] = useState(0);
  // Reset to page 1 whenever this section gets a fresh events array (e.g.
  // the discover fetch re-ran for a new location) so a stale page index
  // from the previous data set can't leave the row showing nothing.
  useEffect(() => {
    setPage(0);
  }, [events]);

  if (!loading && (!events || events.length === 0)) return null;

  const totalPages = events && events.length > 0
    ? Math.min(DISCOVER_MAX_PAGES, Math.ceil(events.length / DISCOVER_PAGE_SIZE))
    : 1;
  const clampedPage = Math.min(page, totalPages - 1);
  const pageEvents = events
    ? events.slice(clampedPage * DISCOVER_PAGE_SIZE, clampedPage * DISCOVER_PAGE_SIZE + DISCOVER_PAGE_SIZE)
    : [];
  const atFirstPage = clampedPage === 0;
  const atLastPage = clampedPage === totalPages - 1;

  return (
    <div style={{ marginBottom: '32px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' }}>
        <h3 style={{ margin: 0, fontSize: '24px', fontWeight: 800, letterSpacing: '-0.01em' }}>{title}</h3>
        {!loading && totalPages > 1 && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '6px 8px',
            borderRadius: '999px',
            border: '1px solid var(--cm-border)',
            backgroundColor: '#fff',
            boxShadow: 'var(--cm-shadow-sm)',
          }}>
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={atFirstPage}
              aria-label={`Previous page of ${title}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '26px',
                height: '26px',
                borderRadius: '50%',
                border: 'none',
                backgroundColor: 'transparent',
                cursor: atFirstPage ? 'default' : 'pointer',
                color: atFirstPage ? '#ccc' : '#1a0733',
                fontSize: '15px',
                fontWeight: 'bold',
                lineHeight: 1,
              }}>
              ‹
            </button>
            <span style={{ fontSize: '13px', color: '#666', fontWeight: 'bold', minWidth: '54px', textAlign: 'center' }}>
              {clampedPage + 1} of {totalPages}
            </span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={atLastPage}
              aria-label={`Next page of ${title}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '26px',
                height: '26px',
                borderRadius: '50%',
                border: 'none',
                backgroundColor: 'transparent',
                cursor: atLastPage ? 'default' : 'pointer',
                color: atLastPage ? '#ccc' : '#1a0733',
                fontSize: '15px',
                fontWeight: 'bold',
                lineHeight: 1,
              }}>
              ›
            </button>
          </div>
        )}
      </div>
      {loading ? (
        <p style={{ color: '#666' }}>Loading…</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px' }}>
          {pageEvents.map((event) => (
            <EventCard key={`${event.id}-${event.source || ''}`} event={event} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  );
}

// Platform logo: a gradient ticket badge (reusing the same purple → pink →
// orange gradient family as the category tiles above, so it reads as part
// of the same brand) with a white ticket glyph — a perforated stub with a
// small star accent. Works for both concerts and sporting-event tickets,
// which is the whole point of the site.
function Logo({ size = 36 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id="cmLogoGrad" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
          <stop stopColor="#8e2de2" />
          <stop offset="0.55" stopColor="#e91e8c" />
          <stop offset="1" stopColor="#ff8c00" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="12" fill="url(#cmLogoGrad)" />
      <path
        d="M10 18a3 3 0 0 1 3-3h22a3 3 0 0 1 3 3v2a3 3 0 0 0 0 6v2a3 3 0 0 1-3 3H13a3 3 0 0 1-3-3v-2a3 3 0 0 0 0-6v-2z"
        fill="white"
      />
      <line x1="24" y1="16" x2="24" y2="32" stroke="#1a0733" strokeWidth="2" strokeDasharray="3 3" />
      <path d="M31 20.5l1.1 2.2 2.4.3-1.8 1.7.4 2.4-2.1-1.1-2.1 1.1.4-2.4-1.8-1.7 2.4-.3z" fill="#8e2de2" />
    </svg>
  );
}

// Logo + site name, clickable to return to the home page from anywhere.
function BrandLink({ onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="ConcertAndMatches.com — go to home page"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        background: 'none',
        border: 'none',
        padding: 0,
        margin: 0,
        cursor: 'pointer',
        font: 'inherit',
        color: 'inherit',
      }}>
      <Logo size={36} />
      <h2 style={{ margin: 0 }}>ConcertAndMatches.com</h2>
    </button>
  );
}

function Footer() {
  const linkStyle = { color: '#888', marginRight: '16px', textDecoration: 'none' };
  return (
    <footer style={{
      marginTop: '48px',
      padding: '24px 20px',
      borderTop: '1px solid var(--cm-border)',
      backgroundColor: '#fff',
      borderRadius: 'var(--cm-radius)',
      boxShadow: 'var(--cm-shadow-sm)',
      fontSize: '12px',
      color: '#888',
    }}>
      <p>ConcertAndMatches is an independent event discovery site and is not affiliated with any ticket seller. We may earn a commission when you buy tickets through links on this site.</p>
      <p style={{ marginTop: '10px' }}>
        <a href="/guide" className="cm-link-underline" style={linkStyle}>Ticket Price Guides</a>
        <a href="/artists" className="cm-link-underline" style={linkStyle}>Artists</a>
        <a href="/cities" className="cm-link-underline" style={linkStyle}>Cities</a>
        <a href="/venues" className="cm-link-underline" style={linkStyle}>Venues</a>
        <a href="/leagues" className="cm-link-underline" style={linkStyle}>Leagues</a>
        <a href="/teams" className="cm-link-underline" style={linkStyle}>Teams</a>
        <a href="/terms.html" className="cm-link-underline" style={linkStyle}>Terms of Service</a>
        <a href="/privacy.html" className="cm-link-underline" style={{ color: '#888', textDecoration: 'none' }}>Privacy Policy</a>
      </p>
    </footer>
  );
}

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const eventIdFromUrl = parseEventIdFromPath(location.pathname);

  const [selectedEvent, setSelectedEvent] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');

  const EVENTS_PAGE_SIZE = 24;

  const [events, setEvents] = useState([]);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [eventsLoadingMore, setEventsLoadingMore] = useState(false);
  const [eventsError, setEventsError] = useState('');
  const [eventsTotal, setEventsTotal] = useState(0);
  const [eventsHasMore, setEventsHasMore] = useState(false);
  // Seeded from a ?q= URL param on first load (e.g. a shared search link,
  // or Google's sitelinks search box — see the WebSite/SearchAction JSON-LD
  // in index.html, which promises exactly this URL shape actually runs the
  // search) so a search someone shares is actually reproducible for
  // whoever opens the link, not just a home-page visit.
  const initialQuery = (() => {
    if (typeof window === 'undefined') return '';
    return new URLSearchParams(window.location.search).get('q') || '';
  })();
  const [searchInput, setSearchInput] = useState(initialQuery);
  const [activeSearch, setActiveSearch] = useState(initialQuery);
  const [activeCategoryId, setActiveCategoryId] = useState(null);
  // Accounts aren't built yet — clicking "Sign In" just lets the visitor
  // know that, rather than pretending a login flow exists.
  const [showSignInNotice, setShowSignInNotice] = useState(false);

  // Autocomplete dropdown for the search box (spec: search/autocomplete
  // engine). Debounced so we don't hit the API on every keystroke; the
  // dropdown is dismissed on blur (with a short delay so a click on a
  // suggestion registers before the input loses focus) and after a
  // suggestion is picked or the search is submitted.
  const [autocompleteSuggestions, setAutocompleteSuggestions] = useState([]);
  const [showAutocomplete, setShowAutocomplete] = useState(false);

  // Filters panel: `draft*` holds what the customer is currently typing/
  // picking, `active*` holds what's actually been applied (and sent to the
  // API) — same pattern as searchInput/activeSearch, so editing a filter
  // doesn't refetch until the customer hits "Apply Filters".
  const [showFilters, setShowFilters] = useState(false);
  const [draftMinPrice, setDraftMinPrice] = useState('');
  const [draftMaxPrice, setDraftMaxPrice] = useState('');
  const [draftStartDate, setDraftStartDate] = useState('');
  const [draftEndDate, setDraftEndDate] = useState('');
  const [draftSort, setDraftSort] = useState('');
  const [draftLocation, setDraftLocation] = useState('');
  const [activeMinPrice, setActiveMinPrice] = useState('');
  const [activeMaxPrice, setActiveMaxPrice] = useState('');
  const [activeStartDate, setActiveStartDate] = useState('');
  const [activeEndDate, setActiveEndDate] = useState('');
  const [activeSort, setActiveSort] = useState('');
  const [activeLocation, setActiveLocation] = useState('');

  const activeFilterCount = [activeMinPrice, activeMaxPrice, activeStartDate, activeEndDate, activeSort, activeLocation]
    .filter((v) => v !== '' && v != null).length;

  // 'pending' | 'granted' | 'denied' | 'unavailable'. Events default to
  // nearest-first once we know the customer's location; we hold off on the
  // first fetch until this settles so the list doesn't visibly re-sort.
  const [locationStatus, setLocationStatus] = useState('pending');
  const [userLat, setUserLat] = useState(null);
  const [userLng, setUserLng] = useState(null);

  useEffect(() => {
    if (!('geolocation' in navigator)) {
      setLocationStatus('unavailable');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setUserLat(position.coords.latitude);
        setUserLng(position.coords.longitude);
        setLocationStatus('granted');
      },
      () => setLocationStatus('denied'),
      { timeout: 8000, maximumAge: 5 * 60 * 1000 }
    );
  }, []);

  // ---- Event-discovery homepage sections: Popular Events, Recommended for
  // You, Trending Events Near {city}, and Concerts/Sports/Theater/Comedy. ----
  const [zipInput, setZipInput] = useState('');
  const [zipStatus, setZipStatus] = useState('idle'); // 'idle' | 'loading' | 'error'
  // The resolved { city, state, lat, lng, source, zip? } used for every
  // discovery section below — from a ZIP the visitor typed in, or (once)
  // reverse-geocoded from browser geolocation. Restored from localStorage
  // on first load so a returning visitor doesn't have to re-enter it.
  const [discoverLocation, setDiscoverLocation] = useState(() => loadCachedLocation());
  const [discoverData, setDiscoverData] = useState(null);
  const [discoverLoading, setDiscoverLoading] = useState(true);

  const handleZipSubmit = async (e) => {
    e.preventDefault();
    const zip = zipInput.trim();
    if (!/^\d{5}$/.test(zip)) {
      setZipStatus('error');
      return;
    }
    setZipStatus('loading');
    try {
      const loc = await resolveZipLocation(zip);
      setDiscoverLocation(loc);
      saveCachedLocation(loc);
      setZipStatus('idle');
      setZipInput('');
    } catch (_err) {
      setZipStatus('error');
    }
  };

  // Falls back to reverse-geocoding the browser's geolocation into a city
  // name — but only once we know it (locationStatus 'granted') and only if
  // the visitor hasn't already given us a ZIP code (a typed ZIP is a more
  // deliberate, more precise signal than "wherever the browser says you are
  // right now", so it always wins and is never silently replaced here).
  //
  // ROOT CAUSE of the recurring "doesn't show closest events" bug: the
  // cached discoverLocation (localStorage, see loadCachedLocation above) has
  // no expiry. Previously this effect bailed out as soon as ANY cached
  // location existed ("if (discoverLocation || ...) return"), which meant an
  // auto-detected (source: 'geolocation') city cached on some earlier visit
  // — potentially a different city, a different device, or months stale —
  // would silently win over the browser's CURRENT, live position forever,
  // since it's never a deliberate override the way a typed ZIP is. Every
  // "closest events" computation (both this /discover call and the main
  // /events grid, which reuses discoverLocation the same way) then measured
  // distance from that stale point instead of where the visitor actually is
  // right now — explaining why this kept resurfacing "again and again"
  // rather than being a one-time glitch.
  //
  // Fix: a ZIP-sourced location still always wins (unchanged). A
  // geolocation-sourced one is now re-resolved against the CURRENT
  // userLat/userLng on every fresh grant, and only skipped when it's
  // already resolved for essentially this same position (~1km tolerance,
  // to avoid refetching on GPS jitter alone).
  useEffect(() => {
    if (locationStatus !== 'granted' || userLat == null || userLng == null) return;
    if (discoverLocation && discoverLocation.source === 'zip') return;
    if (
      discoverLocation &&
      discoverLocation.source === 'geolocation' &&
      Math.abs(discoverLocation.lat - userLat) < 0.01 &&
      Math.abs(discoverLocation.lng - userLng) < 0.01
    ) {
      return;
    }
    let cancelled = false;
    reverseGeocodeCity(userLat, userLng)
      .then((loc) => {
        if (cancelled) return;
        setDiscoverLocation(loc);
        saveCachedLocation(loc);
      })
      .catch(() => {
        // No city name available — the discovery sections below just run
        // without one (nationwide "Popular"/"Recommended", and "Trending
        // Events Near {city}" is skipped rather than showing a blank city).
      });
    return () => { cancelled = true; };
  }, [discoverLocation, locationStatus, userLat, userLng]);

  // Loads all seven discovery sections in one call once we know whatever
  // location we're going to know (a resolved ZIP/geolocation city, or that
  // none is coming — we don't wait forever on geolocation permission).
  useEffect(() => {
    if (!discoverLocation && locationStatus === 'pending') return;
    let cancelled = false;
    setDiscoverLoading(true);
    const params = new URLSearchParams();
    if (discoverLocation) {
      params.set('lat', String(discoverLocation.lat));
      params.set('lng', String(discoverLocation.lng));
      params.set('city', discoverLocation.city);
    } else if (locationStatus === 'granted' && userLat != null && userLng != null) {
      params.set('lat', String(userLat));
      params.set('lng', String(userLng));
    }
    const prefCategories = getPreferredCategories();
    if (prefCategories.length > 0) params.set('prefCategories', prefCategories.join(','));

    fetch(`${API_URL}/events/discover?${params.toString()}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!cancelled) setDiscoverData(data);
      })
      .catch(() => {
        if (!cancelled) setDiscoverData(null);
      })
      .finally(() => {
        if (!cancelled) setDiscoverLoading(false);
      });
    return () => { cancelled = true; };
  }, [discoverLocation, locationStatus, userLat, userLng]);

  // Keeps `selectedEvent` in sync with the URL. When a customer clicks
  // "Find Tickets" we already have the full merged object in hand (see the
  // grid button below) and just navigate — no fetch needed, no flash of a
  // loading state. But a direct visit, a page refresh, a shared link, or a
  // search engine crawler only has the URL, with no event data in memory,
  // so this fetches it from the merged single-event endpoint in that case.
  // Also clears selectedEvent when navigating back to "/" (Back button,
  // browser back/forward, or the logo).
  useEffect(() => {
    if (!eventIdFromUrl) {
      setSelectedEvent(null);
      setDetailError('');
      return;
    }
    if (selectedEvent && String(selectedEvent.id) === String(eventIdFromUrl)) return;

    let cancelled = false;
    setDetailLoading(true);
    setDetailError('');
    fetch(`${API_URL}/events/detail/${eventIdFromUrl}`)
      .then((response) => {
        if (!response.ok) throw new Error('Event not found');
        return response.json();
      })
      .then((data) => {
        if (cancelled) return;
        setSelectedEvent(data.event);
      })
      .catch(() => {
        if (!cancelled) setDetailError("We couldn't find that event. It may have been removed or the link is incorrect.");
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => { cancelled = true; };
  }, [eventIdFromUrl]);

  // SEO: page title, meta description, canonical URL, and Event structured
  // data (JSON-LD, spec §21) for whichever event is currently shown —
  // restored to the site defaults when leaving the detail view. This is a
  // client-rendered SPA (no server-side rendering), so this mainly helps
  // JS-executing crawlers (Googlebot does render JS) and social share
  // previews fetched after the page has loaded, rather than a classic
  // no-JS crawler — real SSR would be a further, separate upgrade.
  useEffect(() => {
    const defaultTitle = 'ConcertAndMatches.com — Newly Listed Tickets for Concerts, Sports & Theater';
    const defaultDescription = 'Be the first to buy tickets to concerts, sports, theater and comedy across the USA and Canada — new events listed from multiple authorized sellers as fast as they go on sale.';
    const canonicalEl = document.querySelector('link[rel="canonical"]');
    const descriptionEl = document.querySelector('meta[name="description"]');
    let jsonLdEl = document.getElementById('event-jsonld');

    if (selectedEvent) {
      const title = `${selectedEvent.title} Tickets — ${formatDate(selectedEvent.date)} | ConcertAndMatches.com`;
      const description = `Get tickets for ${selectedEvent.title}${selectedEvent.venue_name ? ` at ${selectedEvent.venue_name}` : ''}${selectedEvent.city ? ` in ${selectedEvent.city}` : ''} on ${formatDate(selectedEvent.date)}. Listed from multiple authorized sellers.`;
      const url = `https://www.concertandmatches.com${buildEventPath(selectedEvent)}`;

      document.title = title;
      if (descriptionEl) descriptionEl.setAttribute('content', description);
      if (canonicalEl) canonicalEl.setAttribute('href', url);

      const offersForLd = (Array.isArray(selectedEvent.offers) ? selectedEvent.offers : [])
        .filter((o) => o.min_price != null)
        .map((o) => ({
          '@type': 'Offer',
          price: Number(o.min_price).toFixed(2),
          priceCurrency: o.currency || 'USD',
          availability: 'https://schema.org/InStock',
          url,
        }));

      const jsonLd = {
        '@context': 'https://schema.org',
        '@type': 'Event',
        name: selectedEvent.title,
        startDate: selectedEvent.date,
        eventStatus: 'https://schema.org/EventScheduled',
        ...(selectedEvent.image_url ? { image: [selectedEvent.image_url] } : {}),
        location: {
          '@type': 'Place',
          name: selectedEvent.venue_name || undefined,
          address: {
            '@type': 'PostalAddress',
            addressLocality: selectedEvent.city || undefined,
            addressRegion: selectedEvent.state || undefined,
            addressCountry: selectedEvent.country === 'Canada' ? 'CA' : 'US',
          },
        },
        ...(selectedEvent.artist_name ? { performer: { '@type': 'PerformingGroup', name: selectedEvent.artist_name } } : {}),
        ...(offersForLd.length > 0 ? { offers: offersForLd } : {}),
      };

      if (!jsonLdEl) {
        jsonLdEl = document.createElement('script');
        jsonLdEl.id = 'event-jsonld';
        jsonLdEl.type = 'application/ld+json';
        document.head.appendChild(jsonLdEl);
      }
      jsonLdEl.textContent = JSON.stringify(jsonLd);
    } else {
      document.title = defaultTitle;
      if (descriptionEl) descriptionEl.setAttribute('content', defaultDescription);
      if (canonicalEl) canonicalEl.setAttribute('href', 'https://www.concertandmatches.com/');
      if (jsonLdEl) jsonLdEl.remove();
    }
  }, [selectedEvent]);

  const fetchEvents = async (offset, search, categoryId, filters) => {
    const params = new URLSearchParams({ limit: String(EVENTS_PAGE_SIZE), offset: String(offset) });
    if (search) params.set('search', search);
    const activeCategory = EVENT_CATEGORIES.find((c) => c.id === categoryId);
    if (activeCategory?.category) params.set('category', activeCategory.category.join(','));
    if (activeCategory?.keywords) params.set('keywords', activeCategory.keywords.join(','));
    // Same location precedence as the discovery sections above (discoverLocation
    // — a typed ZIP, or browser geolocation once reverse-geocoded to a city —
    // wins over raw live geolocation coords). Before this fix, this grid only
    // ever checked locationStatus/userLat/userLng directly, so a visitor who
    // denied the live location prompt but typed a ZIP code still got a plain
    // date-ordered "Featured Events" grid with the "Enable location in your
    // browser" notice, even though the site already had a real location for
    // them via the ZIP (as proven by the category rows above it, which DO use
    // discoverLocation, sorting correctly the whole time).
    if (discoverLocation) {
      params.set('lat', String(discoverLocation.lat));
      params.set('lng', String(discoverLocation.lng));
    } else if (locationStatus === 'granted' && userLat != null && userLng != null) {
      params.set('lat', String(userLat));
      params.set('lng', String(userLng));
    }
    if (filters?.minPrice) params.set('minPrice', filters.minPrice);
    if (filters?.maxPrice) params.set('maxPrice', filters.maxPrice);
    if (filters?.startDate) params.set('startDate', filters.startDate);
    if (filters?.endDate) params.set('endDate', filters.endDate);
    if (filters?.sort) params.set('sort', filters.sort);
    if (filters?.location) params.set('location', filters.location);
    const response = await fetch(`${API_URL}/events?${params.toString()}`);
    if (!response.ok) throw new Error('Request failed');
    return response.json();
  };

  const activeFilters = {
    minPrice: activeMinPrice,
    maxPrice: activeMaxPrice,
    startDate: activeStartDate,
    endDate: activeEndDate,
    sort: activeSort,
    location: activeLocation,
  };

  // Initial load, and reload from the top whenever the active search or
  // category tile changes, or the customer's location resolves (granted/
  // denied/unavailable) or changes (a typed ZIP, matching the discovery
  // sections' own wait condition above — see fetchEvents for why
  // discoverLocation is a dependency here too: without it, submitting a ZIP
  // code updated the category rows but never re-fetched this grid).
  useEffect(() => {
    if (!discoverLocation && locationStatus === 'pending') return;
    let cancelled = false;
    const loadEvents = async () => {
      setEventsLoading(true);
      setEventsError('');
      try {
        const data = await fetchEvents(0, activeSearch, activeCategoryId, activeFilters);
        if (cancelled) return;
        setEvents(data.events || []);
        setEventsTotal(data.total || 0);
        setEventsHasMore(Boolean(data.hasMore));
      } catch (error) {
        if (cancelled) return;
        setEventsError('Could not load events right now. Please try again later.');
      } finally {
        if (!cancelled) setEventsLoading(false);
      }
    };
    loadEvents();
    return () => { cancelled = true; };
  }, [activeSearch, activeCategoryId, locationStatus, discoverLocation, userLat, userLng, activeMinPrice, activeMaxPrice, activeStartDate, activeEndDate, activeSort, activeLocation]);

  const handleSearchSubmit = (e) => {
    e.preventDefault();
    setActiveSearch(searchInput.trim());
    setShowAutocomplete(false);
  };

  const handleClearSearch = () => {
    setSearchInput('');
    setActiveSearch('');
    setAutocompleteSuggestions([]);
    setShowAutocomplete(false);
  };

  const handleSuggestionClick = (label) => {
    setSearchInput(label);
    setActiveSearch(label);
    setShowAutocomplete(false);
  };

  // Debounced fetch of autocomplete suggestions as the customer types.
  useEffect(() => {
    const query = searchInput.trim();
    if (query.length < 2) {
      setAutocompleteSuggestions([]);
      return undefined;
    }
    const timer = setTimeout(() => {
      fetch(`${API_URL}/events/autocomplete?q=${encodeURIComponent(query)}`)
        .then((res) => (res.ok ? res.json() : { suggestions: [] }))
        .then((data) => {
          setAutocompleteSuggestions(data.suggestions || []);
          setShowAutocomplete(true);
        })
        .catch(() => setAutocompleteSuggestions([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const handleApplyFilters = (e) => {
    e.preventDefault();
    if (draftMinPrice !== '' && draftMaxPrice !== '' && Number(draftMinPrice) > Number(draftMaxPrice)) {
      setEventsError('Minimum price cannot be greater than maximum price.');
      return;
    }
    if (draftStartDate && draftEndDate && draftStartDate > draftEndDate) {
      setEventsError('Start date cannot be after end date.');
      return;
    }
    setActiveMinPrice(draftMinPrice);
    setActiveMaxPrice(draftMaxPrice);
    setActiveStartDate(draftStartDate);
    setActiveEndDate(draftEndDate);
    setActiveSort(draftSort);
    setActiveLocation(draftLocation.trim());
  };

  const handleClearFilters = () => {
    setDraftMinPrice('');
    setDraftMaxPrice('');
    setDraftStartDate('');
    setDraftEndDate('');
    setDraftSort('');
    setDraftLocation('');
    setActiveMinPrice('');
    setActiveMaxPrice('');
    setActiveStartDate('');
    setActiveEndDate('');
    setActiveSort('');
    setActiveLocation('');
  };

  // Shared by every event card on the homepage — the main "Featured Events"
  // grid and every discovery section (Popular/Recommended/Trending/by-
  // category) alike — so a click anywhere feeds the same category-interest
  // tally that personalizes "Recommended for You" (see bumpCategoryInterest
  // above) before navigating to the event's own page.
  const handleSelectEvent = (event) => {
    bumpCategoryInterest(event.category);
    setSelectedEvent(event);
    navigate(buildEventPath(event));
  };

  const handleLoadMore = async () => {
    setEventsLoadingMore(true);
    try {
      const data = await fetchEvents(events.length, activeSearch, activeCategoryId, activeFilters);
      setEvents((prev) => [...prev, ...(data.events || [])]);
      setEventsTotal(data.total || 0);
      setEventsHasMore(Boolean(data.hasMore));
    } catch (error) {
      setEventsError('Could not load more events right now. Please try again later.');
    } finally {
      setEventsLoadingMore(false);
    }
  };

  // ADMIN DASHBOARD — same-origin so it isn't blocked by the backend's
  // CORS allowedOrigins list (see backend/src/index.js). Auth is a runtime-
  // entered shared key (SYNC_SECRET_KEY), not a real user/session system —
  // see AdminPage.jsx for details.
  if (location.pathname === '/admin' || location.pathname.startsWith('/admin/')) {
    return <AdminPage />;
  }

  // EVENT DETAIL PAGE (direct load / refresh / shared link that hasn't
  // resolved to a full event object yet)
  if (eventIdFromUrl && detailLoading && !selectedEvent) {
    return (
      <div style={{ padding: '20px', fontFamily: 'Arial, sans-serif' }}>
        <nav style={{ marginBottom: '20px', display: 'flex', gap: '16px', alignItems: 'center' }}>
          <BrandLink onClick={() => navigate('/')} />
        </nav>
        <p style={{ textAlign: 'center', marginTop: '60px' }}>Loading event…</p>
      </div>
    );
  }

  if (eventIdFromUrl && detailError && !selectedEvent) {
    return (
      <div style={{ padding: '20px', fontFamily: 'Arial, sans-serif' }}>
        <nav style={{ marginBottom: '20px', display: 'flex', gap: '16px', alignItems: 'center' }}>
          <BrandLink onClick={() => navigate('/')} />
          <button onClick={() => navigate('/')} style={{ padding: '8px 16px', cursor: 'pointer' }}>
            ← Back to Events
          </button>
        </nav>
        <p style={{ textAlign: 'center', marginTop: '60px' }}>{detailError}</p>
      </div>
    );
  }

  // EVENT DETAIL PAGE
  if (selectedEvent) {
    const findTicketsLinks = buildFindTicketsLinks(selectedEvent);
    const priceTiers = getTicketPriceTiers(selectedEvent);
    return (
      <div style={{ padding: '20px', fontFamily: 'Arial, sans-serif' }}>
        <nav style={{ marginBottom: '20px', display: 'flex', gap: '16px', alignItems: 'center' }}>
          <BrandLink onClick={() => navigate('/')} />
          <button onClick={() => navigate('/')} style={{ padding: '8px 16px', cursor: 'pointer' }}>
            ← Back to Events
          </button>
        </nav>

        <div style={{ maxWidth: '600px', margin: '0 auto', border: '1px solid var(--cm-border)', padding: '30px', borderRadius: 'var(--cm-radius)', backgroundColor: '#fff', boxShadow: 'var(--cm-shadow-sm)' }}>
          {selectedEvent.image_url && (
            <img
              src={selectedEvent.image_url}
              alt={selectedEvent.title}
              style={{ width: '100%', borderRadius: '12px', marginBottom: '20px', objectFit: 'cover', maxHeight: '300px' }}
            />
          )}
          <h1>{selectedEvent.title}</h1>
          {selectedEvent.artist_name && (
            <p style={{ fontSize: '18px', color: '#666' }}>{selectedEvent.artist_name}</p>
          )}
          {selectedEvent.description && (
            <p style={{ fontSize: '15px', color: '#666' }}>{selectedEvent.description}</p>
          )}

          <div style={{ marginTop: '30px', padding: '20px', backgroundColor: '#f5f5f5', borderRadius: '14px', color: '#222' }}>
            <p><strong>📅 Date:</strong> {formatDate(selectedEvent.date)}</p>
            <p><strong>📍 Location:</strong> {selectedEvent.venue_name ? `${selectedEvent.venue_name}, ` : ''}{selectedEvent.city}{selectedEvent.state ? `, ${selectedEvent.state}` : ''}</p>
          </div>

          <div style={{ marginTop: '30px', padding: '20px', backgroundColor: '#f5f5f5', borderRadius: '14px', color: '#222' }}>
            <h3 style={{ marginTop: 0 }}>Find Tickets</h3>
            {findTicketsLinks.length === 0 ? (
              <p style={{ fontSize: '14px', color: '#666' }}>
                We don't have a confirmed ticket seller link for this event yet. Check back later,
                or search for it directly on your preferred ticket site.
              </p>
            ) : (
              <>
                {findTicketsLinks.length > 1 && (
                  <p style={{ fontSize: '14px', color: '#666', marginBottom: '14px' }}>
                    ConcertAndMatches doesn't sell tickets directly. This event is listed with more than one seller — click through below to buy:
                  </p>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {findTicketsLinks.map((link) => {
                    // The full tier breakdown (e.g. Standard vs. VIP) only
                    // makes sense to show when there's a single seller —
                    // once there's more than one offer, a plain per-seller
                    // price is what actually helps someone compare.
                    const showTierBreakdown = findTicketsLinks.length === 1 && priceTiers.length > 0;
                    const linkPrices = [...new Set(
                      [link.minPrice, link.maxPrice].filter((p) => p != null).map((p) => Number(p))
                    )].sort((a, b) => a - b);
                    const priceLabel = linkPrices.length > 0
                      ? linkPrices.map((p) => `$${p.toFixed(0)}`).join(', ')
                      : null;
                    const isOfficialLink = link.source === 'official';
                    return (
                      <div key={link.source}>
                        <a
                          className="cm-btn"
                          href={link.eventRowId ? `${GO_BASE}/go/event/${link.eventRowId}` : link.url}
                          target="_blank"
                          rel={link.eventRowId ? 'noopener sponsored' : 'noopener noreferrer sponsored'}
                          onClick={() => {
                            // The /go/event/:id redirect above logs the click
                            // server-side. Only fall back to the client-side
                            // beacon when we don't have a row id to redirect
                            // through (so the link above is the raw seller
                            // URL) — otherwise this would double-count.
                            if (!link.eventRowId) logTicketClick({ event_row_id: link.eventRowId, source: link.source }, selectedEvent);
                          }}
                          style={{
                            display: 'block',
                            padding: '13px 16px',
                            borderRadius: '12px',
                            border: isOfficialLink ? '1px solid #555' : '1px solid #8b0000',
                            backgroundColor: isOfficialLink ? '#444' : '#8b0000',
                            color: 'white',
                            textDecoration: 'none',
                            fontWeight: 'bold',
                            textAlign: 'center',
                          }}>
                          {isOfficialLink ? `Visit ${link.name} ↗` : `Buy Your Ticket on ${link.name} ↗`}
                        </a>
                        {showTierBreakdown && (
                          <div style={{ marginTop: '6px', padding: '8px 6px 4px', border: '1px solid #ddd', borderRadius: '12px' }}>
                            {priceTiers.map((tier, i) => {
                              const tierValues = [...new Set([tier.min, tier.max].filter((p) => p != null))].sort((a, b) => a - b);
                              // The generic fallback tier (no real named tier
                              // from the source, e.g. Ticketmaster's
                              // "Standard"/"VIP") is labeled "Price" — but
                              // with two distinct numbers that reads as one
                              // price rather than what it actually is, a
                              // range between two real endpoints. A real
                              // named tier keeps its own name either way.
                              const label = tier.label === 'Price' && tierValues.length > 1 ? 'Price range' : tier.label;
                              return (
                                <div
                                  key={`${tier.label}-${i}`}
                                  style={{
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    fontSize: '14px',
                                    color: '#1a73e8',
                                    fontWeight: 'bold',
                                    padding: '3px 2px',
                                  }}>
                                  <span>{label}</span>
                                  <span>{tierValues.map((p) => `$${p.toFixed(0)}`).join(', ')}</span>
                                </div>
                              );
                            })}
                          </div>
                        )}
                        {!showTierBreakdown && !isOfficialLink && (
                          <div style={{
                            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                            marginTop: '6px', padding: '6px 10px', border: '1px solid #ddd', borderRadius: '12px',
                            backgroundColor: '#fff',
                          }}>
                            {priceLabel ? (
                              <span style={{ fontSize: '14px', fontWeight: 'bold', color: '#1a73e8' }}>Available: {priceLabel}</span>
                            ) : (
                              <span style={{ fontSize: '13px', fontStyle: 'italic', color: '#999' }}>Price not listed</span>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {(priceTiers.length > 0 || findTicketsLinks.some((l) => l.minPrice != null)) && (
                  <p style={{ fontSize: '12px', color: '#888', marginTop: '14px' }}>
                    Prices shown are as last reported by each ticket seller and may change — confirm the final price on their site before buying.
                  </p>
                )}
              </>
            )}

            <AffiliateDisclosure />
          </div>
        </div>

        <div style={{ maxWidth: '600px', margin: '0 auto' }}>
          <Footer />
        </div>
      </div>
    );
  }

  // HOME PAGE
  return (
    <div style={{ padding: '20px', fontFamily: 'Arial, sans-serif' }}>
      <nav style={{
        marginBottom: '24px',
        display: 'flex',
        gap: '16px',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        padding: '14px 18px',
        backgroundColor: '#fff',
        borderRadius: '16px',
        boxShadow: 'var(--cm-shadow-sm)',
        border: '1px solid var(--cm-border)',
      }}>
        <BrandLink onClick={() => navigate('/')} />
        <div aria-label="Quick category filters" style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
          <span
            role="link"
            tabIndex={0}
            className="cm-chip"
            onClick={() => {
              setActiveCategoryId(null);
              document.getElementById('featured-events')?.scrollIntoView({ behavior: 'smooth' });
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setActiveCategoryId(null);
                document.getElementById('featured-events')?.scrollIntoView({ behavior: 'smooth' });
              }
            }}
            style={{
              cursor: 'pointer',
              fontWeight: 'bold',
              fontSize: '13px',
              padding: '7px 14px',
              borderRadius: '999px',
              backgroundColor: activeCategoryId === null ? '#8b0000' : '#f5f2f9',
              color: activeCategoryId === null ? '#fff' : '#1a0733',
            }}>
            All
          </span>
          {EVENT_CATEGORIES.map((cat) => {
            const isActive = activeCategoryId === cat.id;
            return (
              <span
                key={cat.id}
                role="link"
                tabIndex={0}
                className="cm-chip"
                onClick={() => {
                  setActiveCategoryId(isActive ? null : cat.id);
                  document.getElementById('featured-events')?.scrollIntoView({ behavior: 'smooth' });
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setActiveCategoryId(isActive ? null : cat.id);
                    document.getElementById('featured-events')?.scrollIntoView({ behavior: 'smooth' });
                  }
                }}
                style={{
                  cursor: 'pointer',
                  fontWeight: 'bold',
                  fontSize: '13px',
                  padding: '7px 14px',
                  borderRadius: '999px',
                  backgroundColor: isActive ? '#8b0000' : '#f5f2f9',
                  color: isActive ? '#fff' : '#1a0733',
                }}>
                {cat.label}
              </span>
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: '18px', alignItems: 'center' }}>
          <a
            href="mailto:sepehrirad15@gmail.com"
            className="cm-link-underline"
            style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'inherit', textDecoration: 'none', fontWeight: 'bold' }}>
            <span aria-hidden="true">✉️</span> Contact Us
          </a>
          <button
            type="button"
            onClick={() => setShowSignInNotice(true)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              background: 'none',
              border: 'none',
              padding: 0,
              margin: 0,
              font: 'inherit',
              fontWeight: 'bold',
              color: 'inherit',
              cursor: 'pointer',
            }}>
            <span aria-hidden="true">👤</span> Sign In
          </button>
        </div>
      </nav>

      {showSignInNotice && (
        <div
          role="alertdialog"
          aria-label="Sign in"
          onClick={() => setShowSignInNotice(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
          }}>
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: '#fff',
              color: '#222',
              padding: '28px',
              borderRadius: '18px',
              maxWidth: '320px',
              textAlign: 'center',
              boxShadow: 'var(--cm-shadow-lg)',
            }}>
            <p style={{ marginBottom: '18px' }}>Accounts and sign-in are coming soon — check back shortly!</p>
            <button
              type="button"
              className="cm-btn"
              onClick={() => setShowSignInNotice(false)}
              style={{ padding: '10px 24px', cursor: 'pointer', border: 'none', borderRadius: '999px', backgroundColor: '#8b0000', color: 'white', fontWeight: 'bold' }}>
              Got it
            </button>
          </div>
        </div>
      )}

      <h1 style={{
        textAlign: 'center',
        fontSize: 'clamp(30px, 5vw, 44px)',
        fontWeight: 800,
        letterSpacing: '-0.01em',
        lineHeight: 1.15,
        margin: '28px 0 14px',
      }}>
        Be The First To Buy Your Ticket
      </h1>

      <p style={{
        textAlign: 'center',
        fontSize: 'clamp(17px, 2.6vw, 22px)',
        fontWeight: 600,
        color: '#000',
        margin: '0 0 20px',
      }}>
        Compare Leading Ticket Marketplaces and Find the Best Available Ticket.
      </p>

      <form onSubmit={handleSearchSubmit} style={{ display: 'flex', gap: '10px', marginTop: 0, marginBottom: '16px', flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: '1', minWidth: '220px' }}>
          <input
            type="text"
            placeholder="Search by artist, event, venue or keyword..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onFocus={() => { if (autocompleteSuggestions.length > 0) setShowAutocomplete(true); }}
            onBlur={() => setTimeout(() => setShowAutocomplete(false), 150)}
            style={{
              width: '100%',
              padding: '14px 20px',
              boxSizing: 'border-box',
              borderRadius: '999px',
              border: '1px solid var(--cm-border)',
              boxShadow: 'var(--cm-shadow-sm)',
              fontSize: '15px',
              outline: 'none',
            }}
            autoComplete="off"
          />
          {showAutocomplete && autocompleteSuggestions.length > 0 && (
            <ul
              style={{
                position: 'absolute',
                top: 'calc(100% + 6px)',
                left: 0,
                right: 0,
                zIndex: 20,
                margin: 0,
                padding: '6px 0',
                listStyle: 'none',
                background: 'white',
                border: '1px solid var(--cm-border)',
                borderRadius: '14px',
                boxShadow: 'var(--cm-shadow-lg)',
                maxHeight: '280px',
                overflowY: 'auto',
              }}
            >
              {autocompleteSuggestions.map((s, i) => (
                <li
                  key={`${s.type}-${s.label}-${i}`}
                  onMouseDown={() => handleSuggestionClick(s.label)}
                  style={{
                    padding: '9px 16px',
                    cursor: 'pointer',
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: '8px',
                  }}
                >
                  <span>{s.label}</span>
                  <span style={{ color: '#888', fontSize: '0.8em' }}>{s.type}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <button
          type="submit"
          className="cm-btn"
          style={{
            padding: '14px 26px',
            cursor: 'pointer',
            borderRadius: '999px',
            border: 'none',
            backgroundColor: '#8b0000',
            color: '#fff',
            fontWeight: 'bold',
            fontSize: '15px',
          }}>
          Search
        </button>
        {activeSearch && (
          <button
            type="button"
            className="cm-btn"
            onClick={handleClearSearch}
            style={{
              padding: '14px 22px',
              cursor: 'pointer',
              borderRadius: '999px',
              border: '1px solid var(--cm-border)',
              backgroundColor: '#fff',
            }}>
            Clear
          </button>
        )}
        <button
          type="button"
          className="cm-btn"
          onClick={() => setShowFilters((v) => !v)}
          style={{
            padding: '14px 22px',
            cursor: 'pointer',
            borderRadius: '999px',
            border: activeFilterCount > 0 ? 'none' : '1px solid var(--cm-border)',
            backgroundColor: activeFilterCount > 0 ? '#1a73e8' : '#fff',
            color: activeFilterCount > 0 ? 'white' : undefined,
            fontWeight: activeFilterCount > 0 ? 'bold' : undefined,
          }}>
          Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''} {showFilters ? '▲' : '▼'}
        </button>
      </form>

      {showFilters && (
        <form
          onSubmit={handleApplyFilters}
          style={{
            display: 'flex',
            gap: '18px',
            flexWrap: 'wrap',
            alignItems: 'flex-end',
            padding: '18px 20px',
            marginBottom: '16px',
            backgroundColor: '#fff',
            borderRadius: '16px',
            border: '1px solid var(--cm-border)',
            boxShadow: 'var(--cm-shadow-sm)',
            color: '#222',
          }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
            <label style={{ fontSize: '12px', fontWeight: 'bold' }}>Location</label>
            <input
              type="text"
              placeholder="City or state"
              value={draftLocation}
              onChange={(e) => setDraftLocation(e.target.value)}
              style={{ padding: '9px 12px', width: '160px', boxSizing: 'border-box', borderRadius: '10px', border: '1px solid var(--cm-border)' }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
            <label style={{ fontSize: '12px', fontWeight: 'bold' }}>Min Price ($)</label>
            <input
              type="number"
              min="0"
              placeholder="0"
              value={draftMinPrice}
              onChange={(e) => setDraftMinPrice(e.target.value)}
              style={{ padding: '9px 12px', width: '100px', boxSizing: 'border-box', borderRadius: '10px', border: '1px solid var(--cm-border)' }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
            <label style={{ fontSize: '12px', fontWeight: 'bold' }}>Max Price ($)</label>
            <input
              type="number"
              min="0"
              placeholder="Any"
              value={draftMaxPrice}
              onChange={(e) => setDraftMaxPrice(e.target.value)}
              style={{ padding: '9px 12px', width: '100px', boxSizing: 'border-box', borderRadius: '10px', border: '1px solid var(--cm-border)' }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
            <label style={{ fontSize: '12px', fontWeight: 'bold' }}>From Date</label>
            <input
              type="date"
              value={draftStartDate}
              onChange={(e) => setDraftStartDate(e.target.value)}
              style={{ padding: '9px 12px', boxSizing: 'border-box', borderRadius: '10px', border: '1px solid var(--cm-border)' }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
            <label style={{ fontSize: '12px', fontWeight: 'bold' }}>To Date</label>
            <input
              type="date"
              value={draftEndDate}
              onChange={(e) => setDraftEndDate(e.target.value)}
              style={{ padding: '9px 12px', boxSizing: 'border-box', borderRadius: '10px', border: '1px solid var(--cm-border)' }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
            <label style={{ fontSize: '12px', fontWeight: 'bold' }}>Sort By</label>
            <select
              value={draftSort}
              onChange={(e) => setDraftSort(e.target.value)}
              style={{ padding: '9px 12px', boxSizing: 'border-box', borderRadius: '10px', border: '1px solid var(--cm-border)' }}>
              <option value="">
                {locationStatus === 'granted' ? 'Nearest first (default)' : 'Date (default)'}
              </option>
              <option value="date">Date: Soonest first</option>
              <option value="price-low">Price: Low to High</option>
              <option value="price-high">Price: High to Low</option>
              <option value="name">Name: A to Z</option>
              {locationStatus === 'granted' && <option value="distance">Distance: Nearest first</option>}
            </select>
          </div>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button
              type="submit"
              className="cm-btn"
              style={{ padding: '10px 20px', cursor: 'pointer', borderRadius: '999px', border: 'none', backgroundColor: '#8b0000', color: '#fff', fontWeight: 'bold' }}>
              Apply Filters
            </button>
            {activeFilterCount > 0 && (
              <button
                type="button"
                className="cm-btn"
                onClick={handleClearFilters}
                style={{ padding: '10px 20px', cursor: 'pointer', borderRadius: '999px', border: '1px solid var(--cm-border)', backgroundColor: '#fff' }}>
                Clear Filters
              </button>
            )}
          </div>
        </form>
      )}

      <EventSection
        title="Popular Events"
        events={discoverData?.popular}
        loading={discoverLoading}
        onSelect={handleSelectEvent}
      />
      <EventSection
        title="Recommended for You"
        events={discoverData?.recommended}
        loading={discoverLoading}
        onSelect={handleSelectEvent}
      />
      {(discoverLoading || discoverData?.city) && (
        <EventSection
          title={`Trending Events Near ${discoverData?.city || '…'}`}
          events={discoverData?.trending}
          loading={discoverLoading}
          onSelect={handleSelectEvent}
        />
      )}

      <CategoryTiles activeCategoryId={activeCategoryId} onSelect={setActiveCategoryId} />

      <EventSection
        title="NFL"
        events={discoverData?.categories?.nfl}
        loading={discoverLoading}
        onSelect={handleSelectEvent}
      />
      <EventSection
        title="Concerts"
        events={discoverData?.categories?.concerts}
        loading={discoverLoading}
        onSelect={handleSelectEvent}
      />
      <EventSection
        title="NBA"
        events={discoverData?.categories?.nba}
        loading={discoverLoading}
        onSelect={handleSelectEvent}
      />
      <EventSection
        title="NCAA Football"
        events={discoverData?.categories?.ncaaFootball}
        loading={discoverLoading}
        onSelect={handleSelectEvent}
      />
      <EventSection
        title="Theater"
        events={discoverData?.categories?.theater}
        loading={discoverLoading}
        onSelect={handleSelectEvent}
      />
      <EventSection
        title="Comedy"
        events={discoverData?.categories?.comedy}
        loading={discoverLoading}
        onSelect={handleSelectEvent}
      />

      <div id="featured-events" style={{ marginTop: '20px' }}>
        <h3 style={{ fontSize: '26px' }}>Featured Events</h3>

        {(activeSearch || activeCategoryId || activeFilterCount > 0) && !eventsLoading && !eventsError && (
          <p style={{ color: '#666' }}>
            {eventsTotal} result{eventsTotal === 1 ? '' : 's'}
            {activeCategoryId ? ` in ${EVENT_CATEGORIES.find((c) => c.id === activeCategoryId)?.label}` : ''}
            {activeSearch ? ` for "${activeSearch}"` : ''}
            {activeFilterCount > 0 ? ` (${activeFilterCount} filter${activeFilterCount === 1 ? '' : 's'} applied)` : ''}
          </p>
        )}

        {(discoverLocation || locationStatus === 'granted') && (
          <p style={{ color: '#666', fontSize: '13px' }}>📍 Showing events near you first</p>
        )}
        {!discoverLocation && (locationStatus === 'denied' || locationStatus === 'unavailable') && (
          <p style={{ color: '#666', fontSize: '13px' }}>
            Showing events by date. Enable location in your browser to see events near you first.
          </p>
        )}

        {eventsLoading && <p>Loading events...</p>}
        {!eventsLoading && eventsError && <p>{eventsError}</p>}
        {!eventsLoading && !eventsError && events.length === 0 && (
          <p>
            {activeSearch || activeCategoryId || activeFilterCount > 0
              ? `No events found${activeCategoryId ? ` in ${EVENT_CATEGORIES.find((c) => c.id === activeCategoryId)?.label}` : ''}${activeSearch ? ` for "${activeSearch}"` : ''}${activeFilterCount > 0 ? ' with the selected filters' : ''}. Try adjusting your filters.`
              : 'No events available right now. Check back soon!'}
          </p>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '20px' }}>
          {events.map((event) => (
            <EventCard key={event.id} event={event} onSelect={handleSelectEvent} />
          ))}
        </div>

        {!eventsLoading && !eventsError && eventsHasMore && (
          <div style={{ textAlign: 'center', marginTop: '24px' }}>
            <button
              onClick={handleLoadMore}
              disabled={eventsLoadingMore}
              style={{ padding: '10px 24px', cursor: eventsLoadingMore ? 'default' : 'pointer' }}>
              {eventsLoadingMore ? 'Loading...' : `Load More (${events.length} of ${eventsTotal})`}
            </button>
          </div>
        )}

        <Footer />
      </div>
    </div>
  );
}
