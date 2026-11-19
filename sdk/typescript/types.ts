/**
 * TypeScript types for the Convexity Public API (OpenAPI 3.1.0, 22 paths / 25 operations).
 * Zero external dependencies.
 */

export type SyncStatus =
  | "healthy"
  | "stale"
  | "failed"
  | "unknown"
  | "preview"
  | "historical";

export interface DataMeta {
  data_as_of?: string | null;
  last_sync_at?: string | null;
  sync_status?: SyncStatus;
  source?: string | null;
  regime_gate_active?: boolean | null;
}

/** Standard envelope returned by all market-data and scoring endpoints. */
export interface DataEnvelope<T> {
  data: T;
  meta: DataMeta;
}

// ---- Quotes -----------------------------------------------------------------

export interface QuoteData {
  symbol: string;
  name: string;
  price?: number | null;
  change?: number | null;
  change_percent?: number | null;
  prev_close?: number | null;
  volume?: number | null;
  market_cap?: number | null;
  exchange?: string | null;
  currency?: string | null;
  delayed?: boolean | null;
  delay_minutes?: number | null;
}

export interface BatchQuoteRequest {
  symbols: string[];
}

export interface BatchQuoteResponse {
  quotes: Record<string, QuoteData | null> | QuoteData[];
}

export type HistoryRange = "1D" | "1W" | "1M" | "3M" | "YTD" | "1Y" | "2Y" | "ALL";

export interface HistoryPoint {
  date?: string;
  timestamp?: string;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  close?: number | null;
  volume?: number | null;
  [key: string]: unknown;
}

export interface HistoryData {
  symbol: string;
  range: string;
  interval: string;
  points?: HistoryPoint[];
}

// ---- Company Reference, Related, Events, Screener ---------------------------

export interface ReferenceData {
  symbol: string;
  name: string;
  sector?: string | null;
  industry?: string | null;
  description?: string | null;
  ceo?: string | null;
  headquarters?: string | null;
  founded_year?: number | null;
  ipo_date?: string | null;
  employee_count?: number | null;
  market_cap?: number | null;
  pe_ratio?: number | null;
  eps_ttm?: number | null;
  dividend_yield?: number | null;
  beta?: number | null;
  avg_volume_30d?: number | null;
  day_range_low?: number | null;
  day_range_high?: number | null;
  fifty_two_week_low?: number | null;
  fifty_two_week_high?: number | null;
  next_earnings_date?: string | null;
}

export interface RelatedData {
  symbol: string;
  related?: Array<Record<string, unknown>>;
}

export interface EventData {
  symbol: string;
  upcoming_earnings?: Record<string, unknown> | null;
  recent_earnings?: Array<Record<string, unknown>>;
}

export interface ScreenerRequest {
  criteria?: Record<string, unknown>;
  include_symbols?: string[];
  exclude_symbols?: string[];
  symbol_query?: string;
  portfolio_mode?: string;
  sort_by?: string;
  sort_order?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export interface ScreenerResults {
  total_matches: number;
  results?: Array<Record<string, unknown>>;
}

// ---- Convexity Score & Portfolio --------------------------------------------

export type ScoreWindowDays = 180 | 252 | 1260;

export interface ConvexityScoreDTO {
  ticker: string;
  window_days: number;
  computed_at: string;
  data_as_of: string;
  n_observations: number;
  ridge_score?: number | null;
  ridge_score_pct?: number | null;
  sector?: string | null;
  sector_etf?: string | null;
  sector_rank?: number | null;
  sector_universe_size?: number | null;
  formula_version?: string | null;
  coverage_status?: string | null;
  paused_since?: string | null;
  spy?: Record<string, unknown> | null;
}

export interface SectorDistributionSummary {
  symbol: string;
  sector?: string | null;
  sector_size?: number | null;
  ticker_score?: number | null;
  ticker_percentile?: number | null;
  sector_distribution?: Record<string, unknown> | null;
}

export interface PortfolioHoldingInput {
  ticker: string;
  weight?: number;
  shares?: number;
  market_value?: number;
}

export interface PortfolioScoreRequest {
  holdings: PortfolioHoldingInput[];
}

export type PortfolioScoreEnvelope = DataEnvelope<Record<string, unknown>>;

export interface PortfolioHistoryRequest {
  holdings: PortfolioHoldingInput[];
  range?: HistoryRange | string;
}

// ---- Account Limits ---------------------------------------------------------

export interface LimitsResponse {
  tier: string;
  calls_used_this_period: number;
  calls_remaining: number;
  period_start: string;
  period_resets_at: string;
  rate_limit: Record<string, unknown> | number;
  is_service_account: boolean;
}

// ---- Webhooks ---------------------------------------------------------------

export interface WebhookCreate {
  url: string;
  events: string[];
  description?: string | null;
  ticker_filter?: string[] | null;
}

export interface WebhookDTO {
  id: string;
  url: string;
  events: string[];
  description: string | null;
  ticker_filter: string[] | null;
  enabled: boolean;
  created_at: string;
  last_delivery_at: string | null;
}

export interface CreatedWebhookDTO extends WebhookDTO {
  secret: string;
}

export interface SecretDTO {
  id: string;
  secret: string;
}

export interface DeliveryDTO {
  id: string;
  event_type: string;
  status: string;
  attempts: number;
  response_code: number | null;
  error: string | null;
  created_at: string;
  delivered_at: string | null;
  next_retry_at: string | null;
}

// ---- Exports ----------------------------------------------------------------

export interface ExportCreate {
  dataset: string;
  format?: "csv" | "json" | "parquet" | string;
  params?: Record<string, unknown>;
}

export interface ExportJobDTO {
  id: string;
  dataset: string;
  format: string;
  status: string;
  row_count: number | null;
  download_ready: boolean;
  error: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface ExportDownloadResult {
  contentType: string;
  bytes: Uint8Array;
  text(): string;
  json<T = unknown>(): T;
}
