// Meta Pixel (Facebook + Instagram ads) integration.
//
// What this actually is: a small tracking script Meta gives you when you
// create a Pixel in Events Manager. It's not "the ad" — it's the thing
// that reports back which visitors on the site later matter for ads: who
// showed up, and (more importantly for a site like this one) who actually
// clicked through toward buying a ticket. Once real ad spend starts, this
// is what a Facebook/Instagram campaign optimizes against ("show this ad
// to people who look like the visitors who clicked through to buy") and
// what lets a campaign retarget someone who looked at an event but didn't
// click through yet.
//
// Reports two kinds of events:
//   1. PageView — once on load, then again on every client-side route
//      change. This is a single-page app (React Router swaps pages without
//      a real browser reload), and Meta's base snippet only ever fires
//      PageView once per script load — without calling trackMetaPageView()
//      on navigation, every page someone visits here would look like a
//      single pageview to Meta, making the whole site look like one page.
//   2. A "Lead" event whenever someone clicks through to a ticket seller —
//      the actual moment of value for a comparison site. This site never
//      sells tickets directly (see AffiliateDisclosure), so there's no
//      on-site "Purchase" event to report; the click-out to the seller IS
//      the conversion this site can actually observe and should optimize
//      ad spend toward.
//
// Does nothing at all until VITE_META_PIXEL_ID is set at build time (Vercel
// project -> Settings -> Environment Variables), so the site behaves
// identically before a real Pixel exists — safe to ship now and turn on
// later just by setting that one variable and redeploying.
//
// To get a Pixel ID: business.facebook.com/events_manager -> Connect Data
// Sources -> Web -> Meta Pixel -> follow the setup flow (no code needed
// from their side, they just hand you a numeric Pixel ID) -> set it as
// VITE_META_PIXEL_ID in Vercel -> redeploy.
const PIXEL_ID = import.meta.env.VITE_META_PIXEL_ID;

let initialized = false;

export function initMetaPixel() {
  if (initialized || !PIXEL_ID || typeof window === 'undefined') return;
  initialized = true;

  /* eslint-disable */
  (function (f, b, e, v, n, t, s) {
    if (f.fbq) return;
    n = f.fbq = function () {
      n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
    };
    if (!f._fbq) f._fbq = n;
    n.push = n;
    n.loaded = true;
    n.version = '2.0';
    n.queue = [];
    t = b.createElement(e);
    t.async = true;
    t.src = v;
    s = b.getElementsByTagName(e)[0];
    s.parentNode.insertBefore(t, s);
  })(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
  /* eslint-enable */

  window.fbq('init', PIXEL_ID);
  window.fbq('track', 'PageView');
}

// Call on every client-side route change (see App.jsx's useEffect on
// useLocation()) — see the file-level comment for why this is needed on a
// single-page app.
export function trackMetaPageView() {
  if (!PIXEL_ID || typeof window === 'undefined' || !window.fbq) return;
  window.fbq('track', 'PageView');
}

// Call when someone clicks through to a ticket seller — the real
// conversion event for this site (see the file-level comment). Meta's
// standard "Lead" event is the closest honest fit for "expressed real
// purchase intent and left our site to go complete it elsewhere," without
// claiming a Purchase actually happened, which this site has no way to
// confirm.
export function trackMetaTicketClick({ source, title, city, state } = {}) {
  if (!PIXEL_ID || typeof window === 'undefined' || !window.fbq) return;
  window.fbq('track', 'Lead', {
    content_name: title || undefined,
    content_category: source || undefined,
    city: city || undefined,
    region: state || undefined,
  });
}
