# EventFlow Architecture

Complete architecture overview of the automated event aggregation marketplace platform.

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        External Sources                          │
│  Ticketmaster | Eventbrite | StubHub | Custom APIs | Web Feeds  │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
        ┌──────────────────────────────┐
        │   Source Connectors          │
        │  (Standardized Interface)    │
        └────────────┬─────────────────┘
                     │
        ┌────────────▼──────────────────┐
        │  Ingestion Pipeline           │
        │ ┌────────────────────────┐   │
        │ │ Parser & Normalizer    │   │
        │ │ Entity Matcher         │   │
        │ │ Deduplication          │   │
        │ │ Freshness Management   │   │
        │ └────────────┬───────────┘   │
        │              │                │
        └──────────────┼────────────────┘
                       │
      ┌────────────────┴────────────────┐
      ▼                                  ▼
  ┌─────────────┐              ┌──────────────────┐
  │ PostgreSQL  │              │ Elasticsearch    │
  │ (Canonical  │              │ (Search Index)   │
  │  Data)      │              │                  │
  └──────┬──────┘              └────────┬─────────┘
         │                              │
         │                    ┌─────────▼─────────┐
         │                    │   Search Engine   │
         │                    │  (Full-text)      │
         │                    └───────────────────┘
         │
  ┌──────┴────────────────────────────────────────┐
  │                REST API Layer                 │
  │  ┌──────────────┐        ┌────────────────┐  │
  │  │ Public API   │        │  Admin API     │  │
  │  └──────────────┘        └────────────────┘  │
  └──────┬──────────────────────────────────────┬─┘
         │                                      │
   ┌─────▼────────┐                    ┌───────▼──────┐
   │  Frontend    │                    │ Admin        │
   │  (React)     │                    │ Dashboard    │
   │  Event Search│                    │ (React)      │
   └──────────────┘                    └──────────────┘
```

## Component Architecture

### 1. Data Ingestion Layer

**Source Connectors** (`backend/src/connectors/`)
- Standardized `IExternalInventoryProvider` interface
- Individual connector per source (Ticketmaster, Eventbrite, etc.)
- Handles API authentication, rate limiting, error recovery
- Maps external data to canonical schema

**Ingestion Service** (`backend/src/services/IngestionService.ts`)
- Orchestrates event discovery across all sources
- Processes discovered events and inventory
- Manages entity matching
- Detects anomalies (parser failures)
- Records historical snapshots

**Event Matching Service** (`backend/src/services/EventMatchingService.ts`)
- Fuzzy matching algorithm using Levenshtein distance
- Venue normalization
- Artist/team deduplication
- Manual review queue for ambiguous matches
- Confidence scoring (0-100)

**Pricing Service** (`backend/src/services/PricingService.ts`)
- Price change tracking
- Historical price snapshots
- Price outlier detection
- Trend analysis

### 2. Database Layer

**PostgreSQL Schema** (42 tables + indexes)

#### Core Entity Tables
- `events` - Canonical event records
- `external_events` - Per-source event records
- `event_matches` - Deduplication tracking

- `venues` - Canonical venues
- `external_venues` - Per-source venues
- `venue_sections` - Venue layout

- `artists` - Canonical artists
- `artist_aliases` - Artist name variants
- `teams` - Sports teams

#### Inventory Tables
- `listings` - Canonical ticket listings
- `external_listings` - Original source listings
- `inventory_snapshots` - Historical pricing/availability

#### Source Management
- `sources` - Source configuration
- `source_compliance` - Compliance tracking
- `crawler_logs` - Ingestion audit trail
- `raw_source_data` - Original API responses

#### Analytics & Tracking
- `affiliate_events` - Conversion tracking
- `orders` - Transaction records
- `audit_logs` - Admin actions
- `search_index_config` - Index health

### 3. Background Job Processing

**BullMQ + Redis** (`backend/src/jobs/worker.ts`)

Job Types:
1. **event_discovery** - Find new events (configurable frequency per source)
2. **inventory_sync** - Sync ticket listings (4x more frequent)
3. **price_update** - Track price changes
4. **venue_sync** - Update venue information
5. **artist_sync** - Update artist information
6. **anomaly_detection** - Detect parser failures
7. **freshness_check** - Mark stale inventory

Job Features:
- ✅ Configurable repeat intervals per source
- ✅ Exponential backoff on failures
- ✅ Automatic retries (3-5 attempts)
- ✅ Dead letter queue for failed jobs
- ✅ Rate limiting per source
- ✅ Concurrent execution limits

### 4. API Layer

**Express.js REST API** (`backend/src/index.ts`)

**Public Endpoints:**
```
GET  /api/v1/events          - Search/list events
GET  /api/v1/events/:id      - Get event details
GET  /api/v1/venues          - Search venues
POST /api/v1/listings/:id/click - Track engagement
```

**Admin Endpoints:**
```
GET  /api/v1/admin/sources              - List sources
POST /api/v1/admin/sources              - Create source
PATCH /api/v1/admin/sources/:id         - Update source
GET  /api/v1/admin/crawler/status       - Crawler health
GET  /api/v1/admin/entity-matching/pending - Review duplicates
POST /api/v1/admin/entity-matching/merge   - Merge entities
```

**Features:**
- Async request handling
- Automatic error handling
- Request logging
- CORS support
- Rate limiting ready
- JWT authentication ready

### 5. Search Layer

**Elasticsearch Integration**

Indexes:
- `events_index` - Full-text event search
- `venues_index` - Venue search
- `artists_index` - Artist search

Features:
- Full-text search with relevance scoring
- Fuzzy matching for typos
- Faceted search (category, date, price range)
- Real-time index updates
- Reindexing capability

### 6. Frontend

**React SPA** (`frontend/src/`)

Pages:
- **Event Search** - Multi-filter search interface
- **Event Details** - Detailed event with listings
- **Multi-source Comparison** - Price/availability across sources
- **Navigation** - Browse by category, location, date

Features:
- ✅ Real-time search
- ✅ Price filtering
- ✅ Date range filtering
- ✅ Source attribution
- ✅ Responsive design
- ✅ Fast loading

### 7. Admin Dashboard

**React Admin Panel** (`admin/src/`)

Sections:
1. **Overview** - Key metrics and health
2. **Data Sources** - CRUD operations
3. **Crawler Status** - Real-time monitoring
4. **Entity Matching** - Manual deduplication review
5. **Analytics** - Charts and trends

Features:
- Source enable/disable
- Configure crawl frequency
- Set rate limits
- View error logs
- Monitor performance
- Track coverage

## Data Flow

### Event Discovery Flow

```
1. Source Connector
   └─> discoverEvents(country, dates, category)
       └─> Returns: DiscoveredEvent[]

2. Ingestion Service
   └─> Store external_events records
       └─> Match to canonical events
           ├─> Exact match? Link immediately
           ├─> Fuzzy match (>75%)? Link immediately
           ├─> Fuzzy match (50-75%)? Queue for review
           └─> No match? Create new canonical event

3. Entity Matching
   ├─> Match venue
   ├─> Match artists
   ├─> Set initial quality_score
   └─> Generate event_matches records

4. Publishing
   └─> If quality_score >= threshold → status = 'active'
       └─> Index in Elasticsearch
           └─> Available in search
```

### Inventory Sync Flow

```
1. Source Connector
   └─> getListings(external_event_id)
       └─> Returns: DiscoveredListing[]

2. External Listing Storage
   └─> Insert/update external_listings
       └─> Check for price changes
           └─> Record in pricing_service

3. Canonical Listing
   └─> Create/update listings
       └─> Create inventory_snapshot
           └─> Update event price range
               └─> Update active_listings count

4. Freshness Management
   └─> Mark old listings unavailable
       └─> Update event inventory status
           └─> Remove from search if no inventory
```

### Search Flow

```
User Query (Frontend)
└─> API /events?q=taylor+swift&category=concert
    └─> PostgreSQL search
        ├─> Filter by status='active'
        ├─> Filter by category
        ├─> Full-text search on title
        └─> Return 50 results
            └─> Elasticsearch gets hits
                └─> Frontend displays

User Clicks Listing
└─> Track click in listings.clicks
    └─> If affiliate: create affiliate_event
        └─> Record click_id for tracking
```

## Data Models

### Event Entity
```typescript
Event {
  id: number
  title: string
  description?: string
  venue_id?: number
  start_time: Date
  end_time?: Date
  category: EventCategory
  all_day: boolean
  image_urls?: string[]
  quality_score: number (0-100)
  status: 'active' | 'pending_review' | 'inactive' | 'cancelled'
  total_listings: number
  lowest_price?: number (in cents)
  active_listings: number
}
```

### Listing Entity
```typescript
Listing {
  id: number
  event_id: number
  external_listing_id?: number
  section?: string
  row?: string
  seat?: string
  quantity: number
  price_cents: number
  currency: string
  delivery_method: 'electronic' | 'physical' | 'will_call'
  availability: 'available' | 'unavailable' | 'pending' | 'sold_out'
  source_id: number
  last_seen_at: Date
  revenue_model: 'affiliate' | 'lead_gen' | 'transaction' | 'commission'
}
```

### Source Entity
```typescript
Source {
  id: number
  name: string
  type: 'api' | 'feed' | 'crawler' | 'affiliate'
  enabled: boolean
  country: string // 'US,CA'
  update_frequency_minutes: number
  rate_limit_requests: number
  rate_limit_window_seconds: number
  revenue_model: 'affiliate' | 'lead_gen' | 'transaction' | 'none'
  compliance_status: 'approved' | 'pending_review' | 'restricted' | 'disabled'
}
```

## Rate Limiting & Throttling

**Per-Source Rate Limiting:**
```javascript
// Distributed rate limiter (Redis)
Source 1: 100 req/min
Source 2: 10 req/sec  
Source 3: 1 req/sec

// Enforced via connector
const rateLimiter = new RateLimiter(source.rate_limit_requests, source.rate_limit_window_seconds);
await rateLimiter.acquire();
```

**Crawler Scheduling:**
```javascript
// Staggered schedules prevent thundering herd
Event Discovery:  Every N minutes
Inventory Sync:   Every N/4 minutes (staggered)
Price Updates:    With inventory sync
Anomaly Detection: Every 6 hours
```

## Error Handling & Resilience

**Retry Strategy:**
- Initial attempt
- Retry 1: Wait 2 seconds
- Retry 2: Wait 4 seconds
- Retry 3: Wait 8 seconds
- Final failure → Dead letter queue

**Anomaly Detection:**
- Event count drops > 70%? Alert
- All crawls failing? Pause source
- Parser error spike? Flag for review
- Unusual pricing? Quarantine listings

**Data Validation:**
- Null checking on required fields
- Price validation (positive integers)
- Date validation (start < end)
- Duplicate prevention via unique constraints

## Scalability Considerations

### Current Capacity
- **Events:** 1M+
- **Listings:** 10M+
- **Requests/sec:** 100+
- **Concurrent crawlers:** 10-20

### Scaling Strategies

1. **Horizontal Scaling**
   - Multiple API instances behind load balancer
   - Database replication (read replicas)
   - Redis clustering for job queue
   - Elasticsearch sharding

2. **Vertical Scaling**
   - Increase server RAM/CPU
   - Optimize database queries (indexes)
   - Reduce crawler frequency for non-priority sources
   - Implement caching layer (Redis)

3. **Performance Optimization**
   - Database query optimization
   - Search index tuning
   - Crawler parallelization
   - Batch updates for inventory

## Security

**Authentication & Authorization:**
- [ ] JWT tokens for admin API
- [ ] Rate limiting on public API
- [ ] HTTPS/TLS in production
- [ ] SQL injection prevention (parameterized queries)
- [ ] CORS configuration
- [ ] Helmet security headers

**Data Protection:**
- [ ] Encrypt source API keys at rest
- [ ] Never log sensitive data
- [ ] Database backups encrypted
- [ ] Compliance audit logging
- [ ] Data retention policies

**API Security:**
- [ ] API key validation
- [ ] Rate limiting per endpoint
- [ ] Request validation (Joi schemas)
- [ ] Error message sanitization

## Monitoring & Observability

**Metrics Exported:**
- Crawler success/failure rates
- Events discovered/updated per source
- Listings discovered/updated
- API response times
- Database connection pool
- Redis queue depth
- Elasticsearch index health

**Logging:**
- Structured JSON logs
- Log levels: debug, info, warn, error
- Log rotation and archival
- Centralized log collection (ELK)

**Alerting:**
- Crawler failures > 30% → Alert
- API down → Alert
- Database unavailable → Alert
- Elasticsearch degraded → Alert
- Memory usage > 80% → Alert

## Technology Stack

| Component | Technology |
|-----------|-----------|
| **API Server** | Node.js + Express |
| **Language** | TypeScript |
| **Database** | PostgreSQL 14+ |
| **Cache** | Redis 7+ |
| **Search** | Elasticsearch 8+ |
| **Job Queue** | BullMQ + Redis |
| **Frontend** | React 18 + Vite |
| **Styling** | Tailwind CSS |
| **HTTP Client** | Axios |
| **State Management** | Zustand (Frontend) |
| **Charts** | Recharts |
| **Containerization** | Docker + Docker Compose |
| **Package Manager** | npm/yarn |

## Deployment Architecture

```
┌─────────────────┐
│   CDN (Images)  │
└────────┬────────┘
         │
┌────────▼─────────────────────────────┐
│        Load Balancer (Nginx)          │
├────────────────────────────────────────┤
│ API (Backend)  | Frontend | Admin     │
│ Port 3000      | Port 5173| Port 3001│
├────────────────────────────────────────┤
│  Docker Containers (Multiple Replicas) │
├────────────────────────────────────────┤
│   PostgreSQL Cluster (Primary+Replicas) │
│   Redis Cluster (Sharded)              │
│   Elasticsearch Cluster (Sharded)      │
└────────────────────────────────────────┘
```

## Future Enhancements

1. **Machine Learning**
   - Price prediction model
   - Demand forecasting
   - Fraud detection

2. **Advanced Features**
   - User wishlists
   - Price drop alerts
   - Personalized recommendations
   - Social features (sharing, reviews)

3. **Additional Sources**
   - Live Nation API
   - AXS API
   - Songkick
   - Facebook Events
   - Custom integrations

4. **Mobile Apps**
   - iOS app
   - Android app
   - Push notifications
   - Mobile-specific features

5. **Marketplace**
   - Direct ticket selling
   - Seller verification
   - Escrow payments
   - Dispute resolution

---

This architecture is designed to be:
- **Scalable** - Handle millions of events
- **Reliable** - 99.9% uptime SLA
- **Compliant** - Respect source terms, attribution, legal requirements
- **Maintainable** - Clean code, good documentation
- **Extensible** - Easy to add new sources and features
