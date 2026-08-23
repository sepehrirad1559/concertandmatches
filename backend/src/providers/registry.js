import { TicketmasterProvider } from './TicketmasterProvider.js';
import { SeatGeekProvider } from './SeatGeekProvider.js';
import { StubHubProvider } from './StubHubProvider.js';
import { OfficialSiteProvider } from './OfficialSiteProvider.js';

// Single shared instance per provider — these wrappers are stateless
// (they just delegate to the underlying service functions), so there's no
// reason to construct a new one per request.
const providers = {
  ticketmaster: new TicketmasterProvider(),
  seatgeek: new SeatGeekProvider(),
  stubhub: new StubHubProvider(),
  official: new OfficialSiteProvider(),
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
