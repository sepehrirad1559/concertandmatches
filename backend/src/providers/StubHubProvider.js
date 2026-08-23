import { ProviderInterface } from './ProviderInterface.js';
import { syncStubHubEvents } from '../services/stubhub.js';

// Thin wrapper around the existing, live services/stubhub.js functions.
// Not currently wired into any admin route (StubHub isn't synced from the
// dashboard yet — that needs a real affiliate account, which is on the
// user's side to set up), but registered here so the provider registry is
// ready for it the moment that changes. No backfillPrices() override:
// stubhub.js doesn't have a missing-price backfill function today, so this
// correctly falls back to ProviderInterface's "not implemented" response
// rather than fabricating one.
export class StubHubProvider extends ProviderInterface {
  constructor() {
    super('stubhub');
  }

  async sync(totalWanted = 300) {
    return syncStubHubEvents(totalWanted);
  }
}

export default StubHubProvider;
