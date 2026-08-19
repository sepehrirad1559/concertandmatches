/**
 * External Inventory Provider Interface
 * 
 * All source connectors must implement this interface to provide a standardized
 * way of discovering and fetching event/ticket inventory data.
 */

export interface DiscoveredEvent {
  external_event_id: string;
  title: string;
  start_time: Date;
  end_time?: Date;
  venue_name?: string;
  venue_city?: string;
  venue_state?: string;
  category?: string;
  description?: string;
  image_urls?: string[];
  artist_names?: string[];
  team_names?: string[];
  raw_data?: any;
}

export interface DiscoveredVenue {
  external_venue_id: string;
  name: string;
  city?: string;
  state_province?: string;
  country?: string;
  latitude?: number;
  longitude?: number;
  address?: string;
  postal_code?: string;
  capacity?: number;
  type?: string;
  raw_data?: any;
}

export interface DiscoveredListing {
  external_listing_id: string;
  external_event_id: string;
  section?: string;
  row?: string;
  seat?: string;
  quantity: number;
  price_cents: number;
  currency: string;
  ticket_type?: string;
  delivery_method?: string;
  availability: 'available' | 'unavailable' | 'pending';
  restrictions?: any;
  source_url?: string;
  raw_data?: any;
}

export interface EventAvailability {
  external_event_id: string;
  total_listings: number;
  available_listings: number;
  lowest_price_cents?: number;
  currency?: string;
  last_updated: Date;
}

export interface TicketDetails {
  section?: string;
  row?: string;
  seat?: string;
  ticket_type?: string;
  delivery_method?: string;
}

export interface PricePoint {
  price_cents: number;
  currency: string;
  quantity: number;
  timestamp: Date;
}

export interface ChangeLog {
  external_listing_id: string;
  previous_price_cents?: number;
  new_price_cents?: number;
  previous_availability?: string;
  new_availability?: string;
  changed_at: Date;
}

export interface SourceResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  error_code?: string;
  http_status?: number;
  rate_limit_remaining?: number;
  rate_limit_reset?: Date;
}

export interface SourceCapabilities {
  supports_event_discovery: boolean;
  supports_inventory_sync: boolean;
  supports_price_tracking: boolean;
  supports_availability_tracking: boolean;
  supports_venue_info: boolean;
  supports_artist_info: boolean;
  supports_direct_purchase: boolean; // API transaction mode
  supports_affiliate_mode: boolean;
  typical_api_response_time_ms: number;
  supports_bulk_queries: boolean;
  max_requests_per_minute: number;
  rate_limit_type: 'hard' | 'soft'; // Hard stops requests, soft just warns
}

export interface ReservationResponse {
  success: boolean;
  reservation_id?: string;
  expires_at?: Date;
  error?: string;
}

export interface PurchaseResponse {
  success: boolean;
  order_id?: string;
  confirmation_code?: string;
  tickets?: Array<{
    ticket_id: string;
    barcode?: string;
    delivery_method?: string;
    delivery_info?: string;
  }>;
  error?: string;
}

export interface RefundResponse {
  success: boolean;
  refund_id?: string;
  refunded_amount?: number;
  status?: string;
  error?: string;
}

/**
 * Main interface for external inventory providers
 * Each source connector must implement these methods
 */
export interface IExternalInventoryProvider {
  /**
   * Get source identifier
   */
  getSourceId(): number;

  /**
   * Get source capabilities
   */
  getCapabilities(): SourceCapabilities;

  /**
   * Discover new/upcoming events
   * Should return all events matching criteria from the source
   */
  discoverEvents(options: {
    countries?: string[];
    states?: string[];
    categories?: string[];
    from_date?: Date;
    to_date?: Date;
  }): Promise<SourceResponse<DiscoveredEvent[]>>;

  /**
   * Get a specific event by external ID
   */
  getEvent(external_event_id: string): Promise<SourceResponse<DiscoveredEvent>>;

  /**
   * Get multiple events by IDs
   */
  getEvents(external_event_ids: string[]): Promise<SourceResponse<DiscoveredEvent[]>>;

  /**
   * Get venue information
   */
  getVenue(external_venue_id: string): Promise<SourceResponse<DiscoveredVenue>>;

  /**
   * Get multiple venues
   */
  getVenues(external_venue_ids: string[]): Promise<SourceResponse<DiscoveredVenue[]>>;

  /**
   * Get all listings for an event
   */
  getListings(external_event_id: string): Promise<SourceResponse<DiscoveredListing[]>>;

  /**
   * Get a specific listing by ID
   */
  getListing(external_listing_id: string): Promise<SourceResponse<DiscoveredListing>>;

  /**
   * Get availability summary for an event
   */
  getAvailability(external_event_id: string): Promise<SourceResponse<EventAvailability>>;

  /**
   * Get price history for a listing
   */
  getPrice(external_listing_id: string, limit?: number): Promise<SourceResponse<PricePoint[]>>;

  /**
   * Get detailed ticket information
   */
  getTicketDetails(external_listing_id: string): Promise<SourceResponse<TicketDetails>>;

  /**
   * Get recent changes (for incremental sync)
   * If changes are not supported, return NOT_SUPPORTED
   */
  getChanges(since: Date): Promise<SourceResponse<ChangeLog[]>>;

  /**
   * Reserve inventory (MODE B transactions)
   * If not supported, return NOT_SUPPORTED
   */
  createReservation(external_listing_id: string, quantity: number, duration_minutes?: number): Promise<SourceResponse<ReservationResponse>>;

  /**
   * Release a reservation
   */
  releaseReservation(reservation_id: string): Promise<SourceResponse<{ success: boolean }>>;

  /**
   * Complete a purchase (MODE B transactions)
   * If not supported, return NOT_SUPPORTED
   */
  purchase(
    reservation_id: string,
    buyer_email: string,
    buyer_phone?: string,
    payment_token?: string
  ): Promise<SourceResponse<PurchaseResponse>>;

  /**
   * Get order status
   */
  getOrder(order_id: string): Promise<SourceResponse<{
    id: string;
    status: string;
    tickets?: Array<{ ticket_id: string; barcode?: string }>;
    delivery_status?: string;
  }>>;

  /**
   * Get ticket delivery information
   */
  getDeliveryStatus(order_id: string): Promise<SourceResponse<{
    status: string;
    delivery_method?: string;
    barcode?: string;
    pdf_url?: string;
    sent_to?: string;
  }>>;

  /**
   * Cancel an order
   */
  cancelOrder(order_id: string): Promise<SourceResponse<{ success: boolean }>>;

  /**
   * Refund a completed order
   */
  refundOrder(order_id: string, amount_cents?: number): Promise<SourceResponse<RefundResponse>>;

  /**
   * Get affiliate tracking URL
   * Returns a URL with tracking parameters for affiliate mode (MODE A)
   */
  getAffiliateTrackingUrl(external_listing_id: string, session_id?: string): Promise<SourceResponse<{
    url: string;
    click_id?: string;
  }>>;

  /**
   * Health check - verify API connectivity
   */
  healthCheck(): Promise<{ healthy: boolean; message?: string }>;

  /**
   * Handle webhook callback from source (for real-time updates)
   */
  handleWebhook?(payload: any): Promise<{ acknowledged: boolean }>;
}

/**
 * Generic response indicating operation not supported by this source
 */
export const NOT_SUPPORTED = {
  success: false,
  error: 'NOT_SUPPORTED',
  error_code: 'NOT_SUPPORTED'
};
