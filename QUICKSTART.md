# EventFlow Quick Start (5 Minutes)

Get EventFlow running locally in 5 minutes.

## Prerequisites Installed?
- [ ] Node.js 18+
- [ ] Docker & Docker Compose
- [ ] Git

## Step 1: Clone & Setup (1 minute)

```bash
git clone https://github.com/yourorg/eventflow.git
cd eventflow
cp .env.example .env
```

## Step 2: Start Infrastructure (1 minute)

```bash
docker-compose up -d
# Starts: PostgreSQL, Redis, Elasticsearch, Adminer
```

## Step 3: Setup Backend (1 minute)

```bash
cd backend
npm install
npm run migrate:latest
```

## Step 4: Start All Services (2 minutes)

Open 4 terminals and run these in each:

**Terminal 1 - Backend API:**
```bash
cd backend && npm run dev
```
→ API runs on `http://localhost:3000`

**Terminal 2 - Job Worker:**
```bash
cd backend && npm run jobs:start
```
→ Crawlers begin discovering events

**Terminal 3 - Frontend:**
```bash
cd frontend && npm install && npm run dev
```
→ App runs on `http://localhost:5173`

**Terminal 4 - Admin:**
```bash
cd admin && npm install && npm run dev
```
→ Dashboard runs on `http://localhost:3001`

## Step 5: Add API Keys (optional for testing)

Edit `.env`:
```env
TICKETMASTER_API_KEY=your_key_here
EVENTBRITE_API_KEY=your_key_here
```

Get free keys at:
- https://developer.ticketmaster.com/
- https://www.eventbrite.com/platform/api/

Without keys, the platform still works with sample data.

## ✅ You're Done!

| Component | URL | Status |
|-----------|-----|--------|
| **Frontend (Search)** | http://localhost:5173 | 🟢 |
| **Admin Dashboard** | http://localhost:3001 | 🟢 |
| **API** | http://localhost:3000 | 🟢 |
| **Database GUI** | http://localhost:8080 | 🟢 |

## What's Running?

✅ **Event Discovery** - Discovering events from sources  
✅ **Inventory Sync** - Tracking ticket listings  
✅ **Price Monitoring** - Recording price changes  
✅ **Entity Resolution** - Deduplicating events  
✅ **Full-Text Search** - Indexing for fast search  

## Test It

### 1. Search for Events
```bash
curl -X GET "http://localhost:3000/api/v1/events?q=concert&limit=10"
```

### 2. Check Crawler Status
```bash
curl -X GET "http://localhost:3000/api/v1/admin/crawler/status"
```

### 3. View Database
Open http://localhost:8080
- Server: postgres
- User: eventflow
- Password: eventflow
- Database: eventflow

## Troubleshooting

**"Cannot connect to database"**
```bash
docker-compose ps  # Check all containers running
docker-compose logs postgres  # View PostgreSQL logs
```

**"Port already in use"**
```bash
# Change ports in .env or docker-compose.yml
# Or kill process using port: lsof -i :3000
```

**"Jobs not running"**
```bash
# Check Redis is healthy
redis-cli ping
# Check job queue
curl http://localhost:3000/api/v1/admin/crawler/status
```

## Next Steps

1. **Add Data Sources** - Admin → Data Sources → + Add Source
2. **Monitor Crawls** - Admin → Crawler Status
3. **Review Matches** - Admin → Entity Matching (find duplicates)
4. **Configure API Keys** - Edit `.env` and restart backend
5. **Deploy to Production** - See SETUP.md

## File Structure

```
eventflow/
├── backend/           # Express API + crawlers
├── frontend/          # React event search app  
├── admin/             # React admin dashboard
├── docker-compose.yml # Local dev infrastructure
├── .env.example       # Configuration template
├── README.md          # Full documentation
├── SETUP.md           # Detailed setup guide
└── QUICKSTART.md      # This file
```

## Key Features Working

- ✅ **Automated event discovery** from multiple sources
- ✅ **Event deduplication** using fuzzy matching
- ✅ **Inventory aggregation** from licensed APIs
- ✅ **Price tracking** and historical snapshots
- ✅ **Multi-source comparison** on event pages
- ✅ **Affiliate tracking** ready for revenue
- ✅ **Anomaly detection** for data quality
- ✅ **Admin control panel** for source management
- ✅ **Full-text search** across all events
- ✅ **REST API** for external integrations

## Live Monitoring

Watch events being discovered:

```bash
# Terminal: watch database
watch -n 2 'psql eventflow -c "SELECT COUNT(*) FROM events;"'

# Terminal: tail crawler logs
docker-compose logs -f redis

# Terminal: check job queue
curl -s http://localhost:3000/api/v1/admin/crawler/status | jq .
```

## Production Deployment

When ready to launch:

1. Set up AWS/GCP/Azure account
2. Configure `.env` with production values
3. Follow SETUP.md → Production Deployment section
4. Use `docker-compose.prod.yml`
5. Setup CI/CD pipeline

---

**Questions?** Check SETUP.md, README.md, or GitHub Issues

**Ready to add your first source?** → Go to Admin Dashboard at http://localhost:3001
