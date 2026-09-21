// build-refresh marker 2
import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import AdminPage from './AdminPage.jsx';
import { initMetaPixel, trackMetaPageView, trackMetaTicketClick } from './lib/metaPixel.js';
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

// ---- Lightweight, anonymous per-browser personalization signal. No longer
// consumed by anything on the homepage (the discovery sections that used to
// read getPreferredCategories() were removed), left in place only because
// bumpCategoryInterest is still called on every seller click below — kept
// harmless (localStorage-only, never blocks a click) in case a future
// feature wants this signal again. ----
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

// ---- Visitor location, resolved for "near me" sorting of the Featured
// Events grid. Two sources, tried in this order:
//  1. A ZIP code the visitor typed in (see the homepage's ZIP input) —
//     looked up via zippopotam.us (free, no API key, CORS-enabled), which
//     returns the ZIP's place name and coordinates directly.
//  2. Browser geolocation (already used elsewhere on this page for
//     nearest-first sorting) — reverse-geocoded to a city name via
//     bigdatacloud's free, keyless, CORS-enabled reverse-geocode API.
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

// ---- "DATES" range picker in the homepage search bar: a two-month
// calendar popover (Start date / End date fields, Reset / Cancel / Apply)
// replacing the earlier named-preset dropdown, per the reference layout
// provided for this. All dates are plain YYYY-MM-DD strings — the same
// format the /events API already accepted from the old date inputs.
function toISODate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function isoToDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function formatShortDate(iso) {
  if (!iso) return '';
  return isoToDate(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatSlashDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
}

function addMonths(monthStart, n) {
  return new Date(monthStart.getFullYear(), monthStart.getMonth() + n, 1);
}

// Cells for one calendar month: null for the leading blanks before day 1,
// else that day's ISO date string.
function getMonthCells(monthStart) {
  const year = monthStart.getFullYear();
  const month = monthStart.getMonth();
  const startWeekday = new Date(year, month, 1).getDay(); // 0 Sun .. 6 Sat
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let day = 1; day <= daysInMonth; day++) cells.push(toISODate(new Date(year, month, day)));
  return cells;
}

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// One calendar month grid inside the DatesPicker popover below. `onPick`
// fires with the clicked day's ISO date; days before today are shown
// grayed-out and unclickable (there's no reason to filter for events on a
// date that's already passed).
function CalendarMonth({ monthStart, todayISO, rangeStart, rangeEnd, onPick, navArrow }) {
  const cells = getMonthCells(monthStart);
  return (
    <div style={{ flex: '1', minWidth: '240px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
        <span style={{ fontWeight: 700, fontSize: '16px' }}>
          {monthStart.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}
        </span>
        {navArrow}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '4px', marginBottom: '6px' }}>
        {WEEKDAY_LABELS.map((label) => (
          <div key={label} style={{ textAlign: 'center', fontSize: '12px', fontWeight: 700, color: '#444' }}>
            {label}
          </div>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '4px' }}>
        {cells.map((iso, i) => {
          if (!iso) return <div key={`blank-${i}`} />;
          const isPast = iso < todayISO;
          const isStart = iso === rangeStart;
          const isEnd = iso === rangeEnd;
          const inRange = rangeStart && rangeEnd && iso > rangeStart && iso < rangeEnd;
          return (
            <button
              key={iso}
              type="button"
              disabled={isPast}
              onClick={() => onPick(iso)}
              style={{
                padding: '7px 0',
                borderRadius: '8px',
                border: 'none',
                cursor: isPast ? 'default' : 'pointer',
                fontSize: '14px',
                fontWeight: isStart || isEnd ? 700 : 400,
                color: isPast ? '#ccc' : (isStart || isEnd) ? '#fff' : '#1a0733',
                backgroundColor: (isStart || isEnd) ? '#2f7fe8' : inRange ? '#f7e6e6' : 'transparent',
              }}>
              {Number(iso.slice(-2))}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// The DATES popover itself: seeded from the already-applied startDate/
// endDate when opened, held in its own local draft (pickerStart/pickerEnd)
// until Apply commits it back up via onApply — Cancel (or a click outside,
// wired where this is rendered) discards the in-progress selection instead.
function DatesPicker({ startDate, endDate, onApply, onCancel }) {
  const [pickerStart, setPickerStart] = useState(startDate || '');
  const [pickerEnd, setPickerEnd] = useState(endDate || '');
  const [viewMonth, setViewMonth] = useState(() => {
    const base = startDate ? isoToDate(startDate) : new Date();
    return new Date(base.getFullYear(), base.getMonth(), 1);
  });

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayISO = toISODate(today);
  const currentMonthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const canGoBack = viewMonth > currentMonthStart;

  const handlePick = (iso) => {
    if (!pickerStart || pickerEnd) {
      setPickerStart(iso);
      setPickerEnd('');
    } else if (iso < pickerStart) {
      setPickerStart(iso);
      setPickerEnd('');
    } else {
      setPickerEnd(iso);
    }
  };

  return (
    <div
      style={{
        position: 'absolute',
        top: 'calc(100% + 8px)',
        left: 0,
        zIndex: 30,
        width: 'min(640px, 92vw)',
        backgroundColor: '#fff',
        border: '1px solid var(--cm-border)',
        borderRadius: '16px',
        boxShadow: 'var(--cm-shadow-lg)',
        padding: '20px',
      }}>
      <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', marginBottom: '20px' }}>
        <div style={{ flex: 1, minWidth: '140px' }}>
          <div style={{ fontSize: '13px', color: '#444', marginBottom: '6px' }}>Start date</div>
          <input
            type="text"
            readOnly
            value={formatSlashDate(pickerStart)}
            placeholder="MM/DD/YYYY"
            style={{
              width: '100%',
              boxSizing: 'border-box',
              padding: '10px 12px',
              fontSize: '14px',
              borderRadius: '8px',
              border: !pickerStart || pickerEnd ? '2px solid var(--cm-border)' : '2px solid #2f7fe8',
              outline: 'none',
              color: '#1a0733',
            }}
          />
        </div>
        <div style={{ flex: 1, minWidth: '140px' }}>
          <div style={{ fontSize: '13px', color: '#444', marginBottom: '6px' }}>End date</div>
          <input
            type="text"
            readOnly
            value={formatSlashDate(pickerEnd)}
            placeholder="MM/DD/YYYY"
            style={{
              width: '100%',
              boxSizing: 'border-box',
              padding: '10px 12px',
              fontSize: '14px',
              borderRadius: '8px',
              border: pickerStart && !pickerEnd ? '2px solid #2f7fe8' : '2px solid var(--cm-border)',
              outline: 'none',
              color: '#1a0733',
            }}
          />
        </div>
      </div>

      <div style={{ display: 'flex', gap: '28px', flexWrap: 'wrap' }}>
        <CalendarMonth
          monthStart={viewMonth}
          todayISO={todayISO}
          rangeStart={pickerStart}
          rangeEnd={pickerEnd}
          onPick={handlePick}
          navArrow={canGoBack ? (
            <button
              type="button"
              onClick={() => setViewMonth((m) => addMonths(m, -1))}
              aria-label="Previous month"
              style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: '18px', color: '#2f7fe8', fontWeight: 'bold' }}>
              ←
            </button>
          ) : null}
        />
        <CalendarMonth
          monthStart={addMonths(viewMonth, 1)}
          todayISO={todayISO}
          rangeStart={pickerStart}
          rangeEnd={pickerEnd}
          onPick={handlePick}
          navArrow={(
            <button
              type="button"
              onClick={() => setViewMonth((m) => addMonths(m, 1))}
              aria-label="Next month"
              style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: '18px', color: '#2f7fe8', fontWeight: 'bold' }}>
              →
            </button>
          )}
        />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '20px', flexWrap: 'wrap', gap: '10px' }}>
        <button
          type="button"
          onClick={() => { setPickerStart(''); setPickerEnd(''); }}
          style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#2f7fe8', fontWeight: 700, fontSize: '14px', padding: 0 }}>
          Reset
        </button>
        <div style={{ display: 'flex', gap: '10px' }}>
          <button
            type="button"
            onClick={onCancel}
            className="cm-btn"
            style={{ padding: '10px 22px', cursor: 'pointer', borderRadius: '999px', border: '1px solid var(--cm-border)', backgroundColor: '#fff', fontWeight: 'bold' }}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onApply(pickerStart, pickerEnd)}
            className="cm-btn"
            style={{ padding: '10px 22px', cursor: 'pointer', borderRadius: '999px', border: 'none', backgroundColor: '#2f7fe8', color: '#fff', fontWeight: 'bold' }}>
            Apply
          </button>
        </div>
      </div>
    </div>
  );
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
// Per-seller dot color for the Find Tickets list (redesigned to match a
// reference comparison-list layout: a colored dot + seller name on the
// left, price on the right). These are just distinct categorical colors
// for quick visual scanning across sellers, not an attempt at each
// retailer's exact trademarked brand color.
const SOURCE_DOT_COLOR = {
  ticketmaster: '#026cdf',
  seatgeek: '#0f9d58',
  ticketnetwork: '#7c3aed',
  official: '#6b7280',
  curated: '#e0a100',
};

function buildFindTicketsLinks(event) {
  const q = encodeURIComponent(event.title || event.artist_name || '');
  const sourceMeta = {
    ticketmaster: {
      name: 'Ticketmaster',
      domain: 'ticketmaster.com',
      buildUrl: (url) => trackedTicketmasterLink(url || `https://www.ticketmaster.com/search?q=${q}`),
    },
    seatgeek: {
      name: 'SeatGeek',
      domain: 'seatgeek.com',
      buildUrl: (url) => url || `https://seatgeek.com/search?search=${q}`,
    },
    // TicketNetwork, via the (already-approved) Impact.com affiliate
    // catalog — see backend/src/services/ticketnetwork.js. Unlike
    // Ticketmaster, the stored source_url IS ALREADY the full Impact.com
    // tracked affiliate link (goto.ticketnetwork.com/...), so this needs no
    // extra wrapping, same as SeatGeek's link above.
    ticketnetwork: {
      name: 'TicketNetwork',
      domain: 'ticketnetwork.com',
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
    // No fixed `domain` — the official site is a different URL per event,
    // so there's no single logo to show for it.
    official: {
      name: 'Official Site',
      domain: null,
      buildUrl: (url) => url || null,
    },
    // Manually curated attraction listings (Rockefeller Center) — see
    // backend/src/services/curatedAttractions.js. The stored source_url is
    // already a full Impact.com tracked affiliate link (therockefellercenter.pxf.io/...),
    // same as TicketNetwork's, so it needs no extra wrapping.
    curated: {
      name: 'Rockefeller Center',
      domain: 'rockefellercenter.com',
      buildUrl: (url) => url || 'https://www.rockefellercenter.com',
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
      // A small favicon-style badge for the retailer's own site, next to
      // its name on the "Buy Your Ticket on ___" button — using Google's
      // public favicon service rather than hosting a copy of each
      // retailer's logo ourselves (no trademark/asset-licensing question,
      // and it stays in sync if a retailer ever changes its icon). No logo
      // for the official-site link since that's a different domain per
      // event, not one fixed retailer.
      logoUrl: sourceMeta[o.source].domain
        ? `https://www.google.com/s2/favicons?domain=${sourceMeta[o.source].domain}&sz=64`
        : null,
      url: sourceMeta[o.source].buildUrl(o.source_url),
      minPrice: o.source === 'official' ? null : o.min_price,
      maxPrice: o.source === 'official' ? null : o.max_price,
      isBest: event.best_source ? o.source === event.best_source : false,
      dotColor: SOURCE_DOT_COLOR[o.source] || '#999',
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
//
// Concerts and Theater & Comedy stay single combined tiles (their
// `category`/`keywords` OR'd together — see backend/src/routes/events.js's
// long comment on categorySql/keywordsSql for why OR, not AND). The single
// catch-all "Sports" tile (2026-09) was split back out into 5 league-specific
// tiles (NFL/NBA/NHL/MLB/MLS) per request — each just sets `keywords` (no
// `category`, same as the old NFL/NBA tiles), matched with word-boundary
// regex server-side (see keywordsSql) so e.g. "NFL" can't false-positive
// inside another word. `tagline` and `icon` are the design's short
// descriptor + icon key for each card (see CategoryTiles) — there's no
// per-league icon art yet, so every league tile reuses the generic 'sports'
// icon rather than leaving new tiles unstyled; swap in dedicated league
// icons in CategoryIcon later if desired. Keep backend/src/routes/events.js's
// DISCOVER_CATEGORY_RULES in sync with this list (its own comment explains
// why) so the homepage's "Popular near you"-style sections split sports the
// same way these tiles do.
// NBA team roster for the "NBA" category tile's own sub-page (see
// TeamTiles below) — clicking NBA doesn't filter the main grid directly
// like the other tiles; it opens this list of all 30 franchises first, and
// picking one filters events by that team's name (reusing the plain
// search mechanism — searchInput/activeSearch — since a team name is a
// perfectly good, already-supported search query and needs no backend
// changes).
const NBA_TEAMS = [
  'Atlanta Hawks', 'Boston Celtics', 'Brooklyn Nets', 'Charlotte Hornets',
  'Chicago Bulls', 'Cleveland Cavaliers', 'Dallas Mavericks', 'Denver Nuggets',
  'Detroit Pistons', 'Golden State Warriors', 'Houston Rockets', 'Indiana Pacers',
  'Los Angeles Clippers', 'Los Angeles Lakers', 'Memphis Grizzlies', 'Miami Heat',
  'Milwaukee Bucks', 'Minnesota Timberwolves', 'New Orleans Pelicans', 'New York Knicks',
  'Oklahoma City Thunder', 'Orlando Magic', 'Philadelphia 76ers', 'Phoenix Suns',
  'Portland Trail Blazers', 'Sacramento Kings', 'San Antonio Spurs', 'Toronto Raptors',
  'Utah Jazz', 'Washington Wizards',
];

// NFL team roster for the "NFL" category tile's own sub-page — same
// mechanism as NBA_TEAMS above (see its comment for how TeamTiles/
// handleSelectTeam use this).
const NFL_TEAMS = [
  'Baltimore Ravens', 'Buffalo Bills', 'Cincinnati Bengals', 'Cleveland Browns',
  'Denver Broncos', 'Houston Texans', 'Indianapolis Colts', 'Jacksonville Jaguars',
  'Kansas City Chiefs', 'Las Vegas Raiders', 'Los Angeles Chargers', 'Miami Dolphins',
  'New England Patriots', 'New York Jets', 'Pittsburgh Steelers', 'Tennessee Titans',
  'Arizona Cardinals', 'Atlanta Falcons', 'Carolina Panthers', 'Chicago Bears',
  'Dallas Cowboys', 'Detroit Lions', 'Green Bay Packers', 'Los Angeles Rams',
  'Minnesota Vikings', 'New Orleans Saints', 'New York Giants', 'Philadelphia Eagles',
  'San Francisco 49ers', 'Seattle Seahawks', 'Tampa Bay Buccaneers', 'Washington Commanders',
];

// NHL team roster for the "NHL" category tile's own sub-page — same
// mechanism as NBA_TEAMS/NFL_TEAMS above.
const NHL_TEAMS = [
  'Boston Bruins', 'Buffalo Sabres', 'Carolina Hurricanes', 'Columbus Blue Jackets',
  'Detroit Red Wings', 'Florida Panthers', 'Montreal Canadiens', 'New Jersey Devils',
  'New York Islanders', 'New York Rangers', 'Ottawa Senators', 'Philadelphia Flyers',
  'Pittsburgh Penguins', 'Tampa Bay Lightning', 'Toronto Maple Leafs', 'Washington Capitals',
  'Anaheim Ducks', 'Arizona Coyotes', 'Calgary Flames', 'Chicago Blackhawks',
  'Colorado Avalanche', 'Dallas Stars', 'Edmonton Oilers', 'Los Angeles Kings',
  'Minnesota Wild', 'Nashville Predators', 'San Jose Sharks', 'St Louis Blues',
  'Utah Hockey Club', 'Vancouver Canucks', 'Vegas Golden Knights', 'Winnipeg Jets',
];

// MLB team roster for the "MLB" category tile's own sub-page — same
// mechanism as NBA_TEAMS/NFL_TEAMS/NHL_TEAMS above.
const MLB_TEAMS = [
  'Arizona Diamondbacks', 'Athletics', 'Atlanta Braves', 'Baltimore Orioles',
  'Boston Red Sox', 'Chicago Cubs', 'Chicago White Sox', 'Cincinnati Reds',
  'Cleveland Guardians', 'Colorado Rockies', 'Detroit Tigers', 'Houston Astros',
  'Kansas City Royals', 'Los Angeles Angels', 'Los Angeles Dodgers', 'Miami Marlins',
  'Milwaukee Brewers', 'Minnesota Twins', 'New York Mets', 'New York Yankees',
  'Philadelphia Phillies', 'Pittsburgh Pirates', 'San Diego Padres', 'San Francisco Giants',
  'Seattle Mariners', 'St. Louis Cardinals', 'Tampa Bay Rays', 'Texas Rangers',
  'Toronto Blue Jays', 'Washington Nationals',
];

// MLS team roster for the "MLS" category tile's own sub-page — same
// mechanism as NBA_TEAMS/NFL_TEAMS/NHL_TEAMS/MLB_TEAMS above.
const MLS_TEAMS = [
  'Atlanta United FC', 'Chicago Fire FC', 'FC Cincinnati', 'Columbus Crew SC',
  'D.C. United', 'Inter Miami CF', 'Montreal Impact', 'Nashville SC',
  'New England Revolution', 'New York City FC', 'New York Red Bulls', 'Orlando City SC',
  'Philadelphia Union', 'Toronto FC',
  'Colorado Rapids', 'FC Dallas', 'Houston Dynamo', 'LA Galaxy',
  'Los Angeles FC', 'Minnesota United FC', 'Portland Timbers', 'Real Salt Lake',
  'San Jose Earthquakes', 'Seattle Sounders FC', 'Sporting Kansas City', 'Vancouver Whitecaps FC',
];

// Major-city roster for the "Cities" category tile's own sub-page — same
// mechanism as the league team rosters above (see TeamTiles/
// handleSelectCity), except picking a city runs its name through the
// location filter (activeLocation, ILIKE against city/state/venue_name on
// the backend) instead of the plain search box, and also opens the city
// hero banner (see CityHeroBanner) above the events grid.
const POPULAR_CITIES = [
  { name: 'Albany', state: 'NY' },
  { name: 'Albuquerque', state: 'NM' },
  { name: 'Anaheim', state: 'CA' },
  { name: 'Atlanta', state: 'GA' },
  { name: 'Atlantic City', state: 'NJ' },
  { name: 'Austin', state: 'TX' },
  { name: 'Baltimore', state: 'MD' },
  { name: 'Birmingham', state: 'AL' },
  { name: 'Bloomington', state: 'IN' },
  { name: 'Boston', state: 'MA' },
  { name: 'Buffalo', state: 'NY' },
  { name: 'Charleston', state: 'SC' },
  { name: 'Charlotte', state: 'NC' },
  { name: 'Chicago', state: 'IL' },
  { name: 'Cincinnati', state: 'OH' },
  { name: 'Cleveland', state: 'OH' },
  { name: 'Columbia', state: 'SC' },
  { name: 'Columbus', state: 'OH' },
  { name: 'Dallas', state: 'TX' },
  { name: 'Denver', state: 'CO' },
  { name: 'Detroit', state: 'MI' },
  { name: 'Durham', state: 'NC' },
  { name: 'El Paso', state: 'TX' },
  { name: 'Fort Worth', state: 'TX' },
  { name: 'Fresno', state: 'CA' },
  { name: 'Grand Rapids', state: 'MI' },
  { name: 'Greensboro', state: 'NC' },
  { name: 'Honolulu', state: 'HI' },
  { name: 'Houston', state: 'TX' },
  { name: 'Indianapolis', state: 'IN' },
  { name: 'Jacksonville', state: 'FL' },
  { name: 'Kansas City', state: 'MO' },
  { name: 'Knoxville', state: 'TN' },
  { name: 'Las Vegas', state: 'NV' },
  { name: 'Lexington', state: 'KY' },
  { name: 'Los Angeles', state: 'CA' },
  { name: 'Louisville', state: 'KY' },
  { name: 'Madison', state: 'WI' },
  { name: 'Memphis', state: 'TN' },
  { name: 'Mesa', state: 'AZ' },
  { name: 'Miami', state: 'FL' },
  { name: 'Milwaukee', state: 'WI' },
  { name: 'Minneapolis', state: 'MN' },
  { name: 'Nashville', state: 'TN' },
  { name: 'New Orleans', state: 'LA' },
  { name: 'New York', state: 'NY' },
  { name: 'Newark', state: 'NJ' },
  { name: 'Norfolk', state: 'VA' },
  { name: 'Oakland', state: 'CA' },
  { name: 'Oklahoma City', state: 'OK' },
  { name: 'Omaha', state: 'NE' },
  { name: 'Orlando', state: 'FL' },
  { name: 'Philadelphia', state: 'PA' },
  { name: 'Phoenix', state: 'AZ' },
  { name: 'Pittsburgh', state: 'PA' },
  { name: 'Portland', state: 'OR' },
  { name: 'Raleigh', state: 'NC' },
  { name: 'Reno', state: 'NV' },
  { name: 'Richmond', state: 'VA' },
  { name: 'Rochester', state: 'NY' },
  { name: 'Sacramento', state: 'CA' },
  { name: 'Salt Lake City', state: 'UT' },
  { name: 'San Antonio', state: 'TX' },
  { name: 'San Diego', state: 'CA' },
  { name: 'San Francisco', state: 'CA' },
  { name: 'San Jose', state: 'CA' },
  { name: 'Scottsdale', state: 'AZ' },
  { name: 'Seattle', state: 'WA' },
  { name: 'Springfield', state: 'IL' },
  { name: 'St. Louis', state: 'MO' },
  { name: 'Syracuse', state: 'NY' },
  { name: 'Tacoma', state: 'WA' },
  { name: 'Tampa', state: 'FL' },
  { name: 'Tempe', state: 'AZ' },
  { name: 'Tucson', state: 'AZ' },
  { name: 'Tulsa', state: 'OK' },
  { name: 'Virginia Beach', state: 'VA' },
  { name: 'Washington', state: 'DC' },
];

// Major-venue roster for the "Venues" category tile's own sub-page — same
// mechanism as POPULAR_CITIES above (see TeamTiles/handleSelectVenue),
// except picking a venue runs its name through the location filter
// (activeLocation, ILIKE against city/state/venue_name on the backend —
// venue_name is already one of the three columns it matches, so this needs
// no backend changes) instead of the plain search box, and opens a venue
// hero banner (see the venues branch next to CityHeroBanner) above the
// events grid.
const POPULAR_VENUES = [
  { name: 'Madison Square Garden', city: 'New York', state: 'NY' },
  { name: 'Barclays Center', city: 'Brooklyn', state: 'NY' },
  { name: 'United Center', city: 'Chicago', state: 'IL' },
  { name: 'Crypto.com Arena', city: 'Los Angeles', state: 'CA' },
  { name: 'Chase Center', city: 'San Francisco', state: 'CA' },
  { name: 'TD Garden', city: 'Boston', state: 'MA' },
  { name: 'Wells Fargo Center', city: 'Philadelphia', state: 'PA' },
  { name: 'State Farm Arena', city: 'Atlanta', state: 'GA' },
  { name: 'American Airlines Center', city: 'Dallas', state: 'TX' },
  { name: 'Toyota Center', city: 'Houston', state: 'TX' },
  { name: 'Golden 1 Center', city: 'Sacramento', state: 'CA' },
  { name: 'Ball Arena', city: 'Denver', state: 'CO' },
  { name: 'T-Mobile Arena', city: 'Las Vegas', state: 'NV' },
  { name: 'Climate Pledge Arena', city: 'Seattle', state: 'WA' },
  { name: 'Little Caesars Arena', city: 'Detroit', state: 'MI' },
  { name: 'Fiserv Forum', city: 'Milwaukee', state: 'WI' },
  { name: 'Kia Center', city: 'Orlando', state: 'FL' },
  { name: 'Footprint Center', city: 'Phoenix', state: 'AZ' },
  { name: 'Moda Center', city: 'Portland', state: 'OR' },
  { name: 'Bridgestone Arena', city: 'Nashville', state: 'TN' },
  { name: 'PPG Paints Arena', city: 'Pittsburgh', state: 'PA' },
  { name: 'Scotiabank Arena', city: 'Toronto', state: 'ON' },
  { name: 'Bell Centre', city: 'Montreal', state: 'QC' },
  { name: 'SoFi Stadium', city: 'Inglewood', state: 'CA' },
  { name: 'MetLife Stadium', city: 'East Rutherford', state: 'NJ' },
  { name: 'AT&T Stadium', city: 'Arlington', state: 'TX' },
  { name: 'Lambeau Field', city: 'Green Bay', state: 'WI' },
  { name: 'Arrowhead Stadium', city: 'Kansas City', state: 'MO' },
  { name: 'Allegiant Stadium', city: 'Las Vegas', state: 'NV' },
  { name: 'Mercedes-Benz Stadium', city: 'Atlanta', state: 'GA' },
  { name: 'Gillette Stadium', city: 'Foxborough', state: 'MA' },
  { name: 'Levi’s Stadium', city: 'Santa Clara', state: 'CA' },
  { name: 'Soldier Field', city: 'Chicago', state: 'IL' },
  { name: 'Red Rocks Amphitheatre', city: 'Morrison', state: 'CO' },
  { name: 'Hollywood Bowl', city: 'Los Angeles', state: 'CA' },
  { name: 'Radio City Music Hall', city: 'New York', state: 'NY' },
  { name: 'The Kia Forum', city: 'Inglewood', state: 'CA' },
  { name: 'Ryman Auditorium', city: 'Nashville', state: 'TN' },
  { name: 'Fenway Park', city: 'Boston', state: 'MA' },
  { name: 'Wrigley Field', city: 'Chicago', state: 'IL' },
  { name: 'Dodger Stadium', city: 'Los Angeles', state: 'CA' },
];

// Full state/province names for the two-letter codes used in POPULAR_CITIES —
// used to build a "{City}, {State}" query for Wikipedia, which resolves
// correctly for cities whose bare name is ambiguous or shared with other
// places (Columbia, Charleston, Springfield, Bloomington, Portland, etc.)
// instead of landing on a disambiguation page or the wrong city's article.
const US_STATE_NAMES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri',
  MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio',
  OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  DC: 'District of Columbia', ON: 'Ontario', QC: 'Quebec',
};

// A handful of POPULAR_CITIES entries whose real Wikipedia article title
// doesn't follow the plain "{City}, {State}" pattern the helper above
// builds — keyed by "{name}|{state}" so a same-named city in a different
// state (there are none in POPULAR_CITIES today, but this keeps it safe)
// isn't accidentally matched.
const CITY_WIKIPEDIA_TITLE_OVERRIDES = {
  'Washington|DC': 'Washington, D.C.',
  'New York|NY': 'New York City',
};

function cityWikipediaTitle(city) {
  const override = CITY_WIKIPEDIA_TITLE_OVERRIDES[`${city.name}|${city.state}`];
  if (override) return override;
  const stateName = US_STATE_NAMES[city.state];
  return stateName ? `${city.name}, ${stateName}` : city.name;
}

// A few POPULAR_VENUES entries whose Wikipedia article title differs from
// the venue's common/marketing name.
const VENUE_WIKIPEDIA_TITLE_OVERRIDES = {
  'The Kia Forum': 'Kia Forum',
};

// Shared photo-lookup helper for the city/venue hero banners and the
// per-category fallback images, backed by Wikipedia's public, key-free,
// CORS-enabled REST API. Tries the direct page-summary endpoint first
// (fast path — works whenever `query` is already the exact article title);
// if that 404s, lands on a disambiguation page, or has no image, falls back
// to MediaWiki's public search API to resolve the best-matching real
// article title and re-queries the summary endpoint with that title. This
// is what makes lookups reliable for ambiguous city names and venue names
// that don't exactly match their Wikipedia title. Best-effort throughout —
// any failure just resolves to null, and callers fall back to a plain
// gradient background rather than showing anything broken.
async function fetchWikipediaImage(query) {
  const summaryUrl = (title) =>
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;

  try {
    const directRes = await fetch(summaryUrl(query));
    if (directRes.ok) {
      const data = await directRes.json();
      if (data && data.type !== 'disambiguation') {
        const url = data.originalimage?.source || data.thumbnail?.source || null;
        if (url) return url;
      }
    }
  } catch {
    // network error on the direct lookup — fall through to the search fallback
  }

  try {
    const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&origin=*&srlimit=1`;
    const searchRes = await fetch(searchUrl);
    if (!searchRes.ok) return null;
    const searchData = await searchRes.json();
    const bestTitle = searchData?.query?.search?.[0]?.title;
    if (!bestTitle) return null;
    const fallbackRes = await fetch(summaryUrl(bestTitle));
    if (!fallbackRes.ok) return null;
    const fallbackData = await fallbackRes.json();
    if (!fallbackData || fallbackData.type === 'disambiguation') return null;
    return fallbackData.originalimage?.source || fallbackData.thumbnail?.source || null;
  } catch {
    return null;
  }
}

const EVENT_CATEGORIES = [
  {
    id: 'concerts',
    label: 'Concerts',
    tagline: 'Live Music. Bigger Together.',
    icon: 'music',
    category: ['Music', 'Concert'],
  },
  {
    id: 'nfl',
    label: 'NFL',
    tagline: 'Every Sunday. Bigger Stakes.',
    icon: 'sports',
    keywords: ['NFL'],
    teams: NFL_TEAMS,
    // Not a franchise, so not in NFL_TEAMS — these run through the exact
    // same search-based mechanism (see TeamTiles/handleSelectTeam) since a
    // plain keyword search already does the right thing for them (e.g.
    // "Super Bowl" matches any event titled/described with that phrase).
    otherEvents: ['NFL Playoffs', 'NFL Preseason', 'NFL International Series', 'NFL Pro Bowl', 'Super Bowl'],
  },
  {
    id: 'nba',
    label: 'NBA',
    tagline: 'Every Basket. Bigger Moments.',
    icon: 'sports',
    keywords: ['NBA', 'Basketball'],
    teams: NBA_TEAMS,
  },
  {
    id: 'nhl',
    label: 'NHL',
    tagline: 'Every Shift. Bigger Battles.',
    icon: 'sports',
    keywords: ['NHL', 'Hockey'],
    teams: NHL_TEAMS,
    otherEvents: ['NHL All-Star Game', 'Winter Classic', 'Stanley Cup Playoffs'],
    otherEventsLabel: 'Additional Events',
  },
  {
    id: 'mlb',
    label: 'MLB',
    tagline: 'Every Pitch. Bigger Stakes.',
    icon: 'sports',
    keywords: ['MLB', 'Baseball'],
    teams: MLB_TEAMS,
  },
  {
    id: 'mls',
    label: 'MLS',
    tagline: 'Every Match. Bigger Rivalries.',
    icon: 'sports',
    keywords: ['MLS', 'Soccer'],
    teams: MLS_TEAMS,
    otherEvents: ['MLS All-Star Game', 'MLS Playoffs'],
    otherEventsLabel: 'Additional Events',
  },
  {
    id: 'boxing',
    label: 'Boxing',
    tagline: 'Every Round. Bigger Fights.',
    icon: 'sports',
    keywords: ['Boxing'],
  },
  {
    id: 'theater',
    label: 'Theater & Comedy',
    tagline: 'Bold Stories. Bigger Laughs.',
    icon: 'theater',
    category: ['Arts & Theatre'],
    keywords: ['Comedy', 'Stand-Up', 'Stand Up'],
  },
  {
    id: 'cities',
    label: 'Cities',
    tagline: 'Every City. Bigger Lineup.',
    icon: 'city',
    cities: POPULAR_CITIES,
  },
  {
    id: 'venues',
    label: 'Venues',
    tagline: 'Every Venue. Bigger Nights.',
    icon: 'venue',
    venues: POPULAR_VENUES,
  },
];

// Fallback event-card photo, used whenever a listing has no image_url of
// its own (common for TicketNetwork catalog rows, which carry no photo at
// all) — a real, high-quality photo of the right kind of event (concert
// crowd, basketball game, theater curtain, etc.) instead of a blank gray
// box. One Wikipedia article title per bucket, chosen for a strong,
// representative lead photo; the actual image URL is resolved once per
// bucket at app load (see categoryFallbackImages in the main App
// component) via the same public, key-free Wikipedia REST summary API
// already used for the Cities hero banner (api.wikipedia.org/.../summary),
// then reused for every card in that bucket rather than fetched per event.
const EVENT_IMAGE_TOPICS = {
  nba: 'Basketball',
  nfl: 'American football',
  nhl: 'Ice hockey',
  mlb: 'Baseball',
  mls: 'Association football',
  boxing: 'Boxing',
  theater: 'Theatre',
  comedy: 'Stand-up comedy',
  sports: 'Stadium',
  concerts: 'Concert',
};

// Bundled, hand-picked photos (frontend/public/event-fallback-images/) for
// the buckets the user supplied a reference image for — served locally
// instead of fetched from Wikipedia, so these five buckets always show
// exactly that photo rather than whatever REST API resolves. Concerts and
// Theater get more than one variant (matching the reference mockup, which
// used two different photos per bucket) so a page full of concert or
// theater cards isn't the same photo repeated; pickFallbackImage below
// picks one deterministically per event so a given event's card doesn't
// change photo on every re-render. Buckets not listed here (nhl, mlb, mls,
// boxing, sports) keep using the Wikipedia-resolved categoryFallbackImages
// — no reference photo was supplied for those.
const LOCAL_FALLBACK_IMAGES = {
  concerts: [
    '/event-fallback-images/concert-1.jpg',
    '/event-fallback-images/concert-2.jpg',
    '/event-fallback-images/concert-3.jpg',
  ],
  nba: ['/event-fallback-images/basketball.jpg'],
  nfl: ['/event-fallback-images/football.jpg'],
  theater: [
    '/event-fallback-images/theater-1.jpg',
    '/event-fallback-images/theater-2.jpg',
  ],
  comedy: ['/event-fallback-images/comedy.jpg'],
};

// Guesses which EVENT_IMAGE_TOPICS bucket an event belongs to from its
// title/artist/venue text and its raw `category` column — reusing the same
// team rosters and league keywords the league tiles already match against
// (see CategoryTiles/EVENT_CATEGORIES above), so an event that would land
// under the NBA tile also gets a basketball photo, etc. Falls back to a
// generic "sports" photo for a sport with no dedicated bucket (tennis,
// golf, motorsports, wrestling, MMA, ...), then to a concert photo as the
// last resort for anything else (the most common event type on the site).
function guessEventImageTopic(event) {
  const haystack = `${event.title || ''} ${event.artist_name || ''} ${event.venue_name || ''}`.toLowerCase();
  const categoryStr = (Array.isArray(event.category) ? event.category.join(' ') : (event.category || '')).toLowerCase();

  if (/\bcomedy\b|\bstand-up\b|\bstand up\b/.test(haystack)) return 'comedy';
  if (/\bnba\b|\bbasketball\b/.test(haystack) || NBA_TEAMS.some((t) => haystack.includes(t.toLowerCase()))) return 'nba';
  if (/\bnfl\b/.test(haystack) || NFL_TEAMS.some((t) => haystack.includes(t.toLowerCase()))) return 'nfl';
  if (/\bnhl\b|\bhockey\b/.test(haystack) || NHL_TEAMS.some((t) => haystack.includes(t.toLowerCase()))) return 'nhl';
  if (/\bmlb\b|\bbaseball\b/.test(haystack) || MLB_TEAMS.some((t) => haystack.includes(t.toLowerCase()))) return 'mlb';
  if (/\bmls\b|\bsoccer\b/.test(haystack) || MLS_TEAMS.some((t) => haystack.includes(t.toLowerCase()))) return 'mls';
  if (/\bboxing\b/.test(haystack)) return 'boxing';
  if (categoryStr.includes('theatre') || categoryStr.includes('theater') || /\btheatre\b|\btheater\b/.test(haystack)) return 'theater';
  if (categoryStr.includes('sport')) return 'sports';
  return 'concerts';
}

// Picks the fallback photo for an event: a bundled local photo when its
// bucket has one (see LOCAL_FALLBACK_IMAGES), chosen deterministically from
// that bucket's variants by hashing the event's own id/title (so the same
// event always gets the same photo, but different events in the bucket
// don't all show the identical picture); otherwise the Wikipedia-resolved
// photo for that bucket, falling back further to the concert photo if that
// bucket's own fetch hasn't resolved yet (or ever fails) — so a card never
// sits with no image at all once any bucket has loaded.
function pickFallbackImage(event, categoryFallbackImages) {
  const topic = guessEventImageTopic(event);
  const localVariants = LOCAL_FALLBACK_IMAGES[topic];
  if (localVariants && localVariants.length > 0) {
    const seed = String(event.id ?? event.title ?? '');
    let hash = 0;
    for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
    return localVariants[hash % localVariants.length];
  }
  return categoryFallbackImages[topic] || categoryFallbackImages.concerts || null;
}

// Shared accent across the redesigned homepage (nav underline, category
// card icons/hover, search button, event-card arrow button, etc.) — a
// bright blue against the new dark-navy page background, matching the
// reference design. --cm-accent-blue in App.css is the same value; kept
// as a JS constant too since most of the homepage is still styled inline.
// Pixel-sampled directly from the reference mockup image (patch-mode most-
// common-color sampling in small regions, to avoid anti-aliasing/glyph
// interference) rather than approximated by eye, per the "pixel by pixel /
// every color" request.
const NAV_ACCENT_COLOR = '#008efe';
const NAV_ACCENT_LIGHT = '#4fb8ff';
// Exact background color of the CM logo artwork (public/brand/logo-icon.jpg),
// sampled pixel-by-pixel from a corner of the source image — reused for the
// event card's "Find Your Ticket" button per the reference request.
const LOGO_BG_COLOR = '#d1f903';
// Exact reference-palette values sampled from the supplied homepage image.
const NAVY_BG = '#001634';
const NAVY_PANEL = '#01214a';
const NAVY_PANEL_LIGHT = '#0a2a5c';
const NAVY_BORDER = '#0c4c89';

// Small line-style icon set for the category cards below — plain inline
// SVG (no icon-font dependency) so each renders crisply inside the blue
// icon circle at any size, matching the reference design's clean line
// icons instead of emoji.
// Solid/filled glyphs (not outline strokes) matching the reference design's
// category icons: a filled music note, a basketball with its seam lines, a
// pair of comedy/tragedy theater masks, and a filled microphone — all in a
// single flat accent-blue fill, sitting directly on the card (no circular
// badge behind them, per the reference).
function CategoryIcon({ icon, size = 22, color = NAV_ACCENT_LIGHT }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': true };
  switch (icon) {
    case 'music':
      return (
        <svg {...common} fill={color}>
          <path d="M9 3v11.35A4 4 0 1 0 11 18V8h6V3H9zm2 15a2 2 0 1 1 0-4 2 2 0 0 1 0 4z" />
        </svg>
      );
    case 'sports':
      return (
        <svg {...common} fill="none" stroke={color} strokeWidth={1.6}>
          <circle cx="12" cy="12" r="9" fill={color} fillOpacity="0.18" />
          <circle cx="12" cy="12" r="9" />
          <path d="M12 3v18M3 12h18M5.6 5.6c2.1 2.6 2.1 10.2 0 12.8M18.4 5.6c-2.1 2.6-2.1 10.2 0 12.8" />
        </svg>
      );
    case 'theater':
      return (
        <svg {...common} fill={color}>
          <path d="M3.5 4.2c3 .6 5.3 3.1 5.3 6.1 0 2.6-1.7 4.8-4.1 5.6.3-1 .3-2.1-.1-3.1-.5-1.3-.2-2.6.5-3.7-1-.3-1.9-1-2.5-1.9-.6-1-.8-2-.4-3l.1-.3a3 3 0 0 1 1.2.3z" />
          <circle cx="4.6" cy="9.2" r="0.7" fill={NAVY_BG} />
          <path d="M4.9 13.2c.6.5 1.4.7 2.1.5" fill="none" stroke={NAVY_BG} strokeWidth="0.7" strokeLinecap="round" />
          <path d="M20.5 4.2c-3 .6-5.3 3.1-5.3 6.1 0 2.6 1.7 4.8 4.1 5.6-.3-1-.3-2.1.1-3.1.5-1.3.2-2.6-.5-3.7 1-.3 1.9-1 2.5-1.9.6-1 .8-2 .4-3l-.1-.3a3 3 0 0 0-1.2.3z" />
          <circle cx="19.4" cy="9.2" r="0.7" fill={NAVY_BG} />
          <path d="M17.4 12.6c.4.7 1.1 1.2 1.9 1.3" fill="none" stroke={NAVY_BG} strokeWidth="0.7" strokeLinecap="round" />
        </svg>
      );
    case 'city':
      return (
        <svg {...common} fill={color}>
          <path d="M3 20V9l5-3v3l4-2.5V9l4-2.5V20H3zm2-2h2v-2H5v2zm0-4h2v-2H5v2zm4 4h2v-2H9v2zm0-4h2v-2H9v2zm4 4h2v-2h-2v2zm0-4h2v-2h-2v2zm4 4h2v-2h-2v2z" />
        </svg>
      );
    case 'venue':
      return (
        <svg {...common} fill="none" stroke={color} strokeWidth={1.6}>
          <path d="M4 21V9.5L12 4l8 5.5V21" fill={color} fillOpacity="0.18" />
          <path d="M4 21V9.5L12 4l8 5.5V21M9 21v-6h6v6" />
        </svg>
      );
    case 'comedy':
      return (
        <svg {...common} fill={color}>
          <path d="M12.5 12.1c1.1-1.6 3-2.6 5.1-2.4 1.6.1 3 .9 4 2 .5.6 0 1.6-.8 1.5-1.4-.2-2.8.2-3.8 1.1-1.6 1.4-2.2 3.6-1.6 5.6.2.8-.7 1.5-1.4.9a8.6 8.6 0 0 1-1.5-8.7z" />
          <circle cx="17.3" cy="11.4" r="0.9" fill={NAVY_BG} />
          <circle cx="20.1" cy="12.4" r="0.9" fill={NAVY_BG} />
          <path d="M11.5 12.1c-1.1-1.6-3-2.6-5.1-2.4-1.6.1-3 .9-4 2-.5.6 0 1.6.8 1.5 1.4-.2 2.8.2 3.8 1.1 1.6 1.4 2.2 3.6 1.6 5.6-.2.8.7 1.5 1.4.9a8.6 8.6 0 0 0 1.5-8.7z" />
          <circle cx="6.7" cy="11.4" r="0.9" fill={NAVY_BG} />
          <circle cx="3.9" cy="12.4" r="0.9" fill={NAVY_BG} />
        </svg>
      );
    default:
      return null;
  }
}

// Popular-categories row: 4 dark-navy cards (icon, label, short tagline,
// circular arrow button), replacing the old 6-tile flat-white grid. Same
// filtering behavior as before (onSelect toggles activeCategoryId and
// scrolls to the results grid) — only the visual treatment changed, to
// match the new design's category cards.
function CategoryTiles({ activeCategoryId, onSelect, teamsBrowseCategoryId, onToggleTeams }) {
  return (
    <div
      className="cm-category-grid"
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap: '16px',
        marginBottom: '20px',
      }}>
      {EVENT_CATEGORIES.map((cat) => {
        // A tile with its own `teams` roster (all five league tiles) opens
        // the TeamTiles sub-page below AND filters the main grid to that
        // league's events (closest-first, same distance sort every other
        // category tile already gets — see fetchEvents's lat/lng handling)
        // — so a visitor sees NBA games near them immediately, without
        // having to also pick a specific team first. Picking a team then
        // narrows further (see handleSelectTeam: it layers a team-name
        // search on top of this same league filter). isActive tracks
        // teamsBrowseCategoryId for these tiles (not activeCategoryId
        // directly) only so the tile stays highlighted while browsing
        // teams even though activeCategoryId is also set to the same id.
        const hasTeams = Boolean(cat.teams || cat.cities || cat.venues);
        const isActive = hasTeams ? teamsBrowseCategoryId === cat.id : activeCategoryId === cat.id;
        return (
          <button
            key={cat.id}
            type="button"
            className="cm-navy-card"
            onClick={() => {
              if (hasTeams) {
                const next = isActive ? null : cat.id;
                onToggleTeams(next);
                onSelect(next);
                if (next) {
                  // Opening the team picker: scroll to IT, not the events
                  // grid further down — that's the whole point of clicking
                  // a league tile ("directed to the team list"). The panel
                  // doesn't exist in the DOM yet on this same synchronous
                  // click (React hasn't re-rendered), so this is deferred
                  // one tick; closing (next === null) has nothing new to
                  // reveal above the grid, so it keeps scrolling there.
                  setTimeout(() => {
                    document.getElementById('team-tiles')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }, 0);
                  return;
                }
              } else {
                onSelect(isActive ? null : cat.id);
              }
              document.getElementById('featured-events')?.scrollIntoView({ behavior: 'smooth' });
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '14px',
              textAlign: 'left',
              background: isActive ? NAVY_PANEL_LIGHT : NAVY_PANEL,
              border: `1px solid ${isActive ? NAV_ACCENT_COLOR : NAVY_BORDER}`,
              borderRadius: '16px',
              padding: '16px 16px',
              cursor: 'pointer',
            }}>
            <span style={{
              flexShrink: 0,
              width: '46px',
              height: '46px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}>
              <CategoryIcon icon={cat.icon} size={36} />
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontWeight: 800, fontSize: '17px', color: '#fff' }}>{cat.label}</span>
              <span style={{ display: 'block', fontSize: '12.5px', color: 'var(--cm-text-onnavy-muted)', marginTop: '2px' }}>{cat.tagline}</span>
            </span>
            <span
              className="cm-round-btn"
              aria-hidden="true"
              style={{
                flexShrink: 0,
                width: '32px',
                height: '32px',
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: NAVY_BORDER,
                color: '#fff',
                fontSize: '15px',
              }}>
              →
            </span>
          </button>
        );
      })}
    </div>
  );
}

// Team picker shown when a category tile with its own `teams` roster (see
// CategoryTiles above — currently just NBA) is opened. Each team tile runs
// the team's name through the same search box the visitor could type into
// themselves (setSearchInput/setActiveSearch), so results, the "N results
// for '<team>'" line, and the Clear button all work exactly as they
// already do for a typed search — no separate filtering path to maintain.
function TeamTiles({ category, onSelectTeam, onClose }) {
  // The "Cities" and "Venues" tiles carry a `cities`/`venues` roster
  // instead of `teams` — same sub-page shell, but each tile is an object
  // (see POPULAR_CITIES/POPULAR_VENUES) rather than a plain team-name
  // string, and picking one runs through handleSelectCity/handleSelectVenue
  // (location filter + hero banner) instead of handleSelectTeam (plain
  // search).
  const pickerType = category.cities ? 'cities' : category.venues ? 'venues' : 'teams';
  const items = category.cities || category.venues || category.teams;
  return (
    <div
      id="team-tiles"
      className="cm-navy-card"
      style={{
        background: NAVY_PANEL,
        border: `1px solid ${NAVY_BORDER}`,
        borderRadius: '16px',
        padding: '18px 20px',
        marginBottom: '20px',
      }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
        <span style={{ fontWeight: 800, fontSize: '17px', color: '#fff' }}>
          {category.label} — Choose a {pickerType === 'cities' ? 'City' : pickerType === 'venues' ? 'Venue' : 'Team'}
        </span>
        <button
          type="button"
          onClick={onClose}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: NAV_ACCENT_LIGHT, fontWeight: 700, fontSize: '13.5px', padding: 0 }}>
          Close ✕
        </button>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: '10px',
        }}>
        {items.map((item) => {
          const key = pickerType === 'cities' ? `${item.name}-${item.state}`
            : pickerType === 'venues' ? `${item.name}-${item.city}-${item.state}`
            : item;
          const label = pickerType === 'cities' ? `${item.name}, ${item.state}`
            : pickerType === 'venues' ? `${item.name} — ${item.city}, ${item.state}`
            : item;
          return (
            <button
              key={key}
              type="button"
              onClick={() => onSelectTeam(item)}
              style={{
                textAlign: 'left',
                background: NAVY_PANEL_LIGHT,
                border: `1px solid ${NAVY_BORDER}`,
                borderRadius: '10px',
                padding: '12px 14px',
                color: '#fff',
                fontWeight: 600,
                fontSize: '14px',
                cursor: 'pointer',
              }}>
              {label}
            </button>
          );
        })}
      </div>

      {category.otherEvents && category.otherEvents.length > 0 && (
        <>
          <div style={{ fontWeight: 800, fontSize: '14px', color: '#fff', margin: '18px 0 10px' }}>
            {category.otherEventsLabel || 'Other Events'}
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
              gap: '10px',
            }}>
            {category.otherEvents.map((label) => (
              <button
                key={label}
                type="button"
                onClick={() => onSelectTeam(label)}
                style={{
                  textAlign: 'left',
                  background: NAVY_PANEL_LIGHT,
                  border: `1px solid ${NAVY_BORDER}`,
                  borderRadius: '10px',
                  padding: '12px 14px',
                  color: '#fff',
                  fontWeight: 600,
                  fontSize: '14px',
                  cursor: 'pointer',
                }}>
                {label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// A single event card — extracted from the main "Featured Events" grid so
// the event-discovery sections below (Popular/Recommended/Trending/by-
// category) can share the exact same card instead of duplicating this
// markup seven more times.
function EventCard({ event, onSelect, fallbackImageUrl }) {
  const priceLabel = (event.min_price != null || event.max_price != null) ? formatPrice(event) : null;
  const fromPrice = event.min_price != null ? event.min_price : event.max_price;
  // Real event photo (Ticketmaster/SeatGeek) always wins when there is one;
  // otherwise fall back to the resolved category photo (see
  // EVENT_IMAGE_TOPICS/pickFallbackImage) rather than showing nothing.
  const imgSrc = event.image_url || fallbackImageUrl;
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
        {imgSrc ? (
          <img
            src={imgSrc}
            alt={event.title}
            loading="lazy"
            decoding="async"
            style={{ width: '100%', height: '150px', objectFit: 'cover', display: 'block' }}
          />
        ) : (
          // Both the real photo and the category fallback are missing (the
          // fallback fetch hasn't resolved yet, or every bucket failed) —
          // a plain gradient placeholder instead of a blank box.
          <div style={{ width: '100%', height: '150px', background: `linear-gradient(135deg, ${NAVY_PANEL_LIGHT}, ${NAVY_BG})` }} />
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
        <h4 style={{ fontSize: '16px', lineHeight: 1.3, marginBottom: '6px', color: '#141b2d' }}>{event.title}</h4>
        <p style={{ fontSize: '13px', color: '#666', margin: '2px 0' }}>📅 {formatDate(event.date)}</p>
        <p style={{ fontSize: '13px', color: '#666', margin: '2px 0' }}>📍 {event.venue_name ? `${event.venue_name}, ` : ''}{event.city}{event.state ? `, ${event.state}` : ''}</p>
        {formatOffersComparison(event) && (
          <p style={{ fontSize: '12px', color: '#666', margin: '2px 0 10px' }}>
            {formatOffersComparison(event)}
          </p>
        )}
        <div style={{ marginTop: '12px' }}>
          <button
            type="button"
            className="cm-btn"
            aria-label={`Find tickets for ${event.title}`}
            onClick={(e) => { e.stopPropagation(); onSelect(event); }}
            style={{
              width: '100%',
              padding: '11px 16px',
              borderRadius: '10px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              border: 'none',
              backgroundColor: LOGO_BG_COLOR,
              color: '#141b2d',
              fontSize: '14px',
              fontWeight: 800,
              letterSpacing: '0.01em',
            }}>
            Find Your Ticket
          </button>
        </div>
      </div>
    </div>
  );
}

// Platform logo: the official CM emblem artwork (bundled as a static asset
// under public/brand so it's just a plain URL Vite copies through as-is),
// cropped tight to the icon with its own square-ish aspect ratio — callers
// pass a height in `size` and let width follow naturally rather than
// forcing a 1:1 box like the old inline SVG badge did.
function Logo({ size = 36 }) {
  return (
    <img
      src="/brand/logo-icon.jpg"
      alt=""
      aria-hidden="true"
      style={{ height: `${size}px`, width: 'auto', display: 'block', borderRadius: '6px' }}
    />
  );
}

// Logo + site name (+ tagline), clickable to return to the home page from
// anywhere. Tagline uses currentColor at reduced opacity rather than a
// hardcoded light color so this still reads correctly on the plain-page
// (light background) loading/error states that also render BrandLink, not
// just the dark-navy hero.
function BrandLink({ onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="ConcertAndMatches — go to home page"
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
        textAlign: 'left',
      }}>
      <Logo size={38} />
      <span>
        <span style={{ display: 'block', fontWeight: 800, fontSize: '25px', lineHeight: 1.15 }}>ConcertAndMatches.com</span>
      </span>
    </button>
  );
}

// Small line-style social icons for the footer's brand column — plain
// inline SVG, matching the CategoryIcon/CityHero approach elsewhere in the
// file rather than pulling in an icon-font/library dependency.
function FooterSocialIcon({ type }) {
  const common = { width: 16, height: 16, viewBox: '0 0 24 24', 'aria-hidden': true };
  switch (type) {
    case 'facebook':
      return (
        <svg {...common} fill="#fff">
          <path d="M13.5 21v-7.5h2.5l.4-3H13.5V8.4c0-.87.24-1.46 1.5-1.46H16.5V4.34C16.2 4.3 15.2 4.2 14 4.2c-2.4 0-4 1.46-4 4.15V10.5H7.5v3H10V21h3.5z" />
        </svg>
      );
    case 'x':
      return (
        <svg {...common} fill="#fff">
          <path d="M4 4l7.3 9.3L4.4 21H7l5.2-5.9L16.6 21H20l-7.7-9.8L19.3 4h-2.6l-4.8 5.5L8 4H4z" />
        </svg>
      );
    case 'instagram':
      return (
        <svg {...common} fill="none" stroke="#fff" strokeWidth="1.8">
          <rect x="3.5" y="3.5" width="17" height="17" rx="5" />
          <circle cx="12" cy="12" r="4" />
          <circle cx="17.2" cy="6.8" r="1" fill="#fff" stroke="none" />
        </svg>
      );
    case 'youtube':
      return (
        <svg {...common}>
          <rect x="2.5" y="6" width="19" height="12" rx="3" fill="none" stroke="#fff" strokeWidth="1.6" />
          <path d="M10.5 9.5l5 2.5-5 2.5z" fill="#fff" />
        </svg>
      );
    default:
      return null;
  }
}

// Redesigned 4-column footer (Brand / Quick Links / About / Stay Updated)
// plus a bottom bar, matching the reference mockup exactly. onGoHome/
// onSelectCategory/onBrowseSports are supplied by the main App component so
// Quick Links reuses the exact same filtering the homepage's own category
// tiles/nav already use, rather than pointing at dead placeholder routes
// (About's How It Works/FAQ/Contact Us have no page to link to yet, same as
// this footer's Ticket Price Guides/Artists/Venues/Leagues/Teams did before
// this redesign — kept as inert placeholders for the same reason).
function Footer({ onGoHome, onSelectCategory, onBrowseSports }) {
  const [newsletterEmail, setNewsletterEmail] = useState('');
  const [newsletterSubmitted, setNewsletterSubmitted] = useState(false);

  const columnHeadingStyle = { fontSize: '14px', fontWeight: 800, color: '#fff', margin: '0 0 14px' };
  const linkStyle = {
    display: 'block',
    background: 'none',
    border: 'none',
    padding: 0,
    marginBottom: '10px',
    color: 'var(--cm-text-onnavy-muted)',
    textDecoration: 'none',
    fontSize: '13.5px',
    cursor: 'pointer',
    textAlign: 'left',
    font: 'inherit',
  };

  const handleNewsletterSubmit = (e) => {
    e.preventDefault();
    if (!newsletterEmail.trim()) return;
    // No newsletter backend exists yet — this just acknowledges the
    // signup in the UI rather than silently discarding it or pretending
    // to call an endpoint that isn't there.
    setNewsletterSubmitted(true);
    setNewsletterEmail('');
  };

  return (
    <footer id="site-footer" style={{
      marginTop: '48px',
      padding: '40px 32px 24px',
      borderTop: `1px solid ${NAVY_BORDER}`,
      backgroundColor: NAVY_PANEL,
      borderRadius: 'var(--cm-radius)',
      color: 'var(--cm-text-onnavy-muted)',
    }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '32px' }}>
        {/* Brand column */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px' }}>
            <Logo size={30} />
            <span style={{ fontWeight: 800, fontSize: '17px', color: '#fff' }}>ConcertAndMatches</span>
          </div>
          <p style={{ fontSize: '13px', lineHeight: 1.6, margin: '0 0 16px', maxWidth: '260px' }}>
            We help you find the best tickets for your favorite events by comparing leading marketplaces, so you can buy with confidence.
          </p>
          <div style={{ display: 'flex', gap: '10px' }}>
            {['facebook', 'x', 'instagram', 'youtube'].map((type) => (
              <a
                key={type}
                href="#"
                onClick={(e) => e.preventDefault()}
                aria-label={type}
                style={{
                  width: '34px',
                  height: '34px',
                  borderRadius: '50%',
                  backgroundColor: NAVY_PANEL_LIGHT,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}>
                <FooterSocialIcon type={type} />
              </a>
            ))}
          </div>
        </div>

        {/* Quick Links */}
        <div>
          <div style={columnHeadingStyle}>Quick Links</div>
          <button type="button" className="cm-link-underline" style={linkStyle} onClick={onGoHome}>Home</button>
          <button type="button" className="cm-link-underline" style={linkStyle} onClick={() => onSelectCategory('concerts')}>Concerts</button>
          <button type="button" className="cm-link-underline" style={linkStyle} onClick={onBrowseSports}>Sports</button>
          <button type="button" className="cm-link-underline" style={linkStyle} onClick={() => onSelectCategory('theater')}>Theater</button>
          <button type="button" className="cm-link-underline" style={linkStyle} onClick={() => onSelectCategory('theater', 'Comedy')}>Comedy</button>
        </div>

        {/* About */}
        <div>
          <div style={columnHeadingStyle}>About</div>
          <a href="/how-it-works" className="cm-link-underline" style={linkStyle}>How It Works</a>
          <a href="/faq" className="cm-link-underline" style={linkStyle}>FAQ</a>
          <a href="/contact" className="cm-link-underline" style={linkStyle}>Contact Us</a>
          <a href="/privacy.html" className="cm-link-underline" style={linkStyle}>Privacy Policy</a>
          <a href="/terms.html" className="cm-link-underline" style={linkStyle}>Terms of Service</a>
        </div>

        {/* Stay Updated */}
        <div>
          <div style={columnHeadingStyle}>Stay Updated</div>
          <p style={{ fontSize: '13px', margin: '0 0 14px' }}>Get the latest events and deals.</p>
          {newsletterSubmitted ? (
            <p style={{ fontSize: '13px', color: NAV_ACCENT_LIGHT, fontWeight: 700, margin: 0 }}>Thanks — you're on the list!</p>
          ) : (
            <form onSubmit={handleNewsletterSubmit} style={{ display: 'flex', gap: '8px' }}>
              <input
                type="email"
                required
                placeholder="Enter your email address"
                value={newsletterEmail}
                onChange={(e) => setNewsletterEmail(e.target.value)}
                style={{
                  flex: 1,
                  minWidth: 0,
                  padding: '10px 14px',
                  borderRadius: '8px',
                  border: 'none',
                  fontSize: '13px',
                  color: '#1a0733',
                }}
              />
              <button
                type="submit"
                style={{
                  padding: '10px 18px',
                  borderRadius: '8px',
                  border: 'none',
                  backgroundColor: NAV_ACCENT_COLOR,
                  color: '#fff',
                  fontWeight: 700,
                  fontSize: '13px',
                  cursor: 'pointer',
                  flexShrink: 0,
                }}>
                Subscribe
              </button>
            </form>
          )}
        </div>
      </div>

      <p style={{ fontSize: '11.5px', marginTop: '28px', marginBottom: 0 }}>
        ConcertAndMatches is an independent event discovery site and is not affiliated with any ticket seller. We may earn a commission when you buy tickets through links on this site.
      </p>

      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: 'space-between',
        gap: '10px',
        marginTop: '20px',
        paddingTop: '20px',
        borderTop: `1px solid ${NAVY_BORDER}`,
        fontSize: '12px',
      }}>
        <span>© {new Date().getFullYear()} ConcertAndMatches. All rights reserved.</span>
        <span>📍 Madison, WI</span>
      </div>
    </footer>
  );
}

// 4-icon trust strip shown between the results grid and the closing CTA
// banner — reinforces the site's actual value props (multi-marketplace
// comparison, live pricing, no purchase risk since we link out to the
// real seller, human support) in the reference design's icon-row format.
const FEATURE_STRIP_ITEMS = [
  { icon: 'shield', title: 'Compare Top Marketplaces', copy: 'See the best available tickets in one place.' },
  { icon: 'bolt', title: 'Real-Time Availability', copy: 'Up-to-date tickets and pricing.' },
  { icon: 'ticket', title: '100% Secure & Safe', copy: 'Your tickets. Your peace of mind.' },
  { icon: 'people', title: 'Fans First Support', copy: 'Real people. Here to help.' },
];

function FeatureIcon({ icon, size = 20 }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: NAV_ACCENT_LIGHT, strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };
  switch (icon) {
    case 'shield':
      return <svg {...common}><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" /></svg>;
    case 'bolt':
      return <svg {...common}><path d="M13 3 5 14h6l-1 7 8-11h-6l1-7z" /></svg>;
    case 'ticket':
      return <svg {...common}><path d="M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v1.5a1.8 1.8 0 0 0 0 3.6V15a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-1.9a1.8 1.8 0 0 0 0-3.6V8z" /><line x1="14" y1="7" x2="14" y2="17" strokeDasharray="2 2" /></svg>;
    case 'people':
      return <svg {...common}><circle cx="9" cy="8" r="3" /><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" /><circle cx="17" cy="9" r="2.4" /><path d="M15.5 14.2c2.4.4 4.5 2.5 4.5 5.8" /></svg>;
    default:
      return null;
  }
}

function FeatureStrip() {
  return (
    <div className="cm-feature-strip" style={{
      display: 'flex',
      flexWrap: 'wrap',
      gap: '0',
      backgroundColor: NAVY_PANEL,
      border: `1px solid ${NAVY_BORDER}`,
      borderRadius: '16px',
      margin: '24px 0',
      overflow: 'hidden',
    }}>
      {FEATURE_STRIP_ITEMS.map((item, i) => (
        <div
          key={item.title}
          style={{
            flex: '1 1 220px',
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            padding: '18px 20px',
            borderLeft: i === 0 ? 'none' : `1px solid ${NAVY_BORDER}`,
          }}>
          <span style={{
            flexShrink: 0,
            width: '38px',
            height: '38px',
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: NAVY_PANEL_LIGHT,
          }}>
            <FeatureIcon icon={item.icon} />
          </span>
          <span>
            <div style={{ fontWeight: 700, fontSize: '13.5px', color: '#fff' }}>{item.title}</div>
            <div style={{ fontSize: '12px', color: 'var(--cm-text-onnavy-muted)', marginTop: '2px' }}>{item.copy}</div>
          </span>
        </div>
      ))}
    </div>
  );
}

// Outbound-only affiliate promo partners — joined via Impact.com but with
// no product-catalog data feed exposed to affiliates (confirmed for each:
// Pelago 2026-09, Hellotickets/Ticketclub 2026-09-19 via GET
// /admin/diagnostics/impact-catalogs, which lists every catalog visible to
// this account — neither brand appears in it, same as Pelago). Unlike
// TicketNetwork's ~210k-item catalog (services/ticketnetwork.js) or
// Rockefeller Center's small/stable hand-curated set
// (services/curatedAttractions.js), these three have large, constantly-
// changing inventories with no feed to sync from — hand-entering individual
// "events" for them would go stale almost immediately. So each gets a single
// outbound promo card instead (tracked link, so the platform still earns
// commission on click-throughs) rather than being represented as platform
// inventory.
const PARTNER_PROMOS = [
  {
    id: 'pelago',
    eyebrow: 'Partner Experiences',
    title: 'Tours & Activities with Pelago by Singapore Airlines',
    description: 'Book sightseeing tours, attractions, and local experiences in cities worldwide through our partner Pelago.',
    link: 'https://pelago.pxf.io/AgQDoJ',
    cta: 'Explore Pelago →',
  },
  {
    id: 'hellotickets',
    eyebrow: 'Partner Marketplace',
    title: 'Concerts, Sports & Theater Tickets with Hellotickets',
    description: 'Browse and buy tickets to live events worldwide through our partner Hellotickets.',
    link: 'https://hellotickets.sjv.io/B59D91',
    cta: 'Explore Hellotickets →',
  },
  {
    id: 'ticketclub',
    eyebrow: 'Partner Marketplace',
    title: 'Discounted Tickets with Ticketclub',
    description: 'Ticketclub members get access to discounted tickets across sports, concerts, and theater through our partner Ticketclub.',
    link: 'https://ticketclub.pxf.io/E0P5PP',
    cta: 'Explore Ticketclub →',
  },
];

function PartnerPromoBanner() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', margin: '24px 0' }}>
      {PARTNER_PROMOS.map((partner) => (
        <div key={partner.id} className="cm-navy-card" style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '16px',
          backgroundColor: NAVY_PANEL,
          border: `1px solid ${NAVY_BORDER}`,
          borderRadius: '16px',
          padding: '22px 26px',
        }}>
          <div style={{ maxWidth: '560px' }}>
            <div style={{ fontSize: '11.5px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: NAV_ACCENT_LIGHT }}>
              {partner.eyebrow}
            </div>
            <h3 style={{ fontSize: '18px', color: '#fff', margin: '4px 0 0' }}>
              {partner.title}
            </h3>
            <p style={{ color: 'var(--cm-text-onnavy-muted)', fontSize: '13.5px', marginTop: '6px' }}>
              {partner.description}
            </p>
          </div>
          <a
            href={partner.link}
            target="_blank"
            rel="noopener sponsored"
            className="cm-btn"
            style={{
              padding: '12px 22px',
              borderRadius: '999px',
              border: 'none',
              backgroundColor: NAV_ACCENT_COLOR,
              color: '#fff',
              fontWeight: 'bold',
              fontSize: '14px',
              textDecoration: 'none',
              whiteSpace: 'nowrap',
            }}>
            {partner.cta}
          </a>
        </div>
      ))}
    </div>
  );
}

// Closing CTA banner — the same purple/pink concert-crowd photo from the
// reference mockup (cropped from the provided design — see
// public/cta-crowd.jpg) as the background, with the mockup's purple→blue
// gradient layered over it so the text on the left stays readable exactly
// like the reference. onExplore resets any active search/category filters
// and scrolls back up to the results grid.
function CtaBanner({ onExplore }) {
  return (
    <div className="cm-cta-banner" style={{
      position: 'relative',
      overflow: 'hidden',
      borderRadius: '20px',
      margin: '24px 0',
      padding: '40px 28px',
      backgroundImage: 'url(/cta-crowd.jpg)',
      backgroundSize: 'cover',
      backgroundPosition: 'center',
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '20px',
    }}>
      <div aria-hidden="true" style={{ position: 'absolute', inset: 0, background: 'linear-gradient(100deg, #001633 0%, rgba(0,22,51,0.88) 32%, rgba(1,32,74,0.4) 65%, rgba(1,32,74,0.1) 100%)' }} />
      <div style={{ position: 'relative', maxWidth: '520px' }}>
        <h3 style={{ fontSize: 'clamp(22px, 3.4vw, 30px)', color: '#fff', margin: 0, lineHeight: 1.2 }}>
          Your Next Unforgettable <span style={{ color: NAV_ACCENT_LIGHT }}>Event&nbsp;Awaits</span>
        </h3>
        <p style={{ color: '#d9e3f5', marginTop: '8px', fontSize: '14px' }}>More events. More moments. A brighter you.</p>
      </div>
      <button
        type="button"
        className="cm-btn"
        onClick={onExplore}
        style={{
          position: 'relative',
          padding: '14px 26px',
          borderRadius: '999px',
          border: 'none',
          backgroundColor: NAV_ACCENT_COLOR,
          color: '#fff',
          fontWeight: 'bold',
          fontSize: '15px',
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        }}>
        Explore Events →
      </button>
    </div>
  );
}

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const eventIdFromUrl = parseEventIdFromPath(location.pathname);

  // Meta Pixel (see lib/metaPixel.js) — a no-op until VITE_META_PIXEL_ID is
  // set, so this is safe to ship ahead of actually having a Pixel ID.
  // Initializes once, then reports a PageView on every client-side route
  // change (this is a single-page app — the browser never does a real
  // navigation between pages, so without this every page would look like
  // one pageview to Meta).
  useEffect(() => {
    initMetaPixel();
  }, []);
  useEffect(() => {
    trackMetaPageView();
  }, [location.pathname]);

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
  // Which category's team picker (see TeamTiles) is currently open — only
  // set for tiles that have their own `teams` roster (currently just NBA).
  const [teamsBrowseCategoryId, setTeamsBrowseCategoryId] = useState(null);
  // The { name, state } picked from the Cities tile (see POPULAR_CITIES /
  // handleSelectCity) — drives the city hero banner above the events grid.
  // Separate from activeLocation (which drives the actual filter) because
  // activeLocation can also come from the plain Location search field, and
  // the hero banner should only show for a tile-picked city, not a typed
  // location.
  const [selectedCity, setSelectedCity] = useState(null);
  const [cityImageUrl, setCityImageUrl] = useState(null);
  // Same pair as selectedCity/cityImageUrl above, for the Venues tile (see
  // POPULAR_VENUES/handleSelectVenue).
  const [selectedVenue, setSelectedVenue] = useState(null);
  const [venueImageUrl, setVenueImageUrl] = useState(null);
  // Resolved photo URL per EVENT_IMAGE_TOPICS bucket (nba, nfl, theater,
  // concerts, ...) — fetched once for the whole app (see the effect below),
  // then reused by every EventCard whose own event.image_url is missing
  // (see pickFallbackImage). Keyed by bucket, not by event, so this stays
  // ~9 requests total no matter how many events are on the page.
  const [categoryFallbackImages, setCategoryFallbackImages] = useState({});
  // Accounts (and Favorites, which depends on accounts) aren't built yet —
  // clicking Sign In/Sign Up/Favorites in the nav just lets the visitor
  // know that, rather than pretending those flows exist. One shared
  // message string drives the same modal for all three entry points.
  const [authNoticeMessage, setAuthNoticeMessage] = useState('');

  // Autocomplete dropdown for the search box (spec: search/autocomplete
  // engine). Debounced so we don't hit the API on every keystroke; the
  // dropdown is dismissed on blur (with a short delay so a click on a
  // suggestion registers before the input loses focus) and after a
  // suggestion is picked or the search is submitted.
  const [autocompleteSuggestions, setAutocompleteSuggestions] = useState([]);
  const [showAutocomplete, setShowAutocomplete] = useState(false);

  // Location and Dates live in the main search bar (see the LOCATION/DATES
  // segments below): `draftLocation`/`draftStartDate`/`draftEndDate` hold
  // what the customer has picked so far, `active*` holds what's actually
  // been applied (and sent to the API) — same pattern as searchInput/
  // activeSearch, so editing them doesn't refetch until the search is
  // submitted. draftStartDate/draftEndDate are committed by the DatesPicker
  // popover's own Apply button (see showDatesPicker below), not live as the
  // customer clicks around inside it.
  const [draftLocation, setDraftLocation] = useState('');
  const [draftStartDate, setDraftStartDate] = useState('');
  const [draftEndDate, setDraftEndDate] = useState('');
  const [showDatesPicker, setShowDatesPicker] = useState(false);
  const [activeStartDate, setActiveStartDate] = useState('');
  const [activeEndDate, setActiveEndDate] = useState('');
  const [activeLocation, setActiveLocation] = useState('');

  const activeFilterCount = [activeStartDate, activeEndDate, activeLocation]
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

  // ---- "Near me" location detection, used by the Featured Events grid's
  // location-based sorting below. ----
  const [zipInput, setZipInput] = useState('');
  const [zipStatus, setZipStatus] = useState('idle'); // 'idle' | 'loading' | 'error'
  // The resolved { city, state, lat, lng, source, zip? } used to sort the
  // Featured Events grid by distance — from a ZIP the visitor typed in, or
  // (once) reverse-geocoded from browser geolocation. Restored from
  // localStorage on first load so a returning visitor doesn't have to
  // re-enter it.
  const [discoverLocation, setDiscoverLocation] = useState(() => loadCachedLocation());

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
    const defaultTitle = 'ConcertAndMatches — Newly Listed Tickets for Concerts, Sports & Theater';
    const defaultDescription = 'Be the first to buy tickets to concerts, sports, theater and comedy across the USA and Canada — new events listed from multiple authorized sellers as fast as they go on sale.';
    const canonicalEl = document.querySelector('link[rel="canonical"]');
    const descriptionEl = document.querySelector('meta[name="description"]');
    let jsonLdEl = document.getElementById('event-jsonld');

    if (selectedEvent) {
      const title = `${selectedEvent.title} Tickets — ${formatDate(selectedEvent.date)} | ConcertAndMatches`;
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
    // discoverLocation (a typed ZIP, or browser geolocation once
    // reverse-geocoded to a city) wins over raw live geolocation coords —
    // so a visitor who denied the live location prompt but typed a ZIP
    // code still gets events sorted by that location instead of a plain
    // date-ordered grid.
    if (discoverLocation) {
      params.set('lat', String(discoverLocation.lat));
      params.set('lng', String(discoverLocation.lng));
    } else if (locationStatus === 'granted' && userLat != null && userLng != null) {
      params.set('lat', String(userLat));
      params.set('lng', String(userLng));
    }
    if (filters?.startDate) params.set('startDate', filters.startDate);
    if (filters?.endDate) params.set('endDate', filters.endDate);
    if (filters?.location) params.set('location', filters.location);
    const response = await fetch(`${API_URL}/events?${params.toString()}`);
    if (!response.ok) throw new Error('Request failed');
    return response.json();
  };

  const activeFilters = {
    startDate: activeStartDate,
    endDate: activeEndDate,
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
  }, [activeSearch, activeCategoryId, locationStatus, discoverLocation, userLat, userLng, activeStartDate, activeEndDate, activeLocation]);

  // Scrolling to Featured Events right when a search is submitted went
  // through two failed attempts before this one. A fixed 50ms deferral
  // (to let the "Clear" button's layout shift settle before a *smooth*
  // scroll starts) still froze the animation partway every time, live-
  // tested at the exact same ~123px offset — and disabling CSS scroll
  // anchoring site-wide didn't fix it either. The remaining, confirmed-
  // live difference from the category tiles' scroll (which does work) is
  // that search results stream in asynchronously and keep resizing the
  // very section being scrolled to for as long as fetchEvents is in
  // flight — so instead of guessing another delay, wait for the actual
  // signal that matters (eventsLoading flipping back to false below) and
  // then jump straight there with an INSTANT scroll: unlike a smooth one,
  // an instant scrollIntoView can't be interrupted mid-animation by a
  // later layout shift, since there's no animation in flight to interrupt.
  const searchScrollPendingRef = useRef(false);

  useEffect(() => {
    if (!eventsLoading && searchScrollPendingRef.current) {
      searchScrollPendingRef.current = false;
      document.getElementById('featured-events')?.scrollIntoView({ behavior: 'auto', block: 'start' });
    }
  }, [eventsLoading]);

  const scrollToFeaturedEvents = () => {
    searchScrollPendingRef.current = true;
  };

  // Closes the DATES popover on an outside click, same as clicking its own
  // Cancel button — discards whatever was picked inside without applying it.
  const datesSegmentRef = useRef(null);
  useEffect(() => {
    if (!showDatesPicker) return undefined;
    const handleClickOutside = (e) => {
      if (datesSegmentRef.current && !datesSegmentRef.current.contains(e.target)) {
        setShowDatesPicker(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showDatesPicker]);

  const handleSearchSubmit = (e) => {
    e.preventDefault();
    setActiveSearch(searchInput.trim());
    setActiveLocation(draftLocation.trim());
    setActiveStartDate(draftStartDate);
    setActiveEndDate(draftEndDate);
    setShowAutocomplete(false);
    // Same behavior as clicking a category tile (see CategoryTiles above):
    // the search results land in the Featured Events grid further down the
    // page, so jump there — otherwise a customer who searches from up near
    // the top never sees anything happen and assumes the search did
    // nothing.
    scrollToFeaturedEvents();
  };

  const handleClearSearch = () => {
    setSearchInput('');
    setActiveSearch('');
    setDraftLocation('');
    setActiveLocation('');
    setDraftStartDate('');
    setDraftEndDate('');
    setActiveStartDate('');
    setActiveEndDate('');
    setAutocompleteSuggestions([]);
    setShowAutocomplete(false);
    setSelectedCity(null);
    setSelectedVenue(null);
  };

  // Picking a team from TeamTiles runs the team's name as a plain search —
  // same mechanism as typing it into the search box and hitting Search —
  // so the results grid, count line, and Clear button all behave exactly
  // as they already do for a search. activeCategoryId (the league, set
  // when the tile was clicked — see CategoryTiles) is left as-is, so the
  // search is layered ON TOP of the league filter rather than replacing
  // it — matching against the team name AND the league's own keywords.
  const handleSelectTeam = (teamName) => {
    // Deliberately does NOT call setSearchInput — the team name drives
    // filtering (activeSearch) same as before, but stays out of the
    // visible search box, which the visitor never typed into.
    setActiveSearch(teamName);
    setSelectedCity(null);
    setSelectedVenue(null);
    setTeamsBrowseCategoryId(null);
    setShowAutocomplete(false);
    scrollToFeaturedEvents();
  };

  // Picking a city from TeamTiles runs the city's name through the
  // location filter (activeLocation — same field the "Location" search box
  // sets, ILIKE against city/state/venue_name on the backend) rather than
  // the plain search box, so it narrows results to that city without ever
  // appearing typed into the visible search field — same rule request K
  // applied to team names. Also sets selectedCity, which drives the hero
  // banner (see CityHeroBanner) and the image lookup effect below.
  const handleSelectCity = (city) => {
    setActiveLocation(city.name);
    setSelectedCity(city);
    setSelectedVenue(null);
    setTeamsBrowseCategoryId(null);
    setShowAutocomplete(false);
    scrollToFeaturedEvents();
  };

  // Same as handleSelectCity above, for the Venues tile — venue_name is
  // already one of the three columns the location filter matches (city/
  // state/venue_name), so this needs no backend changes either.
  const handleSelectVenue = (venue) => {
    setActiveLocation(venue.name);
    setSelectedVenue(venue);
    setSelectedCity(null);
    setTeamsBrowseCategoryId(null);
    setShowAutocomplete(false);
    scrollToFeaturedEvents();
  };

  // Fetches a real photo of the selected city for the hero banner, via the
  // shared fetchWikipediaImage helper (see above) — queried by
  // "{City}, {State}" (with a couple of hand-picked title overrides) rather
  // than the bare city name, so ambiguous names like Columbia, Charleston,
  // Springfield, Bloomington, and Portland resolve to the right city's own
  // article instead of a disambiguation page or the wrong article; the
  // helper's search-API fallback catches anything that still misses.
  // Best-effort: any failure just leaves cityImageUrl null, and the banner
  // below falls back to a plain gradient rather than showing anything broken.
  useEffect(() => {
    if (!selectedCity) {
      setCityImageUrl(null);
      return undefined;
    }
    let cancelled = false;
    setCityImageUrl(null);
    fetchWikipediaImage(cityWikipediaTitle(selectedCity)).then((url) => {
      if (!cancelled && url) setCityImageUrl(url);
    });
    return () => { cancelled = true; };
  }, [selectedCity]);

  // Same as the city-photo effect above, for the selected venue — uses the
  // shared helper's search-API fallback to resolve venues whose Wikipedia
  // article title doesn't exactly match the name in POPULAR_VENUES (plus a
  // couple of explicit overrides for known mismatches, e.g. "The Kia Forum").
  useEffect(() => {
    if (!selectedVenue) {
      setVenueImageUrl(null);
      return undefined;
    }
    let cancelled = false;
    setVenueImageUrl(null);
    const query = VENUE_WIKIPEDIA_TITLE_OVERRIDES[selectedVenue.name] || selectedVenue.name;
    fetchWikipediaImage(query).then((url) => {
      if (!cancelled && url) setVenueImageUrl(url);
    });
    return () => { cancelled = true; };
  }, [selectedVenue]);

  // Resolves one real photo per EVENT_IMAGE_TOPICS bucket, once, for every
  // event card on the site to fall back to when it has no image_url of its
  // own (see EventCard/pickFallbackImage above) — same shared helper as the
  // city/venue hero banners, just fetched once per bucket at app load
  // instead of once per event. Runs once on mount (empty deps); any bucket
  // whose fetch fails just stays unset, and pickFallbackImage already falls
  // further back to the 'concerts' bucket for those.
  useEffect(() => {
    let cancelled = false;
    Object.entries(EVENT_IMAGE_TOPICS).forEach(([bucket, topic]) => {
      fetchWikipediaImage(topic).then((url) => {
        if (!cancelled && url) setCategoryFallbackImages((prev) => ({ ...prev, [bucket]: url }));
      });
    });
    return () => { cancelled = true; };
  }, []);

  const handleSuggestionClick = (label) => {
    setSearchInput(label);
    setActiveSearch(label);
    setShowAutocomplete(false);
    scrollToFeaturedEvents();
  };

  // Footer Quick Links (see Footer component) reuse the exact same state
  // the homepage's own search bar/category tiles already drive, rather
  // than pointing at separate placeholder pages. "Home" clears every
  // filter and returns to the top of the homepage — same effect as
  // clicking the logo (BrandLink) plus a scroll-to-top, since the footer
  // is all the way at the bottom of the page. "Sports" doesn't apply a
  // filter itself (there's no single "Sports" category tile any more — see
  // EVENT_CATEGORIES's split into NFL/NBA/NHL/MLB/MLS) — it scrolls up to
  // the category tiles row so the visitor can pick a specific league.
  const handleFooterGoHome = () => {
    handleClearSearch();
    setActiveCategoryId(null);
    setTeamsBrowseCategoryId(null);
    navigate('/');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleFooterSelectCategory = (categoryId, extraSearch) => {
    setActiveCategoryId(categoryId);
    setTeamsBrowseCategoryId(null);
    setSelectedCity(null);
    setSelectedVenue(null);
    setSearchInput('');
    setActiveSearch(extraSearch || '');
    setShowAutocomplete(false);
    navigate('/');
    setTimeout(() => {
      document.getElementById('featured-events')?.scrollIntoView({ behavior: 'smooth' });
    }, 0);
  };

  const handleFooterBrowseSports = () => {
    setActiveCategoryId(null);
    setTeamsBrowseCategoryId(null);
    navigate('/');
    setTimeout(() => {
      document.getElementById('category-tiles')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 0);
  };

  // BUG FIX: clicking a category tile (see CategoryTiles) only ever set
  // activeCategoryId — it never touched activeSearch/activeLocation/
  // selectedCity/selectedVenue. Those linger from whatever was picked
  // before (a team name via handleSelectTeam, a city/venue via
  // handleSelectCity/handleSelectVenue), so e.g. picking "Los Angeles
  // Kings" under NHL and then clicking the Concerts tile left
  // activeSearch = "Los Angeles Kings" ANDed with the Concerts category on
  // the backend — a combination that can never match anything, so the
  // grid always showed "0 results" no matter which category was clicked
  // next. A category tile click is a fresh top-level navigation, so it
  // should always start from a clean slate rather than inheriting
  // whatever search/location was layered on top of the previous category.
  const handleSelectCategoryTile = (categoryId) => {
    setActiveCategoryId(categoryId);
    setActiveSearch('');
    setSearchInput('');
    setActiveLocation('');
    setDraftLocation('');
    setSelectedCity(null);
    setSelectedVenue(null);
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
          <BrandLink onClick={handleFooterGoHome} />
          <button onClick={handleFooterGoHome} style={{ padding: '8px 16px', cursor: 'pointer' }}>
            Home
          </button>
        </nav>
        <p style={{ textAlign: 'center', marginTop: '60px' }}>Loading event…</p>
      </div>
    );
  }

  if (eventIdFromUrl && detailError && !selectedEvent) {
    return (
      <div style={{ padding: '20px', fontFamily: 'Arial, sans-serif' }}>
        <nav style={{ marginBottom: '20px', display: 'flex', gap: '16px', alignItems: 'center' }}>
          <BrandLink onClick={handleFooterGoHome} />
          <button onClick={handleFooterGoHome} style={{ padding: '8px 16px', cursor: 'pointer' }}>
            Home
          </button>
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
        {/* Same dark-navy band treatment as the redesigned homepage hero, so
            the event page's top zone matches it instead of sitting on the
            plain page background. The nav keeps its own white card on top
            of the band (same pattern as the homepage nav) so the brand
            logo/text stay fully readable regardless of the band color. */}
        <div style={{ background: NAVY_BG, borderRadius: '28px', padding: '20px', marginBottom: '24px' }}>
          <nav style={{
            display: 'flex',
            gap: '16px',
            alignItems: 'center',
            padding: '14px 18px',
            backgroundColor: '#fff',
            borderRadius: '16px',
            boxShadow: 'var(--cm-shadow-sm)',
            border: '1px solid var(--cm-border)',
            color: '#141b2d',
          }}>
            <BrandLink onClick={handleFooterGoHome} />
            <button onClick={handleFooterGoHome} style={{ padding: '8px 16px', cursor: 'pointer' }}>
              Home
            </button>
            <button onClick={() => navigate('/')} style={{ padding: '8px 16px', cursor: 'pointer' }}>
              ← Back to Events
            </button>
          </nav>
        </div>

        <div style={{ maxWidth: '600px', margin: '0 auto', border: '1px solid var(--cm-border)', padding: '30px', borderRadius: 'var(--cm-radius)', backgroundColor: '#fff', boxShadow: 'var(--cm-shadow-sm)' }}>
          {(selectedEvent.image_url || pickFallbackImage(selectedEvent, categoryFallbackImages)) && (
            <img
              src={selectedEvent.image_url || pickFallbackImage(selectedEvent, categoryFallbackImages)}
              alt={selectedEvent.title}
              style={{ width: '100%', borderRadius: '12px', marginBottom: '20px', objectFit: 'cover', maxHeight: '300px' }}
            />
          )}
          <h1 style={{ color: '#141b2d' }}>{selectedEvent.title}</h1>
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
                {/* Redesigned as a scannable comparison list (colored dot +
                    seller name on the left, price + "STARTING AT" on the
                    right, a highlighted row + "Best price" badge for the
                    cheapest confirmed offer) rather than a stack of big
                    colored buttons — modeled on a reference price-comparison
                    list the user provided. The whole row is the click
                    target (an <a>), same affiliate-link/click-logging
                    behavior as before, just restyled. */}
                <div style={{ border: '1px solid #eee', borderRadius: '14px', overflow: 'hidden', backgroundColor: '#fff' }}>
                  {findTicketsLinks.map((link, i) => {
                    // The full tier breakdown (e.g. Standard vs. VIP) only
                    // makes sense to show when there's a single seller —
                    // once there's more than one offer, a plain per-seller
                    // price is what actually helps someone compare. It's
                    // also skipped when the only "tier" is the generic
                    // fallback ("Price", no real named tier from the
                    // source) with nothing else alongside it — that row
                    // would just repeat the price already shown on the
                    // seller row above it.
                    const showTierBreakdown = findTicketsLinks.length === 1 && priceTiers.length > 0
                      && !(priceTiers.length === 1 && priceTiers[0].label === 'Price');
                    const linkPrices = [...new Set(
                      [link.minPrice, link.maxPrice].filter((p) => p != null).map((p) => Number(p))
                    )].sort((a, b) => a - b);
                    const priceLabel = linkPrices.length > 0
                      ? linkPrices.map((p) => `$${p.toFixed(0)}`).join(', ')
                      : null;
                    const isOfficialLink = link.source === 'official';
                    return (
                      <div key={link.source} style={{ borderTop: i === 0 ? 'none' : '1px solid #eee' }}>
                        <a
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
                            // Meta Pixel "Lead" event — unlike the backend
                            // click log above, this always fires here
                            // regardless of eventRowId; it's a separate,
                            // ads-only signal with its own de-dupe (Meta's
                            // pixel script), not the site's own click count.
                            trackMetaTicketClick({
                              source: link.source,
                              title: selectedEvent?.title,
                              city: selectedEvent?.city,
                              state: selectedEvent?.state,
                            });
                          }}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: '12px',
                            padding: '16px 18px',
                            textDecoration: 'none',
                            color: 'inherit',
                            backgroundColor: 'transparent',
                          }}>
                          {/* flexWrap + every child (including the name)
                              pinned to flexShrink: 0 — without this, the
                              name span (the only child with overflow:hidden
                              on it) was the one thing the flexbox algorithm
                              would shrink to make room for the dot/logo/
                              arrow/badge, and at narrow widths that meant
                              shrinking it all the way to 0 — the seller name
                              disappearing completely (confirmed live: the
                              "Ticketmaster" label vanished on the one row
                              that also carried the Best price badge, while
                              still being present in the DOM/page text).
                              Wrapping instead of shrinking means the badge
                              drops to its own line on a tight width rather
                              than erasing the name. */}
                          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', rowGap: '4px', flexWrap: 'wrap', minWidth: 0 }}>
                            <span
                              aria-hidden="true"
                              style={{ width: '10px', height: '10px', borderRadius: '50%', backgroundColor: link.dotColor, flexShrink: 0 }}
                            />
                            {link.logoUrl && (
                              <img
                                src={link.logoUrl}
                                alt=""
                                width={16}
                                height={16}
                                style={{ borderRadius: '3px', flexShrink: 0 }}
                                // A favicon that fails to load (blocked, retailer
                                // changed domains, etc.) should just disappear
                                // rather than show a broken-image icon.
                                onError={(e) => { e.currentTarget.style.display = 'none'; }}
                              />
                            )}
                            <span style={{ fontWeight: 'bold', fontSize: '15px', flexShrink: 0 }}>
                              {isOfficialLink ? `Visit ${link.name}` : link.name}
                            </span>
                            <span aria-hidden="true" style={{ color: '#999', fontSize: '13px', flexShrink: 0 }}>↗</span>
                          </div>
                          <div style={{ textAlign: 'right', flexShrink: 0 }}>
                            {priceLabel ? (
                              <>
                                <div style={{ fontWeight: 'bold', fontSize: '17px', color: '#111' }}>{priceLabel}</div>
                                {!showTierBreakdown && (
                                  <div style={{ fontSize: '11px', color: '#888', letterSpacing: '0.03em' }}>STARTING AT</div>
                                )}
                              </>
                            ) : !isOfficialLink && (
                              <span style={{ fontSize: '13px', fontStyle: 'italic', color: '#999' }}>Price not listed</span>
                            )}
                          </div>
                        </a>
                        {showTierBreakdown && (
                          <div style={{ margin: '0 18px 14px', padding: '10px 12px', border: '1px solid #eee', borderRadius: '10px', backgroundColor: '#fafafa' }}>
                            {priceTiers.map((tier, ti) => {
                              const tierValues = [...new Set([tier.min, tier.max].filter((p) => p != null))].sort((a, b) => a - b);
                              // The generic fallback tier (no real named tier
                              // from the source, e.g. Ticketmaster's
                              // "Standard"/"VIP") is labeled "Price" — but
                              // with two distinct numbers that reads as one
                              // price rather than what it actually is, a
                              // range between two real endpoints. A real
                              // named tier keeps its own name either way.
                              const label = tier.label === 'Price' && tierValues.length > 1 ? 'Price range' : tier.label;
                              // A "Price range" row (two endpoints on one
                              // generic tier) only makes sense as a spread
                              // to compare against other sellers. With just
                              // one seller there's nothing to compare, so
                              // the row is dropped even when a real named
                              // tier (VIP, etc.) is shown alongside it —
                              // the plain single-tier case (nothing else to
                              // show it next to) is handled a level up, by
                              // showTierBreakdown itself.
                              if (label === 'Price range' && findTicketsLinks.length === 1) return null;
                              return (
                                <div
                                  key={`${tier.label}-${ti}`}
                                  style={{
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    fontSize: '14px',
                                    color: '#333',
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

        <Footer
          onGoHome={handleFooterGoHome}
          onSelectCategory={handleFooterSelectCategory}
          onBrowseSports={handleFooterBrowseSports}
        />
      </div>
    );
  }

  // HOME PAGE
  return (
    <div className="cm-home-page">
      {/* Full dark-navy hero band: wraps the nav, headline and search bar,
          matching the reference design's continuous dark background (no
          separate white nav card floating on top of it, unlike the old
          red-band layout). Nav links/text are white/light-blue since they
          sit directly on this background. */}
      <div style={{
        background: NAVY_BG,
        borderRadius: '28px',
        padding: '20px 24px 32px',
        marginBottom: '20px',
      }}>
        <nav style={{
          marginBottom: '32px',
          display: 'flex',
          gap: '20px',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          color: '#fff',
        }}>
          <BrandLink onClick={handleFooterGoHome} />

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '26px', alignItems: 'center', fontSize: '14.5px', fontWeight: 600 }}>
            <span
              role="link"
              tabIndex={0}
              className="cm-link-underline"
              onClick={handleFooterGoHome}
              onKeyDown={(e) => { if (e.key === 'Enter') handleFooterGoHome(); }}
              style={{ cursor: 'pointer', color: '#fff' }}>
              Home
            </span>
            <span
              role="link"
              tabIndex={0}
              className="cm-link-underline"
              onClick={() => {
                setActiveCategoryId(null);
                document.getElementById('featured-events')?.scrollIntoView({ behavior: 'smooth' });
              }}
              onKeyDown={(e) => { if (e.key === 'Enter') { setActiveCategoryId(null); document.getElementById('featured-events')?.scrollIntoView({ behavior: 'smooth' }); } }}
              style={{ cursor: 'pointer', color: NAV_ACCENT_LIGHT }}>
              Events
            </span>
            <span
              role="link"
              tabIndex={0}
              className="cm-link-underline"
              onClick={() => {
                const next = teamsBrowseCategoryId === 'venues' ? null : 'venues';
                setTeamsBrowseCategoryId(next);
                setActiveCategoryId(next);
                if (next) {
                  setTimeout(() => {
                    document.getElementById('team-tiles')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }, 0);
                }
              }}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                const next = teamsBrowseCategoryId === 'venues' ? null : 'venues';
                setTeamsBrowseCategoryId(next);
                setActiveCategoryId(next);
                if (next) {
                  setTimeout(() => {
                    document.getElementById('team-tiles')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }, 0);
                }
              }}
              style={{ cursor: 'pointer', color: '#fff' }}>
              Venues
            </span>
            <span
              role="link"
              tabIndex={0}
              className="cm-link-underline"
              onClick={() => {
                const next = teamsBrowseCategoryId === 'cities' ? null : 'cities';
                setTeamsBrowseCategoryId(next);
                setActiveCategoryId(next);
                if (next) {
                  setTimeout(() => {
                    document.getElementById('team-tiles')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }, 0);
                }
              }}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                const next = teamsBrowseCategoryId === 'cities' ? null : 'cities';
                setTeamsBrowseCategoryId(next);
                setActiveCategoryId(next);
                if (next) {
                  setTimeout(() => {
                    document.getElementById('team-tiles')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }, 0);
                }
              }}
              style={{ cursor: 'pointer', color: '#fff' }}>
              Cities
            </span>
            <span
              role="link"
              tabIndex={0}
              className="cm-link-underline"
              onClick={() => document.getElementById('site-footer')?.scrollIntoView({ behavior: 'smooth' })}
              onKeyDown={(e) => { if (e.key === 'Enter') document.getElementById('site-footer')?.scrollIntoView({ behavior: 'smooth' }); }}
              style={{ cursor: 'pointer', color: '#fff' }}>
              About
            </span>
            <a href="mailto:service@concertandmatches.com" className="cm-link-underline" style={{ color: '#fff', textDecoration: 'none' }}>Help</a>
          </div>

          <div style={{ display: 'flex', gap: '18px', alignItems: 'center', fontSize: '14px', fontWeight: 600 }}>
            <button
              type="button"
              onClick={() => setAuthNoticeMessage('Favorites are coming soon — check back shortly!')}
              style={{ display: 'flex', alignItems: 'center', gap: '6px', background: 'none', border: 'none', padding: 0, font: 'inherit', color: '#fff', cursor: 'pointer' }}>
              <span aria-hidden="true">♡</span> Favorites
            </button>
            <button
              type="button"
              onClick={() => setAuthNoticeMessage('Accounts and sign-in are coming soon — check back shortly!')}
              style={{ display: 'flex', alignItems: 'center', gap: '6px', background: 'none', border: 'none', padding: 0, font: 'inherit', color: '#fff', cursor: 'pointer' }}>
              <span aria-hidden="true">👤</span> Sign In
            </button>
            <button
              type="button"
              className="cm-btn"
              onClick={() => setAuthNoticeMessage('Accounts and sign-up are coming soon — check back shortly!')}
              style={{
                padding: '9px 20px',
                cursor: 'pointer',
                border: 'none',
                borderRadius: '999px',
                backgroundColor: NAV_ACCENT_COLOR,
                color: '#fff',
                fontWeight: 700,
              }}>
              Sign Up
            </button>
          </div>
        </nav>

        {authNoticeMessage && (
          <div
            role="alertdialog"
            aria-label="Notice"
            onClick={() => setAuthNoticeMessage('')}
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
              <p style={{ marginBottom: '18px' }}>{authNoticeMessage}</p>
              <button
                type="button"
                className="cm-btn"
                onClick={() => setAuthNoticeMessage('')}
                style={{ padding: '10px 24px', cursor: 'pointer', border: 'none', borderRadius: '999px', backgroundColor: NAV_ACCENT_COLOR, color: 'white', fontWeight: 'bold' }}>
                Got it
              </button>
            </div>
          </div>
        )}

      {/* Single full-bleed photo banner, matching the reference exactly:
          the concert-crowd photo spans the FULL width behind the headline
          (not confined to a separate rounded box on the right) — a dark
          navy-to-photo gradient keeps the text on the left readable while
          the crowd is fully visible on the right, with the "Live Brings Us
          Together" script sitting on the photo at bottom-right. The search
          bar lives in its own plain-navy row below the banner, not
          overlapping the photo, exactly as in the reference. */}
      <div
        className="cm-hero-photo"
        style={{
          position: 'relative',
          overflow: 'hidden',
          borderRadius: '20px 20px 0 0',
          minHeight: '210px',
          padding: '22px 28px 26px',
          backgroundImage: 'url(/hero-crowd-clean.jpg)',
          backgroundSize: 'cover',
          backgroundPosition: 'right center',
        }}>
        <div aria-hidden="true" style={{
          position: 'absolute',
          inset: 0,
          background: `linear-gradient(90deg, ${NAVY_BG} 0%, ${NAVY_BG} 38%, rgba(0,22,51,0.55) 60%, rgba(0,22,51,0.15) 80%, rgba(0,22,51,0) 100%)`,
        }} />
        <h1 style={{
          position: 'relative',
          textAlign: 'left',
          fontSize: 'clamp(26px, 3.6vw, 38px)',
          fontWeight: 800,
          letterSpacing: '-0.01em',
          lineHeight: 1.15,
          margin: '4px 0 8px',
          color: '#fff',
          maxWidth: '620px',
        }}>
          <span style={{ whiteSpace: 'nowrap' }}>Be The First To Find Your Ticket.</span>
        </h1>

        <p style={{
          position: 'relative',
          textAlign: 'left',
          fontSize: 'clamp(26px, 3.6vw, 38px)',
          fontWeight: 800,
          letterSpacing: '-0.01em',
          lineHeight: 1.15,
          color: NAV_ACCENT_LIGHT,
          margin: 0,
          whiteSpace: 'nowrap',
        }}>
          No Extra Fees. No Checkout Surprises.
        </p>

        <span style={{
          position: 'absolute',
          right: '24px',
          bottom: '18px',
          fontFamily: 'Georgia, "Times New Roman", serif',
          fontStyle: 'italic',
          fontWeight: 700,
          fontSize: '19px',
          lineHeight: 1.15,
          color: 'rgba(255,255,255,0.92)',
          textAlign: 'right',
          textShadow: '0 2px 10px rgba(0,0,0,0.45)',
        }}>
          Live Brings Us<br />Together
        </span>
      </div>

      {/* Search bar row — plain navy, sits directly below the photo banner
          with no gap. Search pill: three labeled segments (Location / Dates
          / Search), each with an icon + uppercase mini-label above the
          value, separated by hairline dividers, then the Search button
          flush against the right edge of the same white pill. */}
      <div className="cm-search-row" style={{ backgroundColor: NAVY_BG, borderRadius: '0 0 20px 20px', padding: '18px 28px 24px' }}>
      <form className="cm-search-form" onSubmit={handleSearchSubmit} style={{ display: 'flex', alignItems: 'stretch', margin: 0 }}>
        <div
          className="cm-card cm-search-pill"
          style={{
            display: 'flex',
            alignItems: 'stretch',
            flex: '1',
            minWidth: '280px',
            backgroundColor: '#fff',
            borderRadius: '999px',
            boxShadow: 'var(--cm-shadow-md)',
            // Not overflow:hidden — the Dates popover and the Search
            // autocomplete list are absolutely positioned inside segments
            // nested in this pill, and a hidden overflow here clips them
            // out of view entirely (they still open/toggle in state, just
            // invisible). The pill's rounded silhouette is preserved
            // instead by rounding the Search button's own right corners
            // below, since it's the only segment with its own background.
          }}>
          {/* LOCATION segment — icon + small uppercase label above the
              value, matching the reference three-field layout (Location /
              Dates / Search, each labeled). */}
          <div className="cm-search-seg cm-search-seg-location" style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            flex: '1',
            minWidth: '150px',
            padding: '0 20px',
          }}>
            <span style={{ fontSize: '20px', color: NAV_ACCENT_COLOR, flexShrink: 0 }} aria-hidden="true">📍</span>
            <div style={{ display: 'flex', flexDirection: 'column', width: '100%', minWidth: 0 }}>
              <span style={{ fontSize: '11px', fontWeight: 800, letterSpacing: '0.05em', textTransform: 'uppercase', color: '#5c6b85' }}>
                Location
              </span>
              <input
                id="cm-search-location"
                type="text"
                placeholder="City or Zip Code"
                value={draftLocation}
                onChange={(e) => setDraftLocation(e.target.value)}
                style={{
                  border: 'none',
                  outline: 'none',
                  padding: '1px 0 0',
                  fontSize: '15px',
                  width: '100%',
                  minWidth: 0,
                  color: '#1a0733',
                }}
                autoComplete="off"
              />
            </div>
          </div>

          {/* Hairline divider, matching the reference */}
          <div className="cm-search-divider" style={{ width: '1px', alignSelf: 'center', height: '30px', backgroundColor: '#d7dceb', flexShrink: 0 }} />

          {/* DATES segment */}
          <div ref={datesSegmentRef} className="cm-search-seg cm-search-seg-dates" style={{ position: 'relative', display: 'flex', alignItems: 'stretch', flex: '1', minWidth: '150px' }}>
            <button
              type="button"
              onClick={() => setShowDatesPicker((v) => !v)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                border: 'none',
                background: 'none',
                cursor: 'pointer',
                padding: '0 20px',
                width: '100%',
                textAlign: 'left',
              }}
              aria-label="Choose dates">
              <span style={{ fontSize: '20px', color: NAV_ACCENT_COLOR, flexShrink: 0 }} aria-hidden="true">📅</span>
              <span style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: '11px', fontWeight: 800, letterSpacing: '0.05em', textTransform: 'uppercase', color: '#5c6b85' }}>
                  Dates
                </span>
                <span style={{ fontSize: '15px', color: '#1a0733', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {draftStartDate ? `${formatShortDate(draftStartDate)}${draftEndDate ? ` – ${formatShortDate(draftEndDate)}` : ''}` : 'All Dates'}
                </span>
              </span>
              <span style={{ fontSize: '13px', color: '#5c6b85', flexShrink: 0, display: 'inline-block', transform: showDatesPicker ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s ease' }} aria-hidden="true">⌄</span>
            </button>
            {showDatesPicker && (
              <div onClick={(e) => e.stopPropagation()} style={{ position: 'absolute', top: 'calc(100% + 8px)', left: 0, zIndex: 20 }}>
                <DatesPicker
                  startDate={draftStartDate}
                  endDate={draftEndDate}
                  onCancel={() => setShowDatesPicker(false)}
                  onApply={(start, end) => {
                    setDraftStartDate(start);
                    setDraftEndDate(end);
                    setShowDatesPicker(false);
                  }}
                />
              </div>
            )}
          </div>

          {/* Hairline divider, matching the reference */}
          <div className="cm-search-divider" style={{ width: '1px', alignSelf: 'center', height: '30px', backgroundColor: '#d7dceb', flexShrink: 0 }} />

          {/* SEARCH segment */}
          <div className="cm-search-seg cm-search-seg-search" style={{
            position: 'relative',
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            flex: '2',
            minWidth: '170px',
            padding: '0 20px',
          }}>
            <span style={{ fontSize: '20px', color: NAV_ACCENT_COLOR, flexShrink: 0 }} aria-hidden="true">🔍</span>
            <div style={{ display: 'flex', flexDirection: 'column', width: '100%', minWidth: 0 }}>
              <span style={{ fontSize: '11px', fontWeight: 800, letterSpacing: '0.05em', textTransform: 'uppercase', color: '#5c6b85' }}>
                Search
              </span>
              <input
                id="cm-search-query"
                type="text"
                placeholder="Artist, Event or Venue"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onFocus={() => { if (autocompleteSuggestions.length > 0) setShowAutocomplete(true); }}
                onBlur={() => setTimeout(() => setShowAutocomplete(false), 150)}
                style={{
                  border: 'none',
                  outline: 'none',
                  padding: '1px 0 0',
                  fontSize: '15px',
                  width: '100%',
                  minWidth: 0,
                  color: '#1a0733',
                }}
                autoComplete="off"
              />
            </div>
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
            className="cm-btn cm-search-submit"
            style={{
              padding: '0 32px',
              cursor: 'pointer',
              border: 'none',
              backgroundColor: NAV_ACCENT_COLOR,
              color: '#fff',
              fontWeight: 'bold',
              fontSize: '15px',
              flexShrink: 0,
              // Matches the pill's own 999px radius on the right side only,
              // now that the pill no longer clips its children to that
              // shape via overflow:hidden (see the pill's style comment).
              borderTopRightRadius: '999px',
              borderBottomRightRadius: '999px',
            }}>
            Search
          </button>
        </div>

        {(activeSearch || activeLocation || activeStartDate || activeEndDate) && (
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
              marginLeft: '10px',
              flexShrink: 0,
            }}>
            Clear
          </button>
        )}
      </form>
      </div>

      <div id="category-tiles">
      <CategoryTiles
        activeCategoryId={activeCategoryId}
        onSelect={handleSelectCategoryTile}
        teamsBrowseCategoryId={teamsBrowseCategoryId}
        onToggleTeams={setTeamsBrowseCategoryId}
      />
      </div>

      {teamsBrowseCategoryId && (
        <TeamTiles
          category={EVENT_CATEGORIES.find((c) => c.id === teamsBrowseCategoryId)}
          onSelectTeam={
            teamsBrowseCategoryId === 'cities' ? handleSelectCity
              : teamsBrowseCategoryId === 'venues' ? handleSelectVenue
                : handleSelectTeam
          }
          onClose={() => setTeamsBrowseCategoryId(null)}
        />
      )}

      {/* Popular Events section — same continuous dark-navy background as
          the hero above it (no seam between them, matching the reference
          design's single-background page instead of the old two separate
          rounded "islands"). Event cards keep their own white background
          and are unaffected. */}
      <div id="featured-events" style={{ marginTop: '8px', paddingTop: '12px' }}>
        {selectedCity && (
          <div
            style={{
              position: 'relative',
              borderRadius: '18px',
              overflow: 'hidden',
              marginBottom: '20px',
              minHeight: '220px',
              display: 'flex',
              alignItems: 'flex-end',
              backgroundColor: NAVY_PANEL,
              backgroundImage: cityImageUrl
                ? `linear-gradient(180deg, rgba(0,22,52,0.25), rgba(0,22,52,0.9)), url(${cityImageUrl})`
                : `linear-gradient(135deg, ${NAVY_PANEL_LIGHT}, ${NAVY_BG})`,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
            }}>
            <div style={{ padding: '28px' }}>
              <span style={{ display: 'block', fontSize: '12.5px', fontWeight: 700, color: NAV_ACCENT_LIGHT, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                Events In
              </span>
              <span style={{ display: 'block', fontSize: '32px', fontWeight: 800, color: '#fff', marginTop: '4px' }}>
                {selectedCity.name}, {selectedCity.state}
              </span>
            </div>
          </div>
        )}
        {selectedVenue && (
          <div
            style={{
              position: 'relative',
              borderRadius: '18px',
              overflow: 'hidden',
              marginBottom: '20px',
              minHeight: '220px',
              display: 'flex',
              alignItems: 'flex-end',
              backgroundColor: NAVY_PANEL,
              backgroundImage: venueImageUrl
                ? `linear-gradient(180deg, rgba(0,22,52,0.25), rgba(0,22,52,0.9)), url(${venueImageUrl})`
                : `linear-gradient(135deg, ${NAVY_PANEL_LIGHT}, ${NAVY_BG})`,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
            }}>
            <div style={{ padding: '28px' }}>
              <span style={{ display: 'block', fontSize: '12.5px', fontWeight: 700, color: NAV_ACCENT_LIGHT, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                Events At
              </span>
              <span style={{ display: 'block', fontSize: '32px', fontWeight: 800, color: '#fff', marginTop: '4px' }}>
                {selectedVenue.name}
              </span>
              <span style={{ display: 'block', fontSize: '14px', fontWeight: 600, color: 'rgba(255,255,255,0.75)', marginTop: '4px' }}>
                {selectedVenue.city}, {selectedVenue.state}
              </span>
            </div>
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px' }}>
          <h3 style={{ fontSize: '24px', color: '#fff', margin: 0 }}>
            {selectedCity
              ? `Events in ${selectedCity.name}`
              : selectedVenue
                ? `Events at ${selectedVenue.name}`
                : activeCategoryId
                  ? EVENT_CATEGORIES.find((c) => c.id === activeCategoryId)?.label
                  : 'Popular Events Near You'}
          </h3>
          {(activeSearch || activeCategoryId || activeFilterCount > 0) && (
            <button
              type="button"
              onClick={handleClearSearch}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: NAV_ACCENT_LIGHT, fontWeight: 700, fontSize: '13.5px', padding: 0 }}>
              View All Events →
            </button>
          )}
        </div>

        {(activeSearch || activeCategoryId || activeFilterCount > 0) && !eventsLoading && !eventsError && (
          <p style={{ color: 'var(--cm-text-onnavy-muted)' }}>
            {eventsTotal} result{eventsTotal === 1 ? '' : 's'}
            {activeCategoryId ? ` in ${EVENT_CATEGORIES.find((c) => c.id === activeCategoryId)?.label}` : ''}
            {activeSearch ? ` for "${activeSearch}"` : ''}
            {activeFilterCount > 0 ? ` (${activeFilterCount} filter${activeFilterCount === 1 ? '' : 's'} applied)` : ''}
          </p>
        )}

        {!discoverLocation && (locationStatus === 'denied' || locationStatus === 'unavailable') && (
          <p style={{ color: 'var(--cm-text-onnavy-muted)', fontSize: '13px' }}>
            Showing events by date. Enable location in your browser to see events near you first.
          </p>
        )}

        {eventsLoading && <p style={{ color: '#fff', marginTop: '12px' }}>Loading events...</p>}
        {!eventsLoading && eventsError && <p style={{ color: '#fff', marginTop: '12px' }}>{eventsError}</p>}
        {!eventsLoading && !eventsError && events.length === 0 && (
          <p style={{ color: '#fff', marginTop: '12px' }}>
            {activeSearch || activeCategoryId || activeFilterCount > 0
              ? `No events found${activeCategoryId ? ` in ${EVENT_CATEGORIES.find((c) => c.id === activeCategoryId)?.label}` : ''}${activeSearch ? ` for "${activeSearch}"` : ''}${activeFilterCount > 0 ? ' with the selected filters' : ''}. Try adjusting your filters.`
              : 'No events available right now. Check back soon!'}
          </p>
        )}

        <div className="cm-event-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '20px', marginTop: '18px' }}>
          {events.map((event) => (
            <EventCard
              key={event.id}
              event={event}
              onSelect={handleSelectEvent}
              fallbackImageUrl={pickFallbackImage(event, categoryFallbackImages)}
            />
          ))}
        </div>

        {!eventsLoading && !eventsError && eventsHasMore && (
          <div style={{ textAlign: 'center', marginTop: '24px' }}>
            <button
              onClick={handleLoadMore}
              disabled={eventsLoadingMore}
              className="cm-btn"
              style={{
                padding: '10px 24px',
                cursor: eventsLoadingMore ? 'default' : 'pointer',
                border: `1px solid ${NAVY_BORDER}`,
                borderRadius: '999px',
                backgroundColor: NAVY_PANEL,
                color: '#fff',
              }}>
              {eventsLoadingMore ? 'Loading...' : `Load More (${events.length} of ${eventsTotal})`}
            </button>
          </div>
        )}
      </div>

      <FeatureStrip />

      <PartnerPromoBanner />

      <CtaBanner
        onExplore={() => {
          handleClearSearch();
          document.getElementById('featured-events')?.scrollIntoView({ behavior: 'smooth' });
        }}
      />

      <Footer
        onGoHome={handleFooterGoHome}
        onSelectCategory={handleFooterSelectCategory}
        onBrowseSports={handleFooterBrowseSports}
      />
      </div>
    </div>
  );
}
