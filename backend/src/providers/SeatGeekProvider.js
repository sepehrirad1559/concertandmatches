import { ProviderInterface } from './ProviderInterface.js';
import { syncSeatGeekEvents, backfillMissingPrices } from '../services/seatgeek.js';

// Thin wrapper around the existing, live services/seatgeek.js functions —
// behavior is unchanged, this just gives it the common Provider shape.
export class SeatGeekProvider extends ProviderInterface {
  constructor() {
    super('seatgeek');
  }

  // perState defaults to 300 (paginated internally, since SeatGeek's API
  // caps a single request at 100) — see services/seatgeek.js's
  // syncSeatGeekEvents comment for why region-segmented fetching replaced
  // the old flat totalWanted approach, and why 300/state was chosen next.
  async sync(perState = 300) {
    return syncSeatGeekEvents(perState);
  }

  async backfillPrices(limit = 100) {
    return backfillMissingPrices(limit);
  }
}

export default SeatGeekProvider;
