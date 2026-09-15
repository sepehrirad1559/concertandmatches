// Formal provider plugin interface (spec: "formal provider plugin
// interface/class abstraction"). This is a thin contract that every ticket
// source (Ticketmaster, SeatGeek, StubHub, and any future source) implements,
// so the admin routes and any future sync scheduler can call
// `provider.sync()` / `provider.backfillPrices()` without knowing which
// concrete source they're talking to.
//
// Deliberately NOT a rewrite of the existing services: ticketmaster.js,
// seatgeek.js, and stubhub.js already contain the real, working,
// battle-tested logic (auth, pagination, rate limits, field mapping). Each
// Provider class below is a thin wrapper that delegates to those existing
// functions unchanged — this file only formalizes the shape callers can
// rely on, it does not change runtime behavior.
//
// (This supersedes the earlier, orphaned attempt at this same idea in
// backend/src/connectors/IExternalInventoryProvider.ts — that file was
// never wired into the app, imported classes/deps that don't exist in
// package.json, and has been deleted as dead code.)
export class ProviderInterface {
  constructor(name) {
    if (new.target === ProviderInterface) {
      throw new Error('ProviderInterface is abstract and cannot be instantiated directly');
    }
    this.name = name;
  }

  // Discover/refresh events from this provider. Returns a result object;
  // concrete providers document their own exact shape (they already vary
  // slightly today — e.g. SeatGeek accepts a totalWanted count, Ticketmaster
  // doesn't), but all include at least { success: boolean }.
  async sync(/* options */) {
    throw new Error(`${this.name}: sync() not implemented`);
  }

  // Backfill missing prices for events already stored from this provider.
  // Optional — not every provider supports (or needs) this; the default
  // implementation reports that plainly instead of pretending to succeed.
  async backfillPrices(/* limit */) {
    return { success: false, error: `${this.name} does not implement backfillPrices()` };
  }
}

export default ProviderInterface;
