// Shared pricing helpers for the plain server-rendered SEO pages
// (routes/guides.js, routes/seoPages.js). Those pages are raw HTML, not
// the React SPA, so they don't get frontend/src/App.jsx's price logic for
// free -- this file mirrors it by hand so the two never silently drift.
//
// 1) TicketNetwork discount: a real, ongoing, sitewide 20% price drop on
//    TicketNetwork-sourced listings (per product decision, 2026-10-30 --
//    see frontend/src/App.jsx's TICKETNETWORK_DISCOUNT_RATE/
//    getDisplayPriceLabels, already shown on the event detail page and the
//    homepage "From $X" line). Kept in sync BY HAND -- if the rate or the
//    "only TicketNetwork" condition ever changes in one place, change it
//    in the other too.
//
// 2) $0 price bug (found 2026-11-02 while fixing the guide pages, which
//    were showing e.g. "ticketmaster: $0" as if it were a real price):
//    Ticketmaster's Discovery API sometimes returns `priceRanges[0].min
//    === 0` for shows that are not actually free -- see
//    services/ticketmaster.js's minPrice derivation, which accepts any
//    value >= 0 and stores it as-is. A "$0" / "starting from $0" headline
//    on a comparison page reads as broken, not as a deal, and real
//    tickets are never actually free here, so a non-positive min_price is
//    treated exactly like "no price data" everywhere a display price is
//    derived below -- never shown, never allowed to win a
//    cheapest/best-price comparison.
export const TICKETNETWORK_DISCOUNT_RATE = 0.2;

// offer: { min_price, source }. Returns null when there's no real,
// positive price to show (missing OR <= 0) -- callers should treat that
// exactly like "Price not listed" elsewhere on the site. Otherwise returns
// { price, originalPrice, isDiscounted }: `price` is what should be
// displayed/compared, `originalPrice` is the pre-discount figure to show
// struck through (only set when isDiscounted is true).
export function displayPriceForOffer(offer) {
  if (!offer || offer.min_price == null) return null;
  const raw = Number(offer.min_price);
  if (!(raw > 0)) return null;
  const isDiscounted = offer.source === 'ticketnetwork';
  const price = isDiscounted ? Math.round(raw * (1 - TICKETNETWORK_DISCOUNT_RATE)) : raw;
  return { price, originalPrice: isDiscounted ? raw : null, isDiscounted };
}

// Cheapest real display price across one event's offers (discount already
// applied), or null if none of its offers have a usable price.
export function cheapestDisplayPrice(event) {
  const prices = (event.offers || [])
    .map((o) => displayPriceForOffer(o))
    .filter(Boolean)
    .map((d) => d.price);
  return prices.length > 0 ? Math.min(...prices) : null;
}

// True if this event has at least one offer that's actually rendering the
// TicketNetwork discount (a real, positively-priced TicketNetwork offer) --
// not just "could in theory," so the disclosure note below never appears
// on a page where it wouldn't be true.
export function hasDiscountedOffer(event) {
  return (event.offers || []).some((o) => {
    const d = displayPriceForOffer(o);
    return d && d.isDiscounted;
  });
}

// Shared disclosure footer for every guide/SEO page (added 2026-11-02, at
// the user's request to surface the real TicketNetwork discount directly
// in the generated SEO copy, not just on the event detail page). Only
// renders when at least one event on THIS page actually has a discounted
// TicketNetwork offer -- never a blanket claim on a page that doesn't.
export function discountFooterNote(events) {
  const any = (events || []).some(hasDiscountedOffer);
  if (!any) return '';
  const pct = Math.round(TICKETNETWORK_DISCOUNT_RATE * 100);
  return `<p>TicketNetwork tickets shown above are listed at ${pct}% off their regular price — the discounted price is what's shown, with the original price struck through.</p>`;
}
