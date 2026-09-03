# TicketNetwork Mercury Web Services (MWS) — draft application content

**Status: draft only, not submitted.** This is content for Masoud to review, edit,
and submit himself at the Mercury Web Services application form
(mercurywebservices.com — a Pabbly-hosted form, per prior research this
session). I have not been able to re-open that form this session (no browser
connection), so I haven't confirmed the exact current field list/order —
treat the section headers below as "what MWS applications for this kind of
integration typically ask for," and adapt to whatever the live form actually
shows. This is a real business application tied to a Data Sharing Agreement,
so it needs real company details filled in by Masoud — I've left every
business-specific value as a `[bracketed placeholder]` rather than guessing.

Why this is separate from the Impact.com affiliate program: Impact.com
already approved ConcertAndMatches for TicketNetwork's *affiliate* program
(commission-only tracked link, live today). MWS is a completely different
product — TicketNetwork's actual ticket inventory/data feed API — and getting
real TicketNetwork listings onto event pages (rather than today's blind
"Search on TicketNetwork" button) requires MWS access instead.

---

## Company / contact information

- Company name: `[legal business name, or "Masoud [last name], sole proprietor" if unincorporated]`
- Website: https://concertandmatches.com
- Contact name: Masoud
- Contact email: sepehrirad15@gmail.com
- Company address: `[business address]`
- Phone: `[phone number]`

## About the business

ConcertAndMatches.com is an event-discovery and ticket price-comparison site.
It aggregates live event and ticket listings from official, authenticated
partner APIs (currently the Ticketmaster Discovery API and the SeatGeek
Platform API) and presents them to visitors, with outbound affiliate links to
each seller's own checkout to complete a purchase — ConcertAndMatches never
sells tickets directly or holds inventory itself.

Suggested language for a "tell us about your business / how you plan to use
our data" field:

> ConcertAndMatches.com is a live event discovery and ticket price-comparison
> platform. We currently integrate the Ticketmaster Discovery API and
> SeatGeek Platform API to show visitors real-time event listings and
> side-by-side pricing, with affiliate links to complete purchase on the
> seller's site. We're an approved TicketNetwork Impact.com affiliate and
> would like to extend that relationship to include TicketNetwork's Mercury
> Web Services inventory feed, so TicketNetwork listings can appear
> alongside Ticketmaster/SeatGeek in our comparison results (not replacing
> either), with outbound purchase links carrying our TicketNetwork affiliate
> tracking.

## Technical / integration details

- Current tech stack: Node.js/Express backend, React frontend, PostgreSQL.
- Existing integration pattern: each data source is a small service module
  (auth, pagination, field mapping) behind a common `ProviderInterface`
  (`sync()` / `backfillPrices()`), called on a scheduled sync job. A
  TicketNetwork service would follow the same pattern — see
  `backend/src/providers/TicketNetworkProvider.js` (currently an inert,
  unregistered scaffold pending these credentials).
- Expected call pattern: scheduled polling sync (not per-visitor real-time
  lookups), similar cadence to the existing Ticketmaster/SeatGeek syncs.
- Data use: display-only (event/ticket listings, pricing), with outbound
  affiliate links back to TicketNetwork for purchase — no resale, no
  inventory caching beyond normal display-refresh needs, no other
  redistribution of TicketNetwork's data.

## Traffic / scale (fill in with real current numbers before submitting)

- Monthly unique visitors: `[number, or "pre-launch/early stage" if not yet meaningful]`
- Monthly pageviews: `[number]`
- Approximate ticket-sale referral volume today (via Ticketmaster/SeatGeek
  affiliate links): `[number or "not yet tracked/early stage"]`

MWS applications reportedly emphasize that they're built for established,
higher-volume operators, so an honest, modest-but-growing answer here (with
the existing Ticketmaster/SeatGeek Impact.com approvals as evidence of a real,
working affiliate operation) is more credible than inflating numbers — and
the Data Sharing Agreement will bind whatever is represented here.

## Existing partnerships (supporting evidence)

- Ticketmaster: Impact.com affiliate program, approved.
- SeatGeek: Impact.com affiliate program, approved.
- TicketNetwork: Impact.com affiliate program, approved (this application is
  to extend that into the data/inventory side).

---

### Before submitting

1. Confirm the live form's actual fields at mercurywebservices.com and copy
   the relevant language above into them (the sections here are a superset —
   skip anything the real form doesn't ask).
2. Fill in every `[bracketed placeholder]` with real information — this
   becomes part of a binding Data Sharing Agreement if approved.
3. Have the actual company/contact details ready (legal name, address,
   phone) since this is a real business relationship, not a self-serve API
   signup.
