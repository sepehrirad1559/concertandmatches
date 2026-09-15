import { ProviderInterface } from './ProviderInterface.js';
import { syncTicketNetworkEvents } from '../services/ticketnetwork.js';

// Thin wrapper around services/ticketnetwork.js — behavior lives there,
// this just gives it the common Provider shape (see ProviderInterface.js).
//
// This REPLACES an earlier inert scaffold that assumed TicketNetwork could
// only be integrated via Mercury Web Services (MWS), a separate enterprise
// inventory API requiring its own business application and Data Sharing
// Agreement we never got approved (see docs/ticketnetwork-mws-application-
// draft.md for that abandoned attempt). That assumption turned out to be
// wrong: TicketNetwork's Impact.com AFFILIATE program — already approved on
// this account — exposes a real, live, ~210k-item product catalog with
// venue/date/price data via Impact's own Partner REST API. No MWS
// credentials needed; see services/ticketnetwork.js for the full mapping
// and citations.
export class TicketNetworkProvider extends ProviderInterface {
  constructor() {
    super('ticketnetwork');
  }

  // options: { maxPages, pageSize } — see services/ticketnetwork.js. Left
  // unset, pages through the entire catalog.
  async sync(options = {}) {
    return syncTicketNetworkEvents(options);
  }

  // Unlike Ticketmaster/SeatGeek, TicketNetwork's catalog items already
  // carry pricing (Text1) directly in the same listing used for discovery —
  // there's no separate per-event detail endpoint with better pricing to
  // backfill from, so a dedicated backfill pass doesn't apply here. A
  // re-sync (see sync() above) is what refreshes pricing, on the same
  // schedule the catalog itself updates (~daily).
  async backfillPrices(/* limit */) {
    return {
      success: false,
      error: 'TicketNetwork prices come directly from the catalog listing (Text1) — re-run sync() to refresh them, there is no separate backfill endpoint for this provider.',
    };
  }
}

export default TicketNetworkProvider;
