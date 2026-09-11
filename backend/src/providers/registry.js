import { TicketmasterProvider } from './TicketmasterProvider.js';
import { SeatGeekProvider } from './SeatGeekProvider.js';
import { TicketNetworkProvider } from './TicketNetworkProvider.js';

// Single shared instance per provider — these wrappers are stateless
// (they just delegate to the underlying service functions), so there's no
// reason to construct a new one per request.
//
// Only official, authenticated REST APIs are registered here — see
// backend/DATA_SOURCES.md. A StubHub provider and an "official sites"
// JSON-LD-scraping provider used to be registered too; both were removed
// (StubHub was an unverified/unofficial skeleton never wired into any
// sync job, and the official-sites provider scraped arbitrary third-party
// pages' HTML for structured data). TicketNetwork was registered once its
// provider stopped being an inert MWS-pending scaffold and started
// delegating to a real, working integration (Impact.com's affiliate
// catalog API — see TicketNetworkProvider.js/services/ticketnetwork.js).
const providers = {
  ticketmaster: new TicketmasterProvider(),
  seatgeek: new SeatGeekProvider(),
  ticketnetwork: new TicketNetworkProvider(),
};

// Look up a provider by name (case-insensitive). Returns undefined for an
// unknown name — callers should handle that explicitly rather than assume
// every name resolves, since the registry is expected to grow.
export function getProvider(name) {
  return providers[String(name || '').toLowerCase()];
}

export function listProviderNames() {
  return Object.keys(providers);
}

export default { getProvider, listProviderNames };
