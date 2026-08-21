import React, { useState, useEffect } from 'react';
import './App.css';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:30001/api';

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
// and StubHub are still plain (non-tracked) search links — their affiliate
// applications are pending. Swap each in for its network's tracked deep link
// once approved.
function buildFindTicketsLinks(event) {
  const q = encodeURIComponent(event.title || event.artist_name || '');
  return [
    { name: 'Ticketmaster', url: trackedTicketmasterLink(`https://www.ticketmaster.com/search?q=${q}`) },
    { name: 'SeatGeek', url: `https://seatgeek.com/search?search=${q}` },
    { name: 'StubHub', url: `https://www.stubhub.com/find/s/?q=${q}` },
  ];
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
            <div style={{ fontWeight: 'bold', fontSize: '13px' }}>{cat.label}</div>
          </button>
        );
      })}
    </div>
  );
}

function Footer() {
  return (
    <footer style={{ marginTop: '40px', padding: '20px 0', borderTop: '1px solid #eee', fontSize: '12px', color: '#888' }}>
      <p>ConcertAndMatches is an independent event discovery site and is not affiliated with any ticket seller. We may earn a commission when you buy tickets through links on this site.</p>
      <p style={{ marginTop: '8px' }}>
        <a href="/terms.html" style={{ color: '#888', marginRight: '16px' }}>Terms of Service</a>
        <a href="/privacy.html" style={{ color: '#888' }}>Privacy Policy</a>
      </p>
    </footer>
  );
}

export default function App() {
  const [selectedEvent, setSelectedEvent] = useState(null);

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

  const fetchEvents = async (offset, search, categoryId) => {
    const params = new URLSearchParams({ limit: String(EVENTS_PAGE_SIZE), offset: String(offset) });
    if (search) params.set('search', search);
    const activeCategory = EVENT_CATEGORIES.find((c) => c.id === categoryId);
    if (activeCategory?.category) params.set('category', activeCategory.category.join(','));
    if (activeCategory?.keywords) params.set('keywords', activeCategory.keywords.join(','));
    if (locationStatus === 'granted' && userLat != null && userLng != null) {
      params.set('lat', String(userLat));
      params.set('lng', String(userLng));
    }
    const response = await fetch(`${API_URL}/events?${params.toString()}`);
    if (!response.ok) throw new Error('Request failed');
    return response.json();
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
        const data = await fetchEvents(0, activeSearch, activeCategoryId);
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
  }, [activeSearch, activeCategoryId, locationStatus]);

  const handleSearchSubmit = (e) => {
    e.preventDefault();
    setActiveSearch(searchInput.trim());
  };

  const handleClearSearch = () => {
    setSearchInput('');
    setActiveSearch('');
  };

  const handleLoadMore = async () => {
    setEventsLoadingMore(true);
    try {
      const data = await fetchEvents(events.length, activeSearch, activeCategoryId);
      setEvents((prev) => [...prev, ...(data.events || [])]);
      setEventsTotal(data.total || 0);
      setEventsHasMore(Boolean(data.hasMore));
    } catch (error) {
      setEventsError('Could not load more events right now. Please try again later.');
    } finally {
      setEventsLoadingMore(false);
    }
  };

  // EVENT DETAIL PAGE
  if (selectedEvent) {
    const findTicketsLinks = buildFindTicketsLinks(selectedEvent);
    return (
      <div style={{ padding: '20px', fontFamily: 'Arial, sans-serif' }}>
        <nav style={{ marginBottom: '20px', display: 'flex', gap: '10px', alignItems: 'center' }}>
          <h2 style={{ margin: '0' }}>ConcertAndMatches.com</h2>
          <button onClick={() => setSelectedEvent(null)} style={{ padding: '8px 16px', cursor: 'pointer' }}>
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

          <div style={{ marginTop: '30px', padding: '20px', backgroundColor: '#f5f5f5', borderRadius: '8px' }}>
            <p><strong>📅 Date:</strong> {formatDate(selectedEvent.date)}</p>
            <p><strong>📍 Location:</strong> {selectedEvent.venue_name ? `${selectedEvent.venue_name}, ` : ''}{selectedEvent.city}{selectedEvent.state ? `, ${selectedEvent.state}` : ''}</p>
            <p><strong>💰 Price:</strong> {formatPrice(selectedEvent)}</p>
          </div>

          <div style={{ marginTop: '30px', padding: '20px', backgroundColor: '#f5f5f5', borderRadius: '8px' }}>
            <h3 style={{ marginTop: 0 }}>Find Tickets</h3>
            <p style={{ fontSize: '14px', color: '#666', marginBottom: '14px' }}>
              ConcertAndMatches doesn't sell tickets directly. Search for this event on a trusted
              ticket seller to see availability and complete your purchase:
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {findTicketsLinks.map((link) => (
                <a
                  key={link.name}
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer sponsored"
                  style={{
                    display: 'block',
                    padding: '12px 16px',
                    borderRadius: '8px',
                    border: '1px solid #ddd',
                    backgroundColor: 'white',
                    color: '#222',
                    textDecoration: 'none',
                    fontWeight: 'bold',
                    textAlign: 'center',
                  }}>
                  Search on {link.name} ↗
                </a>
              ))}
            </div>
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
        <h2 style={{ margin: '0' }}>ConcertAndMatches.com</h2>
      </nav>

      <h1 style={{ textAlign: 'center', fontSize: '40px', margin: '10px 0 30px' }}>
        Best Price For any Events
      </h1>

      <div style={{ marginTop: '20px' }}>
        <h3>Featured Events</h3>

        <form onSubmit={handleSearchSubmit} style={{ display: 'flex', gap: '10px', marginBottom: '16px', flexWrap: 'wrap' }}>
          <input
            type="text"
            placeholder="Search by artist, event, or venue..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            style={{ flex: '1', minWidth: '220px', padding: '10px', boxSizing: 'border-box' }}
          />
          <button type="submit" style={{ padding: '10px 20px', cursor: 'pointer' }}>
            Search
          </button>
          {activeSearch && (
            <button type="button" onClick={handleClearSearch} style={{ padding: '10px 20px', cursor: 'pointer' }}>
              Clear
            </button>
          )}
        </form>

        <CategoryTiles activeCategoryId={activeCategoryId} onSelect={setActiveCategoryId} />

        {(activeSearch || activeCategoryId) && !eventsLoading && !eventsError && (
          <p style={{ color: '#666' }}>
            {eventsTotal} result{eventsTotal === 1 ? '' : 's'}
            {activeCategoryId ? ` in ${EVENT_CATEGORIES.find((c) => c.id === activeCategoryId)?.label}` : ''}
            {activeSearch ? ` for "${activeSearch}"` : ''}
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
            {activeSearch || activeCategoryId
              ? `No events found${activeCategoryId ? ` in ${EVENT_CATEGORIES.find((c) => c.id === activeCategoryId)?.label}` : ''}${activeSearch ? ` for "${activeSearch}"` : ''}.`
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
                <p>💰 {formatPrice(event)}</p>
                <button
                  onClick={() => setSelectedEvent(event)}
                  style={{ padding: '8px 16px', cursor: 'pointer', width: '100%' }}>
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
