import express, { Express, Request, Response, NextFunction } from 'express';
import 'express-async-errors';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import dotenv from 'dotenv';
import { db, initializeDatabase } from './database/config';
import { Logger } from './utils/Logger';
import { IngestionService } from './services/IngestionService';
import { EventMatchingService } from './services/EventMatchingService';
import { PricingService } from './services/PricingService';

// Load environment variables
dotenv.config();

const app: Express = express();
const logger = new Logger('EventFlow-API');
const PORT = process.env.API_PORT || 3000;

// ============ MIDDLEWARE ============

app.use(helmet());
app.use(cors());
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Request logging
app.use((req: Request, res: Response, next: NextFunction) => {
  logger.info(`${req.method} ${req.path}`);
  next();
});

// ============ SERVICES ============

const eventMatcher = new EventMatchingService(db, logger);
const pricingService = new PricingService(db, logger);
const ingestionService = new IngestionService(db, eventMatcher, pricingService, logger);

// ============ PUBLIC API ROUTES ============

/**
 * Search events
 */
app.get('/api/v1/events', async (req: Request, res: Response) => {
  const {
    q,
    city_id,
    category,
    min_date,
    max_date,
    limit = 20,
    offset = 0
  } = req.query;

  let query = db('events')
    .where({ status: 'active' })
    .orderBy('start_time', 'asc');

  // Search by query
  if (q) {
    const searchTerm = `%${q}%`;
    query = query.where('title', 'ilike', searchTerm)
      .orWhere('description', 'ilike', searchTerm);
  }

  // Filter by city
  if (city_id) {
    query = query.join('venues', 'venues.id', 'events.venue_id')
      .where('venues.city_id', city_id);
  }

  // Filter by category
  if (category) {
    query = query.where('category', category);
  }

  // Filter by date
  if (min_date) {
    query = query.where('start_time', '>=', new Date(min_date as string));
  }
  if (max_date) {
    query = query.where('start_time', '<=', new Date(max_date as string));
  }

  const total = await query.clone().count('* as count').first();
  const events = await query
    .limit(Math.min(parseInt(limit as string) || 20, 100))
    .offset(parseInt(offset as string) || 0)
    .select('*');

  res.json({
    success: true,
    data: events,
    pagination: {
      total: total?.count || 0,
      limit: parseInt(limit as string) || 20,
      offset: parseInt(offset as string) || 0
    }
  });
});

/**
 * Get event details
 */
app.get('/api/v1/events/:id', async (req: Request, res: Response) => {
  const { id } = req.params;

  const event = await db('events')
    .where({ id: parseInt(id) })
    .first();

  if (!event) {
    return res.status(404).json({
      success: false,
      error: 'Event not found'
    });
  }

  // Get venue
  const venue = event.venue_id
    ? await db('venues').where({ id: event.venue_id }).first()
    : null;

  // Get performers
  const performers = await db('event_performers')
    .where({ event_id: event.id })
    .leftJoin('artists', 'artists.id', 'event_performers.artist_id')
    .leftJoin('teams', 'teams.id', 'event_performers.team_id')
    .select('artists.*', 'teams.*')
    .orderBy('event_performers.order', 'asc');

  // Get listings with source info
  const listings = await db('listings as l')
    .join('sources as s', 's.id', 'l.source_id')
    .where({ 'l.event_id': event.id, 'l.availability': 'available' })
    .select(
      'l.id',
      'l.section',
      'l.row',
      'l.seat',
      'l.price_cents',
      'l.currency',
      'l.ticket_type',
      'l.delivery_method',
      'l.quantity',
      's.name as source_name',
      's.disclosure_text'
    )
    .orderBy('l.price_cents', 'asc');

  res.json({
    success: true,
    data: {
      ...event,
      image_urls: event.image_urls ? JSON.parse(event.image_urls) : [],
      venue,
      performers,
      listings,
      total_sources: [...new Set(listings.map(l => l.source_name))].length
    }
  });
});

/**
 * Search venues
 */
app.get('/api/v1/venues', async (req: Request, res: Response) => {
  const { q, city_id, limit = 20, offset = 0 } = req.query;

  let query = db('venues');

  if (q) {
    query = query.where('name', 'ilike', `%${q}%`);
  }

  if (city_id) {
    query = query.where('city_id', city_id);
  }

  const total = await query.clone().count('* as count').first();
  const venues = await query
    .limit(Math.min(parseInt(limit as string) || 20, 100))
    .offset(parseInt(offset as string) || 0)
    .select('*');

  res.json({
    success: true,
    data: venues,
    pagination: {
      total: total?.count || 0,
      limit: parseInt(limit as string) || 20,
      offset: parseInt(offset as string) || 0
    }
  });
});

/**
 * Track listing click (for analytics)
 */
app.post('/api/v1/listings/:id/click', async (req: Request, res: Response) => {
  const { id } = req.params;

  await db('listings')
    .where({ id: parseInt(id) })
    .increment('clicks', 1);

  res.json({ success: true });
});

// ============ ADMIN API ROUTES ============

/**
 * Get sources
 */
app.get('/api/v1/admin/sources', async (req: Request, res: Response) => {
  const sources = await db('sources')
    .orderBy('name')
    .select('*');

  res.json({ success: true, data: sources });
});

/**
 * Create source
 */
app.post('/api/v1/admin/sources', async (req: Request, res: Response) => {
  const {
    name,
    type,
    country,
    auth_method,
    update_frequency_minutes = 30,
    rate_limit_requests = 100,
    rate_limit_window_seconds = 60,
    revenue_model = 'affiliate'
  } = req.body;

  if (!name || !type || !country) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields: name, type, country'
    });
  }

  const source = await db('sources')
    .insert({
      name,
      type,
      country,
      auth_method,
      update_frequency_minutes,
      rate_limit_requests,
      rate_limit_window_seconds,
      revenue_model,
      compliance_status: 'pending_review',
      created_at: new Date(),
      updated_at: new Date()
    })
    .returning('*')
    .then(rows => rows[0]);

  // Create compliance record
  await db('source_compliance').insert({
    source_id: source.id,
    permitted_use: 'display',
    permitted_cache_duration_hours: 24,
    commercial_use_permitted: true,
    data_retention_days: 365,
    requires_explicit_attribution: true,
    created_at: new Date(),
    updated_at: new Date()
  });

  res.status(201).json({ success: true, data: source });
});

/**
 * Update source
 */
app.patch('/api/v1/admin/sources/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const updates = req.body;

  const source = await db('sources')
    .where({ id: parseInt(id) })
    .update({
      ...updates,
      updated_at: new Date()
    })
    .returning('*')
    .then(rows => rows[0]);

  if (!source) {
    return res.status(404).json({ success: false, error: 'Source not found' });
  }

  res.json({ success: true, data: source });
});

/**
 * Get crawler status and statistics
 */
app.get('/api/v1/admin/crawler/status', async (req: Request, res: Response) => {
  const sources = await db('sources').select('*');

  const status = await Promise.all(
    sources.map(async (source) => {
      const recentLogs = await db('crawler_logs')
        .where({ source_id: source.id })
        .orderBy('created_at', 'desc')
        .limit(1)
        .first();

      const stats = await db('crawler_logs')
        .where({ source_id: source.id })
        .sum('events_discovered as total_events')
        .sum('listings_discovered as total_listings')
        .count('* as total_crawls')
        .where('status', 'success')
        .count('* as successful_crawls')
        .first();

      return {
        source_id: source.id,
        source_name: source.name,
        enabled: source.enabled,
        last_crawl: recentLogs?.created_at,
        last_status: recentLogs?.status,
        total_events_discovered: stats?.total_events || 0,
        total_listings_discovered: stats?.total_listings || 0,
        success_rate: stats?.total_crawls 
          ? ((stats.successful_crawls / stats.total_crawls) * 100).toFixed(1) 
          : 'N/A'
      };
    })
  );

  res.json({ success: true, data: status });
});

/**
 * Get pending entity matches for review
 */
app.get('/api/v1/admin/entity-matching/pending', async (req: Request, res: Response) => {
  const pending = await db('event_matches')
    .where({ status: 'pending_review' })
    .join('events', 'events.id', 'event_matches.event_id')
    .join('external_events', 'external_events.id', 'event_matches.external_event_id')
    .select(
      'event_matches.*',
      'events.title as event_title',
      'events.start_time',
      'external_events.title as external_title',
      'external_events.start_time as external_start_time'
    )
    .orderBy('event_matches.match_score', 'desc')
    .limit(50);

  res.json({ success: true, data: pending });
});

/**
 * Merge duplicate entities
 */
app.post('/api/v1/admin/entity-matching/merge', async (req: Request, res: Response) => {
  const { match_id, approved } = req.body;

  if (!match_id) {
    return res.status(400).json({ success: false, error: 'match_id required' });
  }

  const status = approved ? 'confirmed' : 'rejected';

  await db('event_matches')
    .where({ id: match_id })
    .update({
      status,
      reviewed_at: new Date(),
      updated_at: new Date()
    });

  res.json({ success: true, message: `Match ${status}` });
});

// ============ HEALTH CHECK ============

app.get('/health', async (req: Request, res: Response) => {
  const healthy = await db.raw('SELECT 1').then(() => true).catch(() => false);

  if (healthy) {
    res.json({ status: 'healthy' });
  } else {
    res.status(503).json({ status: 'unhealthy' });
  }
});

// ============ ERROR HANDLING ============

app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  logger.error(`Error: ${err.message}`);
  res.status(500).json({
    success: false,
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message
  });
});

// ============ SERVER STARTUP ============

async function start() {
  try {
    // Initialize database
    await initializeDatabase();
    logger.info('Database initialized');

    // Start server
    app.listen(PORT, () => {
      logger.info(`EventFlow API listening on http://localhost:${PORT}`);
      logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
    });
  } catch (err) {
    logger.error(`Failed to start server: ${err}`);
    process.exit(1);
  }
}

start();

export default app;
