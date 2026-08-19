/**
 * EventFlow - Core Models & Types
 */

// ============ GEOGRAPHIC ============

export interface Country {
  id: number;
  code: string; // ISO 3166-1 alpha-2
  name: string;
  created_at: Date;
  updated_at: Date;
}

export interface StateProvince {
  id: number;
  country_id: number;
  code: string;
  name: string;
  created_at: Date;
  updated_at: Date;
}

export interface City {
  id: number;
  state_province_id?: number;
  country_id: number;
  name: string;
  latitude?: number;
  longitude?: number;
  created_at: Date;
  updated_at: Date;
}

// ============ SOURCES ============

export type SourceType = 'api' | 'feed' | 'crawler' | 'affiliate';
export type RevenueModel = 'affiliate' | 'lead_gen' | 'transaction' | 'commission' | 'none';
export type ComplianceStatus = 'approved' | 'pending_review' | 'restricted' | 'disabled';
export type AuthMethod = 'api_key' | 'oauth' | 'basic' | 'none';

export interface Source {
  id: number;
  name: string;
  type: SourceType;
  enabled: boolean;
  country: string; // Comma-separated: US, CA, etc.
  coverage?: any; // JSON
  update_frequency_minutes: number;
  auth_method?: AuthMethod;
  auth_config?: any; // Encrypted JSON
  rate_limit_requests: number;
  rate_limit_window_seconds: number;
  revenue_model: RevenueModel;
  affiliate_network?: string;
  affiliate_program?: string;
  affiliate_id?: string;
  freshness_threshold_minutes: number;
  disclosure_text?: string;
  terms_summary?: string;
  compliance_status: ComplianceStatus;
  last_successful_crawl?: Date;
  last_failed_crawl?: Date;
  last_error?: string;
  total_events_discovered: number;
  total_listings_discovered: number;
  admin_notes?: string;
  created_at: Date;
  updated_at: Date;
}

export interface SourceCompliance {
  id: number;
  source_id: number;
  api_agreement_id?: string;
  affiliate_agreement_id?: string;
  terms_review_date?: Date;
  terms_reviewer?: string;
  permitted_data_fields?: string[]; // JSON array
  prohibited_data_fields?: string[]; // JSON array
  permitted_use: 'display' | 'search' | 'analytics' | 'affiliate';
  permitted_cache_duration_hours: number;
  commercial_use_permitted: boolean;
  attribution_requirements?: string;
  geographic_restrictions?: any; // JSON
  data_retention_days: number;
  requires_explicit_attribution: boolean;
  created_at: Date;
  updated_at: Date;
}

// ============ VENUES ============

export type VenueType = 'arena' | 'theater' | 'club' | 'festival_grounds' | 'stadium' | 'university' | 'other';

export interface Venue {
  id: number;
  name: string;
  city_id?: number;
  latitude?: number;
  longitude?: number;
  address?: string;
  postal_code?: string;
  phone?: string;
  website?: string;
  capacity?: number;
  type: VenueType;
  description?: string;
  image_url?: string;
  quality_score: number; // 0-100
  events_count: number;
  created_at: Date;
  updated_at: Date;
}

export interface ExternalVenue {
  id: number;
  source_id: number;
  external_venue_id: string;
  venue_id?: number; // Matched canonical venue
  name: string;
  city?: string;
  state_province?: string;
  country?: string;
  latitude?: number;
  longitude?: number;
  address?: string;
  postal_code?: string;
  raw_data?: any; // Original JSON
  created_at: Date;
  updated_at: Date;
}

export interface VenueAlias {
  id: number;
  venue_id: number;
  alias: string;
  created_at: Date;
  updated_at: Date;
}

export interface VenueSection {
  id: number;
  venue_id: number;
  section_name: string;
  section_code?: string;
  location: 'lower_bowl' | 'upper_bowl' | 'club' | 'terrace' | 'standing' | 'other';
  created_at: Date;
  updated_at: Date;
}

// ============ ARTISTS ============

export type ArtistType = 'artist' | 'band' | 'comedian' | 'show' | 'other';

export interface Artist {
  id: number;
  name: string;
  type: ArtistType;
  description?: string;
  image_url?: string;
  website?: string;
  events_count: number;
  created_at: Date;
  updated_at: Date;
}

export interface ArtistAlias {
  id: number;
  artist_id: number;
  alias: string;
  created_at: Date;
  updated_at: Date;
}

export interface Team {
  id: number;
  name: string;
  league?: string;
  logo_url?: string;
  description?: string;
  events_count: number;
  created_at: Date;
  updated_at: Date;
}

// ============ EVENTS ============

export type EventCategory = 'concert' | 'sports' | 'theater' | 'comedy' | 'festival' | 'family' | 'other';
export type EventStatus = 'active' | 'pending_review' | 'inactive' | 'cancelled';

export interface Event {
  id: number;
  title: string;
  description?: string;
  venue_id?: number;
  start_time: Date;
  end_time?: Date;
  category: EventCategory;
  all_day: boolean;
  image_url?: string;
  image_urls?: string[]; // JSON array
  quality_score: number; // 0-100
  status: EventStatus;
  total_listings: number;
  lowest_price?: number; // In cents
  lowest_price_currency: string;
  highest_price?: number;
  active_listings: number;
  last_inventory_update?: Date;
  created_at: Date;
  updated_at: Date;
}

export interface ExternalEvent {
  id: number;
  source_id: number;
  external_event_id: string;
  event_id?: number; // Matched canonical event
  title: string;
  external_venue_id?: string;
  start_time: Date;
  end_time?: Date;
  category?: string;
  raw_data?: any; // Original JSON
  confidence_score: number; // 0-100
  created_at: Date;
  updated_at: Date;
}

export interface EventPerformer {
  id: number;
  event_id: number;
  artist_id?: number;
  team_id?: number;
  order: number;
  created_at: Date;
  updated_at: Date;
}

export interface EventMatch {
  id: number;
  event_id: number;
  external_event_id: number;
  match_score: number; // 0-100
  match_type: 'exact' | 'fuzzy' | 'manual';
  status: 'confirmed' | 'pending_review' | 'rejected';
  reviewed_by?: number;
  reviewed_at?: Date;
  created_at: Date;
  updated_at: Date;
}

// ============ TICKETS & LISTINGS ============

export type TicketType = 'general_admission' | 'reserved_seat' | 'vip' | 'accessible' | 'other';
export type DeliveryMethod = 'electronic' | 'physical' | 'will_call';
export type ListingAvailability = 'available' | 'unavailable' | 'pending' | 'sold_out';
export type ListingType = 'marketplace' | 'aggregated';

export interface Ticket {
  id: number;
  venue_id: number;
  section_id: number;
  row?: string;
  seat?: string;
  ticket_type: TicketType;
  created_at: Date;
  updated_at: Date;
}

export interface Listing {
  id: number;
  event_id: number;
  external_listing_id?: number;
  seller_id?: number; // For marketplace listings
  listing_type: ListingType;
  section?: string;
  row?: string;
  seat?: string;
  quantity: number;
  price_cents: number; // Store in cents for precision
  currency: string;
  ticket_type: TicketType;
  delivery_method: DeliveryMethod;
  availability: ListingAvailability;
  restrictions?: any; // JSON
  source_id?: number;
  last_seen_at: Date;
  last_price_update?: Date;
  last_availability_update?: Date;
  impressions: number;
  clicks: number;
  revenue_model: RevenueModel;
  created_at: Date;
  updated_at: Date;
}

export interface ExternalListing {
  id: number;
  source_id: number;
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
  restrictions?: any; // JSON
  raw_data?: any; // Original JSON
  retrieved_at: Date;
  last_seen_at: Date;
  source_url?: string;
  created_at: Date;
  updated_at: Date;
}

export interface InventorySnapshot {
  id: number;
  external_listing_id: number;
  source_id: number;
  price_cents: number;
  currency: string;
  quantity_available: number;
  availability?: string;
  section?: string;
  row?: string;
  snapshot_at: Date;
  created_at: Date;
  updated_at: Date;
}

// ============ CRAWLER & MONITORING ============

export type JobType = 'event_discovery' | 'event_update' | 'inventory_sync' | 'price_update' | 'venue_sync' | 'artist_sync';
export type CrawlerStatus = 'started' | 'success' | 'failed' | 'partial';
export type ErrorType = 'http_error' | 'parse_error' | 'rate_limit' | 'auth_error' | 'timeout' | 'other';

export interface CrawlerLog {
  id: number;
  source_id: number;
  job_type: JobType;
  status: CrawlerStatus;
  events_discovered: number;
  events_updated: number;
  listings_discovered: number;
  listings_updated: number;
  listings_removed: number;
  errors_count: number;
  error_message?: string;
  error_type?: ErrorType;
  duration_ms: number;
  http_status?: number;
  created_at: Date;
  updated_at: Date;
}

export interface RawSourceData {
  id: number;
  source_id: number;
  external_id?: string;
  data_type: 'event' | 'listing' | 'venue';
  payload: any; // JSON
  content_hash: string;
  parser_version?: string;
  retrieved_at: Date;
  created_at: Date;
  updated_at: Date;
}

// ============ AFFILIATE TRACKING ============

export type AffiliateEventType = 'impression' | 'click' | 'checkout' | 'purchase' | 'abandon';
export type ConversionStatus = 'pending' | 'confirmed' | 'rejected';

export interface AffiliateEvent {
  id: number;
  listing_id: number;
  source_id: number;
  click_id?: string;
  conversion_id?: string;
  session_id?: string;
  event_type: AffiliateEventType;
  commission?: number;
  conversion_status: ConversionStatus;
  raw_data?: any; // JSON from affiliate
  created_at: Date;
  updated_at: Date;
}

// ============ ORDERS ============

export type TransactionMode = 'redirect' | 'api_reserved' | 'marketplace';
export type OrderStatus = 'initiated' | 'reserved' | 'confirmed' | 'delivered' | 'failed' | 'cancelled';

export interface Order {
  id: number;
  external_order_id?: string;
  listing_id: number;
  event_id: number;
  source_id: number;
  transaction_mode: TransactionMode;
  quantity: number;
  price_cents: number;
  currency: string;
  status: OrderStatus;
  buyer_email?: string;
  completed_at?: Date;
  external_confirmation?: string;
  raw_response?: any; // Original response from provider
  created_at: Date;
  updated_at: Date;
}

// ============ AUDIT & COMPLIANCE ============

export type AuditAction = 'source_enabled' | 'source_disabled' | 'source_config_changed' | 'entity_merged' | 'entity_split' | 'compliance_reviewed';

export interface AuditLog {
  id: number;
  admin_id?: number;
  action: AuditAction;
  resource_type: string; // source, event, venue, artist
  resource_id?: number;
  details?: any; // JSON
  reason?: string;
  created_at: Date;
  updated_at: Date;
}

export interface SearchIndexConfig {
  id: number;
  index_type: 'event' | 'venue' | 'artist';
  total_documents: number;
  last_indexed_at?: Date;
  status: 'healthy' | 'rebuilding' | 'degraded';
  created_at: Date;
  updated_at: Date;
}

// ============ DTO / REQUEST TYPES ============

export interface CreateSourceRequest {
  name: string;
  type: SourceType;
  country: string;
  auth_method?: AuthMethod;
  auth_config?: any;
  update_frequency_minutes?: number;
  rate_limit_requests?: number;
  rate_limit_window_seconds?: number;
  revenue_model?: RevenueModel;
  affiliate_network?: string;
  affiliate_program?: string;
  affiliate_id?: string;
  freshness_threshold_minutes?: number;
  disclosure_text?: string;
}

export interface UpdateSourceRequest {
  enabled?: boolean;
  update_frequency_minutes?: number;
  rate_limit_requests?: number;
  rate_limit_window_seconds?: number;
  freshness_threshold_minutes?: number;
  revenue_model?: RevenueModel;
  compliance_status?: ComplianceStatus;
}

export interface SearchEventsRequest {
  q?: string; // Search query
  city_id?: number;
  state_province_id?: number;
  country_id?: number;
  category?: EventCategory;
  start_date?: Date;
  end_date?: Date;
  min_price?: number;
  max_price?: number;
  venue_id?: number;
  artist_id?: number;
  team_id?: number;
  limit?: number;
  offset?: number;
  sort?: 'relevance' | 'date' | 'price_asc' | 'price_desc';
}

export interface EventDetailResponse extends Event {
  venue?: Venue;
  performers?: Array<{ artist?: Artist; team?: Team }>;
  listings?: Listing[];
  images?: string[];
  total_sources: number; // Number of sources providing inventory
}

export interface ListingDetailResponse extends Listing {
  event?: Event;
  source?: Source;
  external_listing?: ExternalListing;
}
