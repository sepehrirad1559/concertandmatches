# 👀 What You'll See When Running EventFlow

Visual guide to what appears on your screen when the platform is running.

## 🌟 Main App - http://localhost:5173

### The Homepage (First Load)
```
┌─────────────────────────────────────────────────────────────┐
│  EventFlow                                                  │
│  Discover events. Compare prices. Buy tickets.              │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  [Search events...]  [All Categories ▼]  [Search]           │
│  [Date range]        [Price range]                           │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  No events found. Try a different search.                   │
│  (This is normal - events are being discovered)             │
└─────────────────────────────────────────────────────────────┘
```

### After Typing "Concert" and Clicking Search

**First 10 seconds:**
```
┌─────────────────────────────────────────────────────────────┐
│  [Searching...]                                             │
│  [Loading spinner animation]                                │
└─────────────────────────────────────────────────────────────┘
```

**After 1-2 minutes (once events are discovered):**
```
┌──────────────────────┬──────────────────────┬──────────────────────┐
│  Event Card 1        │  Event Card 2        │  Event Card 3        │
│  ┌────────────────┐  │  ┌────────────────┐  │  ┌────────────────┐  │
│  │ [Event Image]  │  │  │ [Event Image]  │  │  │ [Event Image]  │  │
│  │                │  │  │                │  │  │                │  │
│  │ Taylor Swift   │  │  │ The Weeknd     │  │  │ Coldplay       │  │
│  │ Concert        │  │  │ Stadium Tour   │  │  │ World Tour     │  │
│  │                │  │  │                │  │  │                │  │
│  │ Oct 15, 2024   │  │  │ Nov 3, 2024    │  │  │ Dec 1, 2024    │  │
│  │ From $89.99    │  │  │ From $125.00   │  │  │ From $99.99    │  │
│  │ concert        │  │  │ concert        │  │  │ concert        │  │
│  │                │  │  │                │  │  │                │  │
│  │ [View Tickets] │  │  │ [View Tickets] │  │  │ [View Tickets] │  │
│  │ (12 listings)  │  │  │ (8 listings)   │  │  │ (15 listings)  │  │
│  └────────────────┘  │  └────────────────┘  │  └────────────────┘  │
└──────────────────────┴──────────────────────┴──────────────────────┘

[More events below, scroll to see...]
```

### When You Click "View Tickets (12 listings)"

```
┌─────────────────────────────────────────────────────────────┐
│  ← Back                                                      │
├─────────────────────────────────────────────────────────────┤
│  TAYLOR SWIFT CONCERT                                       │
│                                                              │
│  📅 October 15, 2024 at 7:30 PM                             │
│  📍 Madison Square Garden, New York                          │
│  🎭 Concert                                                  │
│                                                              │
│  Starting Price: $89.99                                      │
│  Available from 12 sources                                   │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Ticket Listings from All Sources                   │   │
│  ├──────────────────────────────────────────────────────┤   │
│  │  Section 112, Row 8                                 │   │
│  │  Ticketmaster                    $89.99  [→ Buy]    │   │
│  │  StubHub (Resale)                $125.00 [→ Buy]    │   │
│  │  SeatGeek                        $92.50  [→ Buy]    │   │
│  │                                                      │   │
│  │  Section 101, Row 1                                 │   │
│  │  Ticketmaster                    $199.99 [→ Buy]    │   │
│  │  Vivid Seats                     $205.00 [→ Buy]    │   │
│  │                                                      │   │
│  │  General Admission - Upper Level                    │   │
│  │  Ticketmaster                    $79.99  [→ Buy]    │   │
│  │  Facebook (Fan Exchange)         $85.00  [→ Buy]    │   │
│  │  StubHub                         $88.50  [→ Buy]    │   │
│  └──────────────────────────────────────────────────────┘   │
│  Powered by Ticketmaster, StubHub, SeatGeek                 │
└─────────────────────────────────────────────────────────────┘
```

---

## 📊 Admin Dashboard - http://localhost:3001

### Overview Tab
```
┌─────────────────────────────────────────────────────────────┐
│  EventFlow Admin                              [Refresh] ↻   │
├─────────────────────────────────────────────────────────────┤
│  Overview │ Data Sources │ Crawler Status │ Entity Matching │
├─────────────────────────────────────────────────────────────┤
│
│  ┌──────────────────┐  ┌──────────────────┐
│  │ Events Discovered│  │ Listings Indexed │
│  │      12,547      │  │     142,893      │
│  │    Database 🗄️   │  │    Database 🗄️   │
│  └──────────────────┘  └──────────────────┘
│
│  ┌──────────────────┐  ┌──────────────────┐
│  │ Active Sources   │  │ Success Rate     │
│  │        4         │  │      94.2%       │
│  │    Sources ⚙️    │  │    Success ✓     │
│  └──────────────────┘  └──────────────────┘
│
│  Crawl Performance by Source
│  ┌────────────────────────────────────────────┐
│  │   Events ████████████████████████          │
│  │  Listings ████████████████████████░░░░░     │
│  │           ▼                                 │
│  │  Ticketmaster   Eventbrite   StubHub      │
│  └────────────────────────────────────────────┘
│
└─────────────────────────────────────────────────────────────┘
```

### Data Sources Tab
```
┌─────────────────────────────────────────────────────────────┐
│  Data Sources                            [+ Add Source]     │
├─────────────────────────────────────────────────────────────┤
│
│  ┌───────────────────────────────────────────────────────┐  │
│  │ Source Name    Type    Events    Listings    Status   │  │
│  ├───────────────────────────────────────────────────────┤  │
│  │ Ticketmaster   api     8,234     85,234    ✓ Enabled │  │
│  │ Eventbrite     api     3,421     42,321    ✓ Enabled │  │
│  │ StubHub        api       892     15,338    ✓ Enabled │  │
│  │ SeatGeek       api         0          0    ⊘ Disabled│  │
│  │ VividSeats     api         0          0    ⊘ Disabled│  │
│  └───────────────────────────────────────────────────────┘  │
│
│  Click ⚙️ icon to edit source settings
│
└─────────────────────────────────────────────────────────────┘
```

### Crawler Status Tab
```
┌─────────────────────────────────────────────────────────────┐
│  Crawler Status                                              │
├─────────────────────────────────────────────────────────────┤
│
│  Ticketmaster
│  ├─ Last crawl: 2 minutes ago (Success ✓)
│  ├─ Events: 8,234 | Listings: 85,234
│  └─ Success Rate: 98.5%
│
│  Eventbrite
│  ├─ Last crawl: 5 minutes ago (Success ✓)
│  ├─ Events: 3,421 | Listings: 42,321
│  └─ Success Rate: 94.2%
│
│  StubHub
│  ├─ Last crawl: 3 minutes ago (Success ✓)
│  ├─ Events: 892 | Listings: 15,338
│  └─ Success Rate: 91.8%
│
│  SeatGeek
│  ├─ Last crawl: Never (Disabled)
│  ├─ Events: 0 | Listings: 0
│  └─ Success Rate: N/A
│
└─────────────────────────────────────────────────────────────┘
```

### Entity Matching Tab
```
┌─────────────────────────────────────────────────────────────┐
│  Entity Matching Review                                      │
├─────────────────────────────────────────────────────────────┤
│
│  No pending matches for review
│  (Duplicates are auto-detected and merged)
│
│  All events have been verified! ✓
│
└─────────────────────────────────────────────────────────────┘
```

---

## 💾 Database Browser - http://localhost:8080

### Login Screen
```
┌─────────────────────────────────────────────────────────────┐
│  Adminer                                                     │
├─────────────────────────────────────────────────────────────┤
│
│  Database System: PostgreSQL
│  Server:         postgres
│  Username:       eventflow
│  Password:       eventflow
│  Database:       eventflow
│
│                    [Login]
│
└─────────────────────────────────────────────────────────────┘
```

### After Login - Main Database View
```
┌─────────────────────────────────────────────────────────────┐
│  Adminer - eventflow Database                               │
├─────────────────────────────────────────────────────────────┤
│
│  Tables:
│  ├─ artists (847 rows)
│  ├─ events (12,547 rows)
│  ├─ external_events (15,234 rows)
│  ├─ listings (142,893 rows)
│  ├─ external_listings (156,123 rows)
│  ├─ sources (4 rows)
│  ├─ crawler_logs (1,247 rows)
│  ├─ inventory_snapshots (2,456,234 rows)
│  ├─ venues (3,421 rows)
│  ├─ artist_aliases (1,234 rows)
│  └─ ... (42 tables total)
│
│  Click any table to view the data
│
└─────────────────────────────────────────────────────────────┘
```

### Events Table View
```
┌─────────────────────────────────────────────────────────────┐
│  events Table (12,547 rows)                                  │
├─────────────────────────────────────────────────────────────┤
│
│  id │ title              │ start_time          │ category
│  ───┼────────────────────┼─────────────────────┼──────────
│  1  │ Taylor Swift       │ 2024-10-15 19:30    │ concert
│  2  │ The Weeknd         │ 2024-11-03 20:00    │ concert
│  3  │ Coldplay           │ 2024-12-01 19:00    │ concert
│  4  │ NYC vs Lakers      │ 2024-10-20 19:00    │ sports
│  5  │ Hamilton Broadway  │ 2024-10-16 20:00    │ theater
│  ...│ ...                │ ...                 │ ...
│
│  (Shows new rows as they're discovered)
│
└─────────────────────────────────────────────────────────────┘
```

---

## 🖥️ Terminal Output Examples

### Terminal 1 - Backend API Starting
```
$ npm run dev

> eventflow-backend@1.0.0 dev
> ts-node src/index.ts

[EventFlow-API] EventFlow API listening on http://localhost:3000
[EventFlow-API] Environment: development
```

### Terminal 2 - Crawler Jobs Starting
```
$ npm run jobs:start

> eventflow-backend@1.0.0 jobs:start
> ts-node src/jobs/worker.ts

[Job-Worker] Starting job worker...
[Job-Worker] Scheduling crawler jobs...
[Job-Worker] Scheduled jobs for source: Ticketmaster
[Job-Worker] Scheduled jobs for source: Eventbrite
[Job-Worker] Scheduled jobs for source: StubHub
[Job-Worker] Job worker started and jobs scheduled
```

### Then You'll See Crawler Output
```
[IngestionService] Starting event discovery for source: Ticketmaster
[IngestionService] Discovered 342 events from Ticketmaster
[IngestionService] Event discovery completed: {
  discovered: 342,
  created: 285,
  matched: 57,
  errors: 0
}
✓ Event discovery job completed

[IngestionService] Starting inventory sync for source: Ticketmaster
[IngestionService] Found 285 matched events to sync
[IngestionService] Marked 42 listings as stale
[IngestionService] Inventory sync completed: {
  discovered: 8234,
  updated: 8234,
  errors: 0
}
✓ Inventory sync job completed
```

### Terminal 3 - Frontend Starting
```
$ npm run dev

  VITE v5.0.8  ready in 123 ms

  ➜  Local:   http://localhost:5173/
  ➜  press h to show help
```

### Terminal 4 - Admin Dashboard Starting
```
$ npm run dev

  VITE v5.0.8  ready in 99 ms

  ➜  Local:   http://localhost:3001/
  ➜  press h to show help
```

---

## 🔄 Real-Time Updates You'll See

### In the Frontend App
- Search results update as new events are discovered
- Prices change in real-time as crawlers update
- New listings appear within seconds

### In the Admin Dashboard
- Metrics update every few seconds
- Crawler Status tab shows activity in real-time
- Numbers increment as events are discovered

### In the Database Browser
- Refresh the tables to see new rows appearing
- `events` count increases
- `listings` count increases
- `crawler_logs` shows execution history

### In the Terminal Output
- You'll see crawler jobs executing
- Discovery results printed
- Any errors logged

---

## 🎊 Success Checklist

When everything is working, you should see:

✅ **Frontend loads** at http://localhost:5173
✅ **Search bar is visible** with working filters
✅ **Admin dashboard loads** at http://localhost:3001
✅ **Metrics are displayed** in admin dashboard
✅ **Database browser works** at http://localhost:8080
✅ **Tables have data** when you browse in database
✅ **Terminal shows crawler output** in Terminal 2
✅ **No error messages** in any terminal
✅ **Events appear** when searching (after 1-2 minutes)

---

## 🚀 What's Happening Behind the Scenes

While you're looking at these screens:

1. **Crawler (Terminal 2)** is discovering events from Ticketmaster
2. **Database** is storing all events and listings
3. **Frontend** is querying the database for search results
4. **Admin Dashboard** is showing real-time metrics
5. **API** is handling all requests

All of this is happening **automatically and continuously**.

---

## 💡 Pro Tips

- **Watch numbers grow** - Check admin dashboard every minute
- **Refresh database** - Click refresh in http://localhost:8080
- **Check logs** - Terminal output shows what's happening
- **Hard refresh** - If web pages look wrong, Ctrl+Shift+R
- **Keep terminals open** - Don't close any while you're testing

---

Enjoy exploring your event aggregation platform! 🎉
