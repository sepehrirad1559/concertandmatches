import { Knex } from 'knex';
import { Source, ExternalEvent, Event, EventMatch, ExternalListing, Listing, CrawlerLog, ExternalVenue, Venue } from '../models';
import { IExternalInventoryProvider, DiscoveredEvent, DiscoveredListing } from '../connectors/IExternalInventoryProvider';
import { EventMatchingService } from './EventMatchingService';
import { PricingService } from './PricingService';
import { Logger } from '../utils/Logger';

/**
 * Core ingestion service handling:
 * - Event discovery from sources
 * - Entity matching and deduplication
 * - Inventory synchronization
 * - Price tracking
 */
export class IngestionService {
  constructor(
    private db: Knex,
    private eventMatcher: EventMatchingService,
    private pricingService: PricingService,
    private logger: Logger
  ) {}

  /**
   * Discover new events from a source
   */
  async discoverEvents(
    source: Source,
    connector: IExternalInventoryProvider
  ): Promise<{ discovered: number; created: number; matched: number; errors: number }> {
    const startTime = Date.now();
    let discovered = 0;
    let created = 0;
    let matched = 0;
    let errors = 0;

    try {
      this.logger.info(`Starting event discovery for source: ${source.name}`);

      // Discover events from source
      const result = await connector.discoverEvents({
        countries: source.country.split(','),
        from_date: new Date(),
        to_date: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000) // 90 days ahead
      });

      if (!result.success || !result.data) {
        throw new Error(result.error || 'Unknown error during discovery');
      }

      discovered = result.data.length;
      this.logger.info(`Discovered ${discovered} events from ${source.name}`);

      // Process each discovered event
      for (const discoveredEvent of result.data) {
        try {
          // Store external event record
          const externalEvent = await this.db('external_events')
            .insert({
              source_id: source.id,
              external_event_id: discoveredEvent.external_event_id,
              title: discoveredEvent.title,
              external_venue_id: discoveredEvent.venue_name,
              start_time: discoveredEvent.start_time,
              end_time: discoveredEvent.end_time,
              category: discoveredEvent.category,
              raw_data: JSON.stringify(discoveredEvent.raw_data),
              confidence_score: 0,
              created_at: new Date(),
              updated_at: new Date()
            })
            .onConflict(['source_id', 'external_event_id'])
            .merge(['title', 'start_time', 'end_time', 'category', 'raw_data', 'updated_at'])
            .returning('*')
            .then(rows => rows[0]);

          // Try to match to canonical event
          const matchResult = await this.eventMatcher.findOrCreateEvent(discoveredEvent, source, externalEvent.id);

          if (matchResult.created) {
            created++;
          }
          if (matchResult.matched) {
            matched++;
          }
        } catch (err: any) {
          errors++;
          this.logger.error(`Error processing event ${discoveredEvent.external_event_id}: ${err.message}`);
        }
      }

      // Log crawl results
      const duration = Date.now() - startTime;
      await this.logCrawlerResult(source.id, 'event_discovery', 'success', {
        events_discovered: discovered,
        events_created: created,
        events_matched: matched,
        errors: errors,
        duration_ms: duration
      });

      return { discovered, created, matched, errors };
    } catch (err: any) {
      const duration = Date.now() - startTime;
      await this.logCrawlerResult(source.id, 'event_discovery', 'failed', {
        error: err.message,
        duration_ms: duration
      });
      this.logger.error(`Event discovery failed for ${source.name}: ${err.message}`);
      throw err;
    }
  }

  /**
   * Synchronize inventory/listings for events from a source
   */
  async syncInventory(
    source: Source,
    connector: IExternalInventoryProvider
  ): Promise<{ discovered: number; updated: number; errors: number }> {
    const startTime = Date.now();
    let discovered = 0;
    let updated = 0;
    let errors = 0;

    try {
      this.logger.info(`Starting inventory sync for source: ${source.name}`);

      // Get all external events from this source that are matched to canonical events
      const externalEvents = await this.db('external_events')
        .where({ source_id: source.id })
        .whereNotNull('event_id')
        .select('*');

      this.logger.info(`Found ${externalEvents.length} matched events to sync`);

      for (const extEvent of externalEvents) {
        try {
          // Get listings from source
          const listingsResult = await connector.getListings(extEvent.external_event_id);

          if (!listingsResult.success || !listingsResult.data) {
            this.logger.warn(`Could not fetch listings for ${extEvent.external_event_id}`);
            errors++;
            continue;
          }

          discovered += listingsResult.data.length;

          // Store and normalize each listing
          for (const discoveredListing of listingsResult.data) {
            try {
              await this.processListing(source.id, extEvent.event_id, discoveredListing);
              updated++;
            } catch (err: any) {
              errors++;
              this.logger.error(`Error processing listing: ${err.message}`);
            }
          }
        } catch (err: any) {
          errors++;
          this.logger.error(`Error syncing event ${extEvent.external_event_id}: ${err.message}`);
        }
      }

      // Mark stale inventory as unavailable
      await this.markStaleInventory(source.id, source.freshness_threshold_minutes);

      const duration = Date.now() - startTime;
      await this.logCrawlerResult(source.id, 'inventory_sync', 'success', {
        listings_discovered: discovered,
        listings_updated: updated,
        errors: errors,
        duration_ms: duration
      });

      return { discovered, updated, errors };
    } catch (err: any) {
      const duration = Date.now() - startTime;
      await this.logCrawlerResult(source.id, 'inventory_sync', 'failed', {
        error: err.message,
        duration_ms: duration
      });
      this.logger.error(`Inventory sync failed for ${source.name}: ${err.message}`);
      throw err;
    }
  }

  /**
   * Process a single discovered listing
   */
  private async processListing(
    sourceId: number,
    eventId: number,
    discoveredListing: DiscoveredListing
  ): Promise<void> {
    const now = new Date();

    // Store external listing
    const externalListing = await this.db('external_listings')
      .insert({
        source_id: sourceId,
        external_listing_id: discoveredListing.external_listing_id,
        external_event_id: discoveredListing.external_event_id,
        section: discoveredListing.section,
        row: discoveredListing.row,
        seat: discoveredListing.seat,
        quantity: discoveredListing.quantity,
        price_cents: discoveredListing.price_cents,
        currency: discoveredListing.currency,
        ticket_type: discoveredListing.ticket_type,
        delivery_method: discoveredListing.delivery_method,
        availability: discoveredListing.availability,
        restrictions: discoveredListing.restrictions ? JSON.stringify(discoveredListing.restrictions) : null,
        raw_data: discoveredListing.raw_data ? JSON.stringify(discoveredListing.raw_data) : null,
        retrieved_at: now,
        last_seen_at: now,
        source_url: discoveredListing.source_url,
        created_at: now,
        updated_at: now
      })
      .onConflict(['source_id', 'external_listing_id'])
      .merge(['quantity', 'price_cents', 'availability', 'last_seen_at', 'updated_at'])
      .returning('*')
      .then(rows => rows[0]);

    // Check for price changes
    const previousPrice = await this.db('listings')
      .where({ external_listing_id: externalListing.id })
      .first()
      .select('price_cents');

    if (previousPrice && previousPrice.price_cents !== discoveredListing.price_cents) {
      // Record price change
      await this.pricingService.recordPriceChange(externalListing.id, previousPrice.price_cents, discoveredListing.price_cents);
    }

    // Create or update canonical listing
    const listing = await this.db('listings')
      .insert({
        event_id: eventId,
        external_listing_id: externalListing.id,
        listing_type: 'aggregated',
        section: discoveredListing.section,
        row: discoveredListing.row,
        seat: discoveredListing.seat,
        quantity: discoveredListing.quantity,
        price_cents: discoveredListing.price_cents,
        currency: discoveredListing.currency,
        ticket_type: discoveredListing.ticket_type || 'reserved_seat',
        delivery_method: discoveredListing.delivery_method || 'electronic',
        availability: discoveredListing.availability as any,
        source_id: sourceId,
        last_seen_at: now,
        last_price_update: now,
        last_availability_update: now,
        revenue_model: 'affiliate',
        created_at: now,
        updated_at: now
      })
      .onConflict(['external_listing_id'])
      .merge(['quantity', 'price_cents', 'availability', 'last_seen_at', 'last_price_update', 'last_availability_update', 'updated_at'])
      .returning('*')
      .then(rows => rows[0]);

    // Create inventory snapshot for historical tracking
    await this.db('inventory_snapshots').insert({
      external_listing_id: externalListing.id,
      source_id: sourceId,
      price_cents: discoveredListing.price_cents,
      currency: discoveredListing.currency,
      quantity_available: discoveredListing.quantity,
      availability: discoveredListing.availability,
      section: discoveredListing.section,
      row: discoveredListing.row,
      snapshot_at: now,
      created_at: now,
      updated_at: now
    });

    // Update event's price range and listing counts
    await this.updateEventInventorySummary(eventId);
  }

  /**
   * Mark inventory as stale if not seen recently
   */
  private async markStaleInventory(sourceId: number, freshnessThresholdMinutes: number): Promise<number> {
    const staleTime = new Date(Date.now() - freshnessThresholdMinutes * 60 * 1000);

    const updated = await this.db('listings')
      .where({ source_id: sourceId })
      .where('last_seen_at', '<', staleTime)
      .where('availability', '!=', 'unavailable')
      .update({
        availability: 'unavailable',
        updated_at: new Date()
      });

    if (updated > 0) {
      this.logger.info(`Marked ${updated} listings as stale for source ${sourceId}`);
    }

    return updated;
  }

  /**
   * Update event's price range and listing counts
   */
  private async updateEventInventorySummary(eventId: number): Promise<void> {
    const summary = await this.db('listings')
      .where({ event_id: eventId })
      .where('availability', '!=', 'unavailable')
      .min('price_cents as min_price')
      .max('price_cents as max_price')
      .count('* as listing_count')
      .first();

    if (summary) {
      await this.db('events')
        .where({ id: eventId })
        .update({
          lowest_price: summary.min_price,
          highest_price: summary.max_price,
          total_listings: summary.listing_count || 0,
          active_listings: summary.listing_count || 0,
          last_inventory_update: new Date(),
          updated_at: new Date()
        });
    }
  }

  /**
   * Detect parser/ingestion failures (anomaly detection)
   */
  async detectAnomalies(source: Source): Promise<string[]> {
    const issues: string[] = [];

    // Check recent crawl results
    const recentLogs = await this.db('crawler_logs')
      .where({ source_id: source.id })
      .orderBy('created_at', 'desc')
      .limit(10)
      .select('*');

    if (recentLogs.length === 0) {
      return issues; // No logs yet
    }

    const successfulLogs = recentLogs.filter(log => log.status === 'success');
    if (successfulLogs.length === 0) {
      issues.push('All recent crawls failed');
      return issues;
    }

    // Check for dramatic drops in events discovered
    const avgDiscovered = successfulLogs.reduce((sum, log) => sum + log.events_discovered, 0) / successfulLogs.length;
    const latestDiscovered = recentLogs[0].events_discovered;

    if (latestDiscovered < avgDiscovered * 0.3) {
      issues.push(`Event count dropped from ${avgDiscovered.toFixed(0)} avg to ${latestDiscovered} (30% of avg)`);
    }

    // Check for high error rates
    const failureRate = recentLogs.filter(log => log.status === 'failed').length / recentLogs.length;
    if (failureRate > 0.3) {
      issues.push(`High failure rate: ${(failureRate * 100).toFixed(0)}% of recent crawls failed`);
    }

    // Check for repeated error types
    const errorCounts: Record<string, number> = {};
    recentLogs.forEach(log => {
      if (log.error_type) {
        errorCounts[log.error_type] = (errorCounts[log.error_type] || 0) + 1;
      }
    });

    Object.entries(errorCounts).forEach(([type, count]) => {
      if (count > 5) {
        issues.push(`Repeated ${type} errors (${count} times)`);
      }
    });

    return issues;
  }

  /**
   * Log crawler execution results
   */
  private async logCrawlerResult(
    sourceId: number,
    jobType: string,
    status: string,
    details: any
  ): Promise<void> {
    await this.db('crawler_logs').insert({
      source_id: sourceId,
      job_type: jobType,
      status: status,
      events_discovered: details.events_discovered || 0,
      events_updated: details.events_updated || 0,
      listings_discovered: details.listings_discovered || 0,
      listings_updated: details.listings_updated || 0,
      errors_count: details.errors || 0,
      error_message: details.error,
      duration_ms: details.duration_ms || 0,
      created_at: new Date(),
      updated_at: new Date()
    });
  }
}
