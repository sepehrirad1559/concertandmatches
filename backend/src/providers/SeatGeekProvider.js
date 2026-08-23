import { ProviderInterface } from './ProviderInterface.js';
import { syncSeatGeekEvents, backfillMissingPrices } from '../services/seatgeek.js';

// Thin wrapper around the existing, live services/seatgeek.js functions —
// behavior is unchanged, this just gives it the common Provider shape.
export class SeatGeekProvider extends ProviderInterface {
  constructor() {
    super('seatgeek');
  }

  async sync(totalWanted = 3000) {
    return syncSeatGeekEvents(totalWanted);
  }

  async backfillPrices(limit = 100) {
    return backfillMissingPrices(limit);
  }
}

export default SeatGeekProvider;
