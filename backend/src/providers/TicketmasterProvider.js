import { ProviderInterface } from './ProviderInterface.js';
import { syncAllEvents, syncClosestEvents, backfillMissingPrices } from '../services/ticketmaster.js';

// Thin wrapper around the existing, live services/ticketmaster.js functions
// — behavior is unchanged, this just gives it the common Provider shape.
export class TicketmasterProvider extends ProviderInterface {
  constructor() {
    super('ticketmaster');
  }

  async sync() {
    return syncAllEvents();
  }

  // Bounded alternative to sync() above: fetches/stores only the `limit`
  // events with the soonest dates instead of the entire catalog. See
  // services/ticketmaster.js's syncClosestEvents for how "closest by date"
  // is determined across every segment/country.
  async syncClosest(limit = 5000) {
    return syncClosestEvents(limit);
  }

  async backfillPrices(limit = 100) {
    return backfillMissingPrices(limit);
  }
}

export default TicketmasterProvider;
