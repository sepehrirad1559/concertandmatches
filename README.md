# EventFlow: Automated Event & Ticket Aggregation Marketplace

A complete, automated event and ticket inventory aggregation platform across the US and Canada. The platform continuously discovers, normalizes, and aggregates events from authorized external sources.

## ✨ Features

- **Automated Event Discovery** - Discovers events from licensed APIs and authorized sources
- **Entity Normalization** - Intelligently matches and normalizes venues, artists, teams, events
- **Inventory Aggregation** - Continuous sync of ticket listings and pricing
- **Multi-Source Price Comparison** - Display inventory from multiple sources side-by-side
- **Inventory Freshness** - Configurable sync schedules, staleness detection, anomaly detection
- **Source Management** - Admin control over crawling frequency, rate limits, compliance
- **Multiple Revenue Models** - Affiliate commissions, transaction fees, lead generation
- **Compliance-First** - Source authorization, terms tracking, data usage restrictions
- **Full-Text Search** - Fast event/venue search across aggregated inventory
- **Transaction Support** - Redirect/affiliate mode or direct API transactions

## 🏗️ Architecture

```
External Sources (APIs, feeds, permitted crawling)
        ↓
Source Connectors (standardized interface)
        ↓
Fetcher → Parser → Normalizer
        ↓
Entity Matching & Duplicate Detection
        ↓
PostgreSQL Database
        ↓
Elasticsearch Index
        ↓
REST API
        ↓
Frontend (Search, Event Pages, Listings)
Admin Dashboard (Source Control, Monitoring)
```

## 📦 Project Structure

```
eventflow/
├── backend/                    # Node.js/Express API
│   ├── src/
│   │   ├── database/          # PostgreSQL schema, migrations
│   │   ├── models/            # TypeScript types & interfaces
│   │   ├── connectors/        # Source connector implementations
│   │   ├── services/          # Business logic
│   │   ├── routes/            # API endpoints
│   │   ├── jobs/              # Background job handlers
│   │   ├── utils/             # Helpers, validation
│   │   └── index.ts           # Server entry point
│   ├── migrations/            # DB migrations
│   ├── .env.example
│   ├── package.json
│   ├── tsconfig.json
│   └── Dockerfile
├── frontend/                   # React SPA
│   ├── src/
│   │   ├── components/        # React components
│   │   ├── pages/             # Route pages
│   │   ├── services/          # API client
│   │   ├── store/             # State management
│   │   └── App.tsx
│   ├── package.json
│   └── Dockerfile
├── admin/                      # Admin dashboard
│   ├── src/
│   │   ├── pages/
│   │   ├── components/
│   │   └── App.tsx
│   └── package.json
├── docker-compose.yml         # Local dev environment
├── .env.example
└── README.md
```

## 🚀 Quick Start

### Prerequisites
- Node.js 18+
- Docker & Docker Compose
- PostgreSQL 14+
- Redis 7+

### 1. Clone & Setup

```bash
git clone https://github.com/yourorg/eventflow.git
cd eventflow
cp .env.example .env
```

### 2. Start Services (Docker)

```bash
docker-compose up -d
```

This starts:
- PostgreSQL (port 5432)
- Redis (port 6379)
- Elasticsearch (port 9200)

### 3. Install Dependencies

```bash
cd backend && npm install
cd ../frontend && npm install
cd ../admin && npm install
```

### 4. Setup Database

```bash
cd backend
npm run migrate:latest
npm run seed  # Load sample data
```

### 5. Configure Sources

```bash
# Copy .env.example to .env and fill in API keys:
TICKETMASTER_API_KEY=your_key
EVENTBRITE_API_KEY=your_key
STUBHUB_API_KEY=your_key
```

### 6. Start Services

Terminal 1 - Backend:
```bash
cd backend
npm run dev
```

Terminal 2 - Frontend:
```bash
cd frontend
npm run dev
```

Terminal 3 - Admin:
```bash
cd admin
npm run dev
```

## 📋 API Endpoints

### Public API
- `GET /api/v1/events` - Search events
- `GET /api/v1/events/:id` - Event details
- `GET /api/v1/venues` - Search venues
- `GET /api/v1/listings` - Search listings
- `POST /api/v1/listings/:id/click` - Track listing click

### Admin API
- `GET /api/v1/admin/sources` - List sources
- `POST /api/v1/admin/sources` - Create source
- `PATCH /api/v1/admin/sources/:id` - Update source
- `GET /api/v1/admin/crawler/status` - Crawler health
- `GET /api/v1/admin/entity-matching/pending` - Review duplicates
- `POST /api/v1/admin/entity-matching/merge` - Merge entities

## 🔧 Configuration

### Source Configuration Example

```json
{
  "name": "Ticketmaster",
  "type": "api",
  "country": "US,CA",
  "auth_method": "api_key",
  "enabled": true,
  "update_frequency_minutes": 15,
  "rate_limit_requests": 100,
  "rate_limit_window_seconds": 60,
  "freshness_threshold_minutes": 30,
  "revenue_model": "affiliate",
  "affiliate_network": "Ticketmaster Affiliate",
  "affiliate_id": "your_affiliate_id"
}
```

## 🗄️ Database Schema

Key tables:
- `events` - Canonical events
- `external_events` - Events from sources
- `event_matches` - Event deduplication
- `venues` - Canonical venues
- `external_venues` - Venue records from sources
- `artists` - Artists/performers
- `listings` - Ticket listings
- `external_listings` - Original external listings
- `sources` - Source configuration
- `source_compliance` - Compliance tracking
- `inventory_snapshots` - Historical pricing/availability
- `crawler_logs` - Ingestion history

## 🤖 Background Jobs

Via BullMQ/Redis:
- `event_discovery` - Discover new events (configurable frequency per source)
- `event_update` - Update existing events
- `inventory_sync` - Sync ticket listings (high priority)
- `price_update` - Track price changes
- `venue_sync` - Update venue information
- `artist_sync` - Update artist information
- `duplicate_detection` - Find & flag duplicate events
- `anomaly_detection` - Detect parser failures
- `freshness_check` - Mark stale inventory
- `affiliate_tracking` - Record conversions

## 🔐 Compliance & Security

- ✅ Source authorization tracking
- ✅ Terms of service compliance matrix
- ✅ No unauthorized scraping/CAPTCHA bypass
- ✅ API rate limit enforcement per source
- ✅ Source attribution on all listings
- ✅ Data retention policies
- ✅ Geographic restrictions honored
- ✅ Audit logging for all source changes

## 📊 Admin Dashboard Features

- Source management (enable/disable, rate limits, frequency)
- Crawler monitoring (health, errors, coverage)
- Entity matching review (approve/merge duplicates)
- Analytics (events indexed, listings aggregated, price trends)
- Error logs and anomaly detection
- Compliance status per source

## 🚢 Deployment

### Production Docker

```bash
docker-compose -f docker-compose.prod.yml up -d
```

This includes:
- Load balancing
- Database replication
- Redis clustering
- Elasticsearch sharding
- Monitoring (Prometheus/Grafana)

### Environment Variables

See `.env.example` for complete list. Key vars:
- `DATABASE_URL` - PostgreSQL connection
- `REDIS_URL` - Redis connection
- `NODE_ENV` - production/development/test
- `LOG_LEVEL` - debug/info/warn/error
- `API_PORT` - Express server port
- Various API keys for sources

## 🧪 Testing

```bash
cd backend
npm run test                 # Unit tests
npm run test:integration    # Integration tests
npm run test:crawler        # Crawler tests
```

## 📈 Monitoring

- Application logs → `/logs`
- Crawler metrics → Admin dashboard
- Database performance → PostgreSQL EXPLAIN
- Redis queue depth → BullMQ UI on port 3001

## 🤝 Adding a New Source

1. Create connector at `backend/src/connectors/source-name.ts`
2. Implement `IExternalInventoryProvider` interface
3. Add source config to admin
4. Enable crawler jobs for that source
5. Monitor ingestion in admin dashboard

See `CONNECTOR_TEMPLATE.md` for detailed guide.

## 📄 License

Proprietary - All Rights Reserved

## 🆘 Support

- Issues: GitHub Issues
- Docs: `/docs`
- API Docs: `http://localhost:3000/api-docs`
