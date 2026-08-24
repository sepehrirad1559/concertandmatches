import { TicketmasterProvider } from './TicketmasterProvider.js';
import { SeatGeekProvider } from './SeatGeekProvider.js';

// Single shared instance per provider — these wrappers are stateless
// (they just delegate to the underlying service functions), so there's no
// reason to construct a new one per request.
//
// Only official, authenticated REST APIs are registered here — see
// backend/DATA_SOURCES.md. A StubHub provider and an "official sites"
// JSON-LD-scraping provider used to be registered too; both were removed
// (StubHub was an unverified/unofficial skeleton never wired into any
// sync job, and the official-sites provider scraped arbitrary third-party
// pages' HTML for structured data) so the registry can't be pointed at
// anything but Ticketmaster/SeatGeek without adding a new provider file.
const providers = {
  ticketmaster: new TicketmasterProvider(),
  seatgeek: new SeatGeekProvider(),
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
