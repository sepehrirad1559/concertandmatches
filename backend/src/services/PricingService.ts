import { Knex } from 'knex';
import { Logger } from '../utils/Logger';

/**
 * Pricing service for tracking price changes and historical data
 */
export class PricingService {
  constructor(
    private db: Knex,
    private logger: Logger
  ) {}

  /**
   * Record a price change for a listing
   */
  async recordPriceChange(
    externalListingId: number,
    oldPriceCents: number,
    newPriceCents: number
  ): Promise<void> {
    const change = newPriceCents - oldPriceCents;
    const percentChange = ((change / oldPriceCents) * 100).toFixed(2);

    this.logger.info(
      `Price change: ${(oldPriceCents / 100).toFixed(2)} → ${(newPriceCents / 100).toFixed(2)} (${percentChange}%)`
    );

    // Price changes could trigger notifications or alerts
    // For now, just log them
  }

  /**
   * Get price history for a listing
   */
  async getPriceHistory(
    externalListingId: number,
    limit: number = 100
  ): Promise<Array<{ price_cents: number; quantity: number; timestamp: Date }>> {
    return this.db('inventory_snapshots')
      .where({ external_listing_id: externalListingId })
      .orderBy('snapshot_at', 'desc')
      .limit(limit)
      .select('price_cents', 'quantity_available as quantity', 'snapshot_at as timestamp');
  }

  /**
   * Get average price for event/section
   */
  async getAveragePrice(
    eventId: number,
    section?: string
  ): Promise<{ avg_price_cents: number; currency: string; count: number } | null> {
    let query = this.db('listings')
      .where({ event_id: eventId, availability: 'available' });

    if (section) {
      query = query.where({ section });
    }

    const result = await query
      .avg('price_cents as avg_price')
      .count('* as count')
      .select('currency')
      .first();

    if (!result || result.count === 0) {
      return null;
    }

    return {
      avg_price_cents: Math.round(result.avg_price || 0),
      currency: result.currency || 'USD',
      count: result.count
    };
  }

  /**
   * Find price outliers in an event
   */
  async findPriceOutliers(eventId: number): Promise<Array<{
    listing_id: number;
    section: string;
    price_cents: number;
    deviation_percent: number;
  }>> {
    // Get average price
    const avgResult = await this.getAveragePrice(eventId);
    if (!avgResult) return [];

    const avgPrice = avgResult.avg_price_cents;

    // Find outliers (prices > 50% deviation)
    const outliers = await this.db('listings')
      .where({ event_id: eventId, availability: 'available' })
      .whereRaw('ABS(price_cents - ?) / ? > 0.5', [avgPrice, avgPrice])
      .select('id as listing_id', 'section', 'price_cents')
      .limit(50);

    return outliers.map(o => ({
      ...o,
      deviation_percent: Math.round(((o.price_cents - avgPrice) / avgPrice) * 100)
    }));
  }

  /**
   * Track price trends over time
   */
  async getPriceTrends(
    eventId: number,
    daysBack: number = 7
  ): Promise<Array<{ date: string; avg_price_cents: number; min_price: number; max_price: number; count: number }>> {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysBack);

    return this.db('inventory_snapshots as snaps')
      .join('external_listings as ext', 'ext.id', 'snaps.external_listing_id')
      .join('external_events as ee', 'ee.external_event_id', 'ext.external_event_id')
      .join('events as e', 'e.id', 'ee.event_id')
      .where('e.id', eventId)
      .where('snaps.snapshot_at', '>', startDate)
      .select(
        this.db.raw("DATE(snaps.snapshot_at) as date"),
        this.db.raw('AVG(snaps.price_cents) as avg_price_cents'),
        this.db.raw('MIN(snaps.price_cents) as min_price'),
        this.db.raw('MAX(snaps.price_cents) as max_price'),
        this.db.raw('COUNT(*) as count')
      )
      .groupBy(this.db.raw("DATE(snaps.snapshot_at)"))
      .orderBy('date', 'asc');
  }

  /**
   * Get best deals (lowest prices relative to historical average)
   */
  async getBestDeals(limit: number = 20): Promise<Array<{
    event_id: number;
    event_title: string;
    listing_id: number;
    price_cents: number;
    historical_avg_cents: number;
    discount_percent: number;
    section: string;
  }>> {
    return this.db('listings')
      .join('events', 'events.id', 'listings.event_id')
      .where('listings.availability', 'available')
      .select(
        'listings.event_id',
        'events.title as event_title',
        'listings.id as listing_id',
        'listings.price_cents',
        'listings.section'
      )
      .orderBy('listings.price_cents', 'asc')
      .limit(limit);
  }

  /**
   * Detect potentially fraudulent pricing
   */
  async detectSuspiciousPricing(eventId: number): Promise<Array<{
    listing_id: number;
    price_cents: number;
    reason: string;
  }>> {
    const issues: Array<{
      listing_id: number;
      price_cents: number;
      reason: string;
    }> = [];

    // Check for extremely high prices
    const highPrices = await this.db('listings')
      .where({ event_id: eventId, availability: 'available' })
      .whereRaw('price_cents > 100000') // > $1000
      .select('id as listing_id', 'price_cents');

    highPrices.forEach(listing => {
      issues.push({
        listing_id: listing.listing_id,
        price_cents: listing.price_cents,
        reason: `Extremely high price: $${(listing.price_cents / 100).toFixed(2)}`
      });
    });

    // Check for zero/negative prices
    const invalidPrices = await this.db('listings')
      .where({ event_id: eventId })
      .whereRaw('price_cents <= 0')
      .select('id as listing_id', 'price_cents');

    invalidPrices.forEach(listing => {
      issues.push({
        listing_id: listing.listing_id,
        price_cents: listing.price_cents,
        reason: `Invalid price: ${listing.price_cents}`
      });
    });

    return issues;
  }
}
