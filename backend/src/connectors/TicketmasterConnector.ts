import axios, { AxiosInstance } from 'axios';
import { IExternalInventoryProvider, SourceResponse, DiscoveredEvent, DiscoveredVenue, DiscoveredListing, EventAvailability, SourceCapabilities, NOT_SUPPORTED } from './IExternalInventoryProvider';

/**
 * Ticketmaster API Connector
 * Implements automated event discovery and ticket inventory aggregation
 */
export class TicketmasterConnector implements IExternalInventoryProvider {
  private sourceId: number;
  private apiKey: string;
  private baseUrl: string = 'https://app.ticketmaster.com/discovery/v2';
  private client: AxiosInstance;

  constructor(sourceId: number, apiKey: string) {
    this.sourceId = sourceId;
    this.apiKey = apiKey;
    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 10000,
      params: {
        apikey: apiKey
      }
    });
  }

  getSourceId(): number {
    return this.sourceId;
  }

  getCapabilities(): SourceCapabilities {
    return {
      supports_event_discovery: true,
      supports_inventory_sync: true,
      supports_price_tracking: true,
      supports_availability_tracking: true,
      supports_venue_info: true,
      supports_artist_info: true,
      supports_direct_purchase: false, // Ticketmaster doesn't expose purchase API
      supports_affiliate_mode: true,
      typical_api_response_time_ms: 500,
      supports_bulk_queries: true,
      max_requests_per_minute: 5000,
      rate_limit_type: 'hard'
    };
  }

  async discoverEvents(options: {
    countries?: string[];
    states?: string[];
    categories?: string[];
    from_date?: Date;
    to_date?: Date;
  }): Promise<SourceResponse<DiscoveredEvent[]>> {
    try {
      const params: any = {
        size: 200,
        startDateTime: options.from_date?.toISOString(),
        endDateTime: options.to_date?.toISOString()
      };

      // Ticketmaster uses country codes: US, CA, etc.
      if (options.countries?.length) {
        params.countryCode = options.countries[0]; // Ticketmaster typically takes one country at a time
      }

      if (options.categories?.length) {
        // Map to Ticketmaster classification IDs
        const classificationIds = this.mapCategoriesToClassifications(options.categories);
        if (classificationIds.length) {
          params.classificationId = classificationIds.join(',');
        }
      }

      const response = await this.client.get('/events.json', { params });

      const events: DiscoveredEvent[] = response.data._embedded?.events?.map((event: any) => ({
        external_event_id: event.id,
        title: event.name,
        start_time: new Date(event.dates.start.dateTime),
        end_time: event.dates.end?.dateTime ? new Date(event.dates.end.dateTime) : undefined,
        venue_name: event._embedded?.venues?.[0]?.name,
        venue_city: event._embedded?.venues?.[0]?.city?.name,
        venue_state: event._embedded?.venues?.[0]?.state?.stateCode,
        category: event.classifications?.[0]?.segment?.name,
        description: event.description,
        image_urls: [event.images?.[0]?.url].filter(Boolean),
        artist_names: event._embedded?.attractions?.map((a: any) => a.name) || [],
        raw_data: event
      })) || [];

      return {
        success: true,
        data: events
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message,
        http_status: error.response?.status
      };
    }
  }

  async getEvent(external_event_id: string): Promise<SourceResponse<DiscoveredEvent>> {
    try {
      const response = await this.client.get(`/events/${external_event_id}.json`);
      const event = response.data;

      return {
        success: true,
        data: {
          external_event_id: event.id,
          title: event.name,
          start_time: new Date(event.dates.start.dateTime),
          end_time: event.dates.end?.dateTime ? new Date(event.dates.end.dateTime) : undefined,
          venue_name: event._embedded?.venues?.[0]?.name,
          venue_city: event._embedded?.venues?.[0]?.city?.name,
          venue_state: event._embedded?.venues?.[0]?.state?.stateCode,
          category: event.classifications?.[0]?.segment?.name,
          description: event.description,
          image_urls: event.images?.map((img: any) => img.url) || [],
          artist_names: event._embedded?.attractions?.map((a: any) => a.name) || [],
          raw_data: event
        }
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message,
        http_status: error.response?.status
      };
    }
  }

  async getEvents(external_event_ids: string[]): Promise<SourceResponse<DiscoveredEvent[]>> {
    // Ticketmaster doesn't support bulk fetch by IDs, so fetch individually
    const results = await Promise.all(
      external_event_ids.map(id => this.getEvent(id))
    );
    
    const events = results
      .filter(r => r.success && r.data)
      .map(r => r.data as DiscoveredEvent);

    return {
      success: events.length > 0,
      data: events
    };
  }

  async getVenue(external_venue_id: string): Promise<SourceResponse<DiscoveredVenue>> {
    try {
      const response = await this.client.get(`/venues/${external_venue_id}.json`);
      const venue = response.data;

      return {
        success: true,
        data: {
          external_venue_id: venue.id,
          name: venue.name,
          city: venue.city?.name,
          state_province: venue.state?.stateCode,
          country: venue.country?.countryCode,
          latitude: venue.location?.latitude ? parseFloat(venue.location.latitude) : undefined,
          longitude: venue.location?.longitude ? parseFloat(venue.location.longitude) : undefined,
          address: venue.address?.line1,
          postal_code: venue.postalCode,
          capacity: venue.capacity,
          raw_data: venue
        }
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message,
        http_status: error.response?.status
      };
    }
  }

  async getVenues(external_venue_ids: string[]): Promise<SourceResponse<DiscoveredVenue[]>> {
    const results = await Promise.all(
      external_venue_ids.map(id => this.getVenue(id))
    );
    
    const venues = results
      .filter(r => r.success && r.data)
      .map(r => r.data as DiscoveredVenue);

    return {
      success: venues.length > 0,
      data: venues
    };
  }

  async getListings(external_event_id: string): Promise<SourceResponse<DiscoveredListing[]>> {
    // Ticketmaster offers limited listing/inventory data in their discovery API
    // In production, this would need to integrate with their Commerce API or use affiliates
    return NOT_SUPPORTED;
  }

  async getListing(external_listing_id: string): Promise<SourceResponse<DiscoveredListing>> {
    return NOT_SUPPORTED;
  }

  async getAvailability(external_event_id: string): Promise<SourceResponse<EventAvailability>> {
    try {
      const response = await this.client.get(`/events/${external_event_id}.json`);
      const event = response.data;
      
      // Ticketmaster includes limited availability info
      const priceInfo = event.priceRanges?.[0];

      return {
        success: true,
        data: {
          external_event_id: event.id,
          total_listings: event.stats?.numberOfListings || 0,
          available_listings: event.stats?.statusCode === 'onsale' ? event.stats?.numberOfListings || 0 : 0,
          lowest_price_cents: priceInfo ? Math.round(priceInfo.min * 100) : undefined,
          currency: priceInfo?.type,
          last_updated: new Date()
        }
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message,
        http_status: error.response?.status
      };
    }
  }

  async getPrice(external_listing_id: string, limit?: number): Promise<any> {
    return NOT_SUPPORTED;
  }

  async getTicketDetails(external_listing_id: string): Promise<any> {
    return NOT_SUPPORTED;
  }

  async getChanges(since: Date): Promise<any> {
    return NOT_SUPPORTED;
  }

  async createReservation(external_listing_id: string, quantity: number, duration_minutes?: number): Promise<any> {
    return NOT_SUPPORTED;
  }

  async releaseReservation(reservation_id: string): Promise<any> {
    return NOT_SUPPORTED;
  }

  async purchase(reservation_id: string, buyer_email: string, buyer_phone?: string, payment_token?: string): Promise<any> {
    return NOT_SUPPORTED;
  }

  async getOrder(order_id: string): Promise<any> {
    return NOT_SUPPORTED;
  }

  async getDeliveryStatus(order_id: string): Promise<any> {
    return NOT_SUPPORTED;
  }

  async cancelOrder(order_id: string): Promise<any> {
    return NOT_SUPPORTED;
  }

  async refundOrder(order_id: string, amount_cents?: number): Promise<any> {
    return NOT_SUPPORTED;
  }

  async getAffiliateTrackingUrl(external_listing_id: string, session_id?: string): Promise<any> {
    try {
      // Ticketmaster has an affiliate program
      const baseUrl = 'https://www.ticketmaster.com/';
      const trackingUrl = `${baseUrl}?affiliate_id=${this.apiKey}`;
      
      return {
        success: true,
        data: {
          url: trackingUrl,
          click_id: `tm_${external_listing_id}_${session_id || Date.now()}`
        }
      };
    } catch (error) {
      return NOT_SUPPORTED;
    }
  }

  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    try {
      await this.client.get('/events.json', { params: { size: 1 } });
      return { healthy: true };
    } catch (error: any) {
      return {
        healthy: false,
        message: error.message
      };
    }
  }

  private mapCategoriesToClassifications(categories: string[]): string[] {
    // Ticketmaster classification mapping
    const classificationMap: Record<string, string> = {
      'concert': 'KnvZfZ7vAeA',
      'sports': 'KnvZfZ7vAvd',
      'theater': 'KnvZfZ7vAv6',
      'comedy': 'KnvZfZ7vAvI',
      'festival': 'KnvZfZ7vAve',
      'family': 'KnvZfZ7vAvJ'
    };

    return categories
      .map(cat => classificationMap[cat.toLowerCase()])
      .filter(Boolean);
  }
}
