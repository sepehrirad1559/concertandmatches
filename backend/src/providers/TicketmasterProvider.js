import { ProviderInterface } from './ProviderInterface.js';
import { syncAllEvents, backfillMissingPrices } from '../services/ticketmaster.js';

// Thin wrapper around the existing, live services/ticketmaster.js functions
// — behavior is unchanged, this just gives it the common Provider shape.
export class TicketmasterProvider extends ProviderInterface {
  constructor() {
    super('ticketmaster');
  }

  async sync() {
    return syncAllEvents();
  }

  async backfillPrices(limit = 100) {
    return backfillMissingPrices(limit);
  }
}

export default TicketmasterProvider;
