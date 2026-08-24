// build-refresh marker 2
import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
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

function formatDate(dateStr) {
  if (!dateStr) return 'Date TBA';
  try {
    return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
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
      label: t.type || 'Price',
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

  return offers
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
const EVENT_CATEGORIES = [
  {
    id: 'nfl',
    label: 'NFL',
    emoji: '🏈',
    keywords: ['NFL'],
    background: 'linear-gradient(135deg, #013369, #1c3f7c)',
  },
  {
    id: 'concerts',
    label: 'Concerts',
    emoji: '🎤',
    category: ['Music', 'Concert'],
    background: 'linear-gradient(135deg, #8e2de2, #e91e8c)',
  },
  {
    id: 'nba',
    label: 'NBA',
    emoji: '🏀',
    keywords: ['NBA', 'Basketball'],
    background: 'linear-gradient(135deg, #1d428a, #c8102e)',
  },
  {
    id: 'ncaaf',
    label: 'NCAA Football',
    emoji: '🎓',
    keywords: ['NCAA Football', 'College Football', 'NCAA'],
    background: 'linear-gradient(135deg, #002d62, #b08d2c)',
  },
  {
    id: 'theater',
    label: 'Theater',
    emoji: '🎭',
    category: ['Arts & Theatre'],
    background: 'linear-gradient(135deg, #6a0dad, #a8781f)',
  },
  {
    id: 'comedy',
    label: 'Comedy',
    emoji: '😂',
    keywords: ['Comedy', 'Stand-Up', 'Stand Up'],
    background: 'linear-gradient(135deg, #ff8c00, #ffb703)',
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
      {EVENT_CATEGORIES.map((cat) => {
        const isActive = activeCategoryId === cat.id;
        return (
          <button
            key={cat.id}
            type="button"
            onClick={() => onSelect(isActive ? null : cat.id)}
            style={{
              background: cat.background,
              border: isActive ? '3px solid #222' : '3px solid transparent',
              borderRadius: '10px',
              padding: '16px 8px',
              color: 'white',
              cursor: 'pointer',
              textAlign: 'center',
              boxShadow: isActive ? '0 0 0 2px white inset' : 'none',
            }}>
            <div style={{ fontSize: '26px', marginBottom: '6px' }}>{cat.emoji}</div>
            <div style={{ fontWeight: 'bold', fontSize: '16px' }}>{cat.label}</div>
          </button>
        );
      })}
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
  return (
    <footer style={{ marginTop: '40px', padding: '20px 0', borderTop: '1px solid #eee', fontSize: '12px', color: '#888' }}>
      <p>ConcertAndMatches is an independent event discovery site and is not affiliated with any ticket seller. We may earn a commission when you buy tickets through links on this site.</p>
      <p style={{ marginTop: '8px' }}>
        <a href="/guide" style={{ color: '#888', marginRight: '16px' }}>Ticket Price Guides</a>
        <a href="/terms.html" style={{ color: '#888', marginRight: '16px' }}>Terms of Service</a>
        <a href="/privacy.html" style={{ color: '#888' }}>Privacy Policy</a>
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
  const [searchInput, setSearchInput] = useState('');
  const [activeSearch, setActiveSearch] = useState('');
  const [activeCategoryId, setActiveCategoryId] = useState(null);

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

  // Keeps `selectedEvent` in sync with the URL. When a customer clicks
  // "View Event" we already have the full merged object in hand (see the
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
    const defaultTitle = 'ConcertAndMatches.com — Compare Ticket Prices for Concerts, Sports & Theater';
    const defaultDescription = 'Compare available ticket offers from multiple authorized sellers for concerts, sports, theater and events across the USA and Canada. See current prices side by side before you buy.';
    const canonicalEl = document.querySelector('link[rel="canonical"]');
    const descriptionEl = document.querySelector('meta[name="description"]');
    let jsonLdEl = document.getElementById('event-jsonld');

    if (selectedEvent) {
      const title = `${selectedEvent.title} Tickets — ${formatDate(selectedEvent.date)} | ConcertAndMatches.com`;
      const description = `Compare ticket prices for ${selectedEvent.title}${selectedEvent.venue_name ? ` at ${selectedEvent.venue_name}` : ''}${selectedEvent.city ? ` in ${selectedEvent.city}` : ''} on ${formatDate(selectedEvent.date)}. See offers from multiple authorized sellers.`;
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
    if (locationStatus === 'granted' && userLat != null && userLng != null) {
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
  // denied/unavailable).
  useEffect(() => {
    if (locationStatus === 'pending') return;
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
  }, [activeSearch, activeCategoryId, locationStatus, activeMinPrice, activeMaxPrice, activeStartDate, activeEndDate, activeSort, activeLocation]);

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

        <div style={{ maxWidth: '600px', margin: '0 auto', border: '1px solid #ddd', padding: '30px', borderRadius: '8px' }}>
          {selectedEvent.image_url && (
            <img
              src={selectedEvent.image_url}
              alt={selectedEvent.title}
              style={{ width: '100%', borderRadius: '8px', marginBottom: '20px', objectFit: 'cover', maxHeight: '300px' }}
            />
          )}
          <h1>{selectedEvent.title}</h1>
          {selectedEvent.artist_name && (
            <p style={{ fontSize: '18px', color: '#666' }}>{selectedEvent.artist_name}</p>
          )}
          {selectedEvent.description && (
            <p style={{ fontSize: '15px', color: '#666' }}>{selectedEvent.description}</p>
          )}

          <div style={{ marginTop: '30px', padding: '20px', backgroundColor: '#f5f5f5', borderRadius: '8px', color: '#222' }}>
            <p><strong>📅 Date:</strong> {formatDate(selectedEvent.date)}</p>
            <p><strong>📍 Location:</strong> {selectedEvent.venue_name ? `${selectedEvent.venue_name}, ` : ''}{selectedEvent.city}{selectedEvent.state ? `, ${selectedEvent.state}` : ''}</p>
            <p><strong>{findTicketsLinks.length > 1 ? '💰 Best Price:' : '💰 Price:'}</strong> {formatPrice(selectedEvent)}</p>
          </div>

          <div style={{ marginTop: '30px', padding: '20px', backgroundColor: '#f5f5f5', borderRadius: '8px', color: '#222' }}>
            <h3 style={{ marginTop: 0 }}>Find Tickets</h3>
            {findTicketsLinks.length === 0 ? (
              <p style={{ fontSize: '14px', color: '#666' }}>
                We don't have a confirmed ticket seller link for this event yet. Check back later,
                or search for it directly on your preferred ticket site.
              </p>
            ) : (
              <>
                <p style={{ fontSize: '14px', color: '#666', marginBottom: '14px' }}>
                  {findTicketsLinks.length > 1
                    ? "ConcertAndMatches doesn't sell tickets directly. This event is listed with more than one seller — compare prices below and click through to buy:"
                    : "ConcertAndMatches doesn't sell tickets directly. This event was found on the seller below — click through to see availability and complete your purchase:"}
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {findTicketsLinks.map((link) => {
                    // The full tier breakdown (e.g. Standard vs. VIP) only
                    // makes sense to show when there's a single seller —
                    // once there's more than one offer, a plain per-seller
                    // price is what actually helps someone compare.
                    const showTierBreakdown = findTicketsLinks.length === 1 && priceTiers.length > 0;
                    const priceLabel = link.minPrice != null || link.maxPrice != null
                      ? (link.minPrice != null && link.maxPrice != null && link.minPrice !== link.maxPrice
                          ? `from $${Number(link.minPrice).toFixed(0)}`
                          : `$${Number(link.minPrice != null ? link.minPrice : link.maxPrice).toFixed(0)}`)
                      : null;
                    const highlightBest = link.isBest && findTicketsLinks.length > 1;
                    const isOfficialLink = link.source === 'official';
                    return (
                      <div key={link.source}>
                        <a
                          href={link.eventRowId ? `${GO_BASE}/go/event/${link.eventRowId}` : link.url}
                          target="_blank"
                          rel="noopener noreferrer sponsored"
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
                            padding: '12px 16px',
                            borderRadius: showTierBreakdown || (!showTierBreakdown && priceLabel) ? '8px 8px 0 0' : '8px',
                            border: isOfficialLink ? '1px solid #555' : (highlightBest ? '1px solid #2e7d32' : '1px solid #8b0000'),
                            backgroundColor: isOfficialLink ? '#444' : (highlightBest ? '#2e7d32' : '#8b0000'),
                            color: 'white',
                            textDecoration: 'none',
                            fontWeight: 'bold',
                            textAlign: 'center',
                          }}>
                          {isOfficialLink ? `Visit ${link.name} ↗` : `Search on ${link.name} ↗`}
                        </a>
                        {showTierBreakdown && (
                          <div style={{ padding: '8px 6px 4px', border: '1px solid #ddd', borderTop: 'none', borderRadius: '0 0 8px 8px' }}>
                            {priceTiers.map((tier, i) => (
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
                                <span>{tier.label}</span>
                                <span>
                                  {tier.min != null && tier.max != null && tier.min !== tier.max
                                    ? `$${tier.min.toFixed(0)} - $${tier.max.toFixed(0)}`
                                    : `$${(tier.min != null ? tier.min : tier.max).toFixed(0)}`}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                        {!showTierBreakdown && priceLabel && (
                          <div style={{
                            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                            padding: '6px 10px', border: '1px solid #ddd', borderTop: 'none', borderRadius: '0 0 8px 8px',
                            backgroundColor: '#fff',
                          }}>
                            <span style={{ fontSize: '14px', fontWeight: 'bold', color: '#1a73e8' }}>{priceLabel}</span>
                            {highlightBest && (
                              <span style={{ fontSize: '11px', fontWeight: 'bold', color: 'white', backgroundColor: '#2e7d32', padding: '2px 8px', borderRadius: '10px' }}>
                                BEST PRICE
                              </span>
                            )}
                          </div>
                        )}
                        {!showTierBreakdown && !priceLabel && !isOfficialLink && (
                          <div style={{
                            padding: '6px 10px', border: '1px solid #ddd', borderTop: 'none', borderRadius: '0 0 8px 8px',
                            backgroundColor: '#fff', fontSize: '13px', color: '#000', textAlign: 'center', fontWeight: 'bold',
                          }}>
                            Price not yet reported by this seller
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
      <nav style={{ marginBottom: '20px', display: 'flex', gap: '10px', alignItems: 'center' }}>
        <BrandLink onClick={() => navigate('/')} />
      </nav>

      <h1 style={{ textAlign: 'center', fontSize: '40px', margin: '10px 0 30px' }}>
        Best Price For Any Events
      </h1>

      <div style={{ marginTop: '20px' }}>
        <h3>Featured Events</h3>

        <form onSubmit={handleSearchSubmit} style={{ display: 'flex', gap: '10px', marginBottom: '16px', flexWrap: 'wrap' }}>
          <div style={{ position: 'relative', flex: '1', minWidth: '220px' }}>
            <input
              type="text"
              placeholder="Search by artist, event, venue or keyword..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onFocus={() => { if (autocompleteSuggestions.length > 0) setShowAutocomplete(true); }}
              onBlur={() => setTimeout(() => setShowAutocomplete(false), 150)}
              style={{ width: '100%', padding: '10px', boxSizing: 'border-box' }}
              autoComplete="off"
            />
            {showAutocomplete && autocompleteSuggestions.length > 0 && (
              <ul
                style={{
                  position: 'absolute',
                  top: 'calc(100% + 2px)',
                  left: 0,
                  right: 0,
                  zIndex: 20,
                  margin: 0,
                  padding: '4px 0',
                  listStyle: 'none',
                  background: 'white',
                  border: '1px solid #ddd',
                  borderRadius: '4px',
                  boxShadow: '0 4px 10px rgba(0,0,0,0.1)',
                  maxHeight: '280px',
                  overflowY: 'auto',
                }}
              >
                {autocompleteSuggestions.map((s, i) => (
                  <li
                    key={`${s.type}-${s.label}-${i}`}
                    onMouseDown={() => handleSuggestionClick(s.label)}
                    style={{
                      padding: '8px 12px',
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
          <button type="submit" style={{ padding: '10px 20px', cursor: 'pointer' }}>
            Search
          </button>
          {activeSearch && (
            <button type="button" onClick={handleClearSearch} style={{ padding: '10px 20px', cursor: 'pointer' }}>
              Clear
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowFilters((v) => !v)}
            style={{
              padding: '10px 20px',
              cursor: 'pointer',
              backgroundColor: activeFilterCount > 0 ? '#1a73e8' : undefined,
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
              gap: '16px',
              flexWrap: 'wrap',
              alignItems: 'flex-end',
              padding: '16px',
              marginBottom: '16px',
              backgroundColor: '#f5f5f5',
              borderRadius: '8px',
              color: '#222',
            }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '12px', fontWeight: 'bold' }}>Location</label>
              <input
                type="text"
                placeholder="City or state"
                value={draftLocation}
                onChange={(e) => setDraftLocation(e.target.value)}
                style={{ padding: '8px', width: '160px', boxSizing: 'border-box' }}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '12px', fontWeight: 'bold' }}>Min Price ($)</label>
              <input
                type="number"
                min="0"
                placeholder="0"
                value={draftMinPrice}
                onChange={(e) => setDraftMinPrice(e.target.value)}
                style={{ padding: '8px', width: '100px', boxSizing: 'border-box' }}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '12px', fontWeight: 'bold' }}>Max Price ($)</label>
              <input
                type="number"
                min="0"
                placeholder="Any"
                value={draftMaxPrice}
                onChange={(e) => setDraftMaxPrice(e.target.value)}
                style={{ padding: '8px', width: '100px', boxSizing: 'border-box' }}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '12px', fontWeight: 'bold' }}>From Date</label>
              <input
                type="date"
                value={draftStartDate}
                onChange={(e) => setDraftStartDate(e.target.value)}
                style={{ padding: '8px', boxSizing: 'border-box' }}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '12px', fontWeight: 'bold' }}>To Date</label>
              <input
                type="date"
                value={draftEndDate}
                onChange={(e) => setDraftEndDate(e.target.value)}
                style={{ padding: '8px', boxSizing: 'border-box' }}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '12px', fontWeight: 'bold' }}>Sort By</label>
              <select
                value={draftSort}
                onChange={(e) => setDraftSort(e.target.value)}
                style={{ padding: '8px', boxSizing: 'border-box' }}>
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
              <button type="submit" style={{ padding: '10px 20px', cursor: 'pointer' }}>
                Apply Filters
              </button>
              {activeFilterCount > 0 && (
                <button type="button" onClick={handleClearFilters} style={{ padding: '10px 20px', cursor: 'pointer' }}>
                  Clear Filters
                </button>
              )}
            </div>
          </form>
        )}

        <CategoryTiles activeCategoryId={activeCategoryId} onSelect={setActiveCategoryId} />

        {(activeSearch || activeCategoryId || activeFilterCount > 0) && !eventsLoading && !eventsError && (
          <p style={{ color: '#666' }}>
            {eventsTotal} result{eventsTotal === 1 ? '' : 's'}
            {activeCategoryId ? ` in ${EVENT_CATEGORIES.find((c) => c.id === activeCategoryId)?.label}` : ''}
            {activeSearch ? ` for "${activeSearch}"` : ''}
            {activeFilterCount > 0 ? ` (${activeFilterCount} filter${activeFilterCount === 1 ? '' : 's'} applied)` : ''}
          </p>
        )}

        {locationStatus === 'granted' && (
          <p style={{ color: '#666', fontSize: '13px' }}>📍 Showing events near you first</p>
        )}
        {(locationStatus === 'denied' || locationStatus === 'unavailable') && (
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
            <div key={event.id} style={{ border: '1px solid #ddd', borderRadius: '8px', overflow: 'hidden' }}>
              {event.image_url && (
                <img
                  src={event.image_url}
                  alt={event.title}
                  style={{ width: '100%', height: '150px', objectFit: 'cover' }}
                />
              )}
              <div style={{ padding: '15px' }}>
                <h4>{event.title}</h4>
                <p>📅 {formatDate(event.date)}</p>
                <p>📍 {event.city}{event.state ? `, ${event.state}` : ''}</p>
                {formatDistance(event.distance_km) && (
                  <p style={{ color: '#4CAF50', fontWeight: 'bold' }}>🚗 {formatDistance(event.distance_km)}</p>
                )}
                <p>
                  💰 {formatPrice(event)}
                  {Array.isArray(event.offers) && event.offers.length > 1 && (
                    <span style={{
                      marginLeft: '8px',
                      fontSize: '10px',
                      fontWeight: 'bold',
                      color: 'white',
                      backgroundColor: '#2e7d32',
                      padding: '2px 6px',
                      borderRadius: '8px',
                      verticalAlign: 'middle',
                    }}>
                      BEST PRICE
                    </span>
                  )}
                </p>
                {formatOffersComparison(event) && (
                  <p style={{ fontSize: '12px', color: '#666', margin: '2px 0 10px' }}>
                    {formatOffersComparison(event)}
                  </p>
                )}
                <button
                  onClick={() => { setSelectedEvent(event); navigate(buildEventPath(event)); }}
                  style={{
                    padding: '8px 16px',
                    cursor: 'pointer',
                    width: '100%',
                    border: '1px solid #8b0000',
                    backgroundColor: '#8b0000',
                    color: 'white',
                    fontWeight: 'bold',
                    borderRadius: '8px',
                  }}>
                  View Event
                </button>
              </div>
            </div>
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
