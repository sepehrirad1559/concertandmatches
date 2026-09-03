import { ProviderInterface } from './ProviderInterface.js';

// INERT SCAFFOLD — NOT REGISTERED, NOT FUNCTIONAL. Do not add this to
// registry.js until it is genuinely wired up. See backend/DATA_SOURCES.md:
// this codebase's policy is real, authenticated official APIs only, and
// registering an unbacked provider here would repeat the exact mistake
// that got the old StubHub skeleton and the JSON-LD "official sites"
// scraper removed.
//
// Why this file exists at all: TicketNetwork's Impact.com AFFILIATE
// program is approved (commission-only tracked link — see
// TICKETNETWORK_TRACKED_LINK in frontend/src/App.jsx), but that is a
// completely separate thing from TicketNetwork's actual ticket INVENTORY
// API, called Mercury Web Services (MWS). MWS requires its own formal
// business application and a signed Data Sharing Agreement (see
// docs/ticketnetwork-mws-application-draft.md for the drafted application
// content) — we do not have MWS credentials as of this writing.
//
// Once a real MWS API key + Data Sharing Agreement exist:
//   1. Write backend/src/services/ticketnetwork.js with the real fetch/auth/
//      pagination/field-mapping logic (following services/ticketmaster.js or
//      services/seatgeek.js as the pattern), reading credentials from env
//      vars (e.g. TICKETNETWORK_MWS_API_KEY) — never hardcoded.
//   2. Fill in sync()/backfillPrices() below to delegate to that service,
//      exactly like SeatGeekProvider/TicketmasterProvider do.
//   3. Only THEN add `ticketnetwork: new TicketNetworkProvider()` to
//      registry.js's providers map.
//   4. Add 'ticketnetwork.com' to redirect.js's ALLOWED_HOST_SUFFIXES if
//      offer links will route through /go, and update App.jsx's
//      buildFindTicketsLinks to build real per-event offer links (like
//      Ticketmaster/SeatGeek) instead of today's blind per-event search
//      link, once event.offers can actually include confirmed TicketNetwork
//      listings.
export class TicketNetworkProvider extends ProviderInterface {
  constructor() {
    super('ticketnetwork');
  }

  async sync(/* options */) {
    throw new Error(
      'TicketNetworkProvider.sync() is an inert scaffold — Mercury Web ' +
        'Services credentials are not configured. See the comment at the ' +
        'top of this file before implementing or registering this provider.'
    );
  }

  async backfillPrices(/* limit */) {
    return {
      success: false,
      error:
        'TicketNetworkProvider is an inert scaffold (no Mercury Web Services credentials yet) — backfillPrices() is not implemented.',
    };
  }
}

export default TicketNetworkProvider;
