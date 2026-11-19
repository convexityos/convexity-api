/**
 * Zero-dependency typed TypeScript client for the Convexity Public API.
 * Covers all 22 paths / 25 operations in openapi.json (Node 18+, Deno, Bun, browsers).
 */
import type {
  BatchQuoteResponse,
  ConvexityScoreDTO,
  CreatedWebhookDTO,
  DataEnvelope,
  DeliveryDTO,
  EventData,
  ExportCreate,
  ExportDownloadResult,
  ExportJobDTO,
  HistoryData,
  HistoryRange,
  LimitsResponse,
  PortfolioHoldingInput,
  PortfolioScoreEnvelope,
  QuoteData,
  ReferenceData,
  RelatedData,
  ScoreWindowDays,
  ScreenerRequest,
  ScreenerResults,
  SecretDTO,
  SectorDistributionSummary,
  WebhookCreate,
  WebhookDTO,
} from "./types.ts";

export const DEFAULT_BASE_URL = "https://convexityos.com/api/v1";

/**
 * Authoritative registry of all 25 OpenAPI operations implemented by this SDK.
 * Verified against openapi.json by sdk/typescript/client.test.ts.
 */
export const OPENAPI_OPERATIONS: ReadonlyArray<{ method: "GET" | "POST" | "DELETE"; path: string }> = [
  { method: "GET", path: "/api/v1/quote/{ticker}" },
  { method: "POST", path: "/api/v1/quote/batch" },
  { method: "GET", path: "/api/v1/quote/history/{ticker}" },
  { method: "GET", path: "/api/v1/reference/{ticker}" },
  { method: "GET", path: "/api/v1/related/{ticker}" },
  { method: "GET", path: "/api/v1/event/{ticker}" },
  { method: "POST", path: "/api/v1/screener" },
  { method: "GET", path: "/api/v1/convexity-score/{ticker}" },
  { method: "GET", path: "/api/v1/convexity-score/{ticker}/distribution" },
  { method: "POST", path: "/api/v1/convexity-score/portfolio" },
  { method: "POST", path: "/api/v1/portfolio/history" },
  { method: "GET", path: "/api/v1/limits" },
  { method: "GET", path: "/api/v1/webhooks" },
  { method: "POST", path: "/api/v1/webhooks" },
  { method: "GET", path: "/api/v1/webhooks/events" },
  { method: "GET", path: "/api/v1/webhooks/{endpoint_id}" },
  { method: "DELETE", path: "/api/v1/webhooks/{endpoint_id}" },
  { method: "GET", path: "/api/v1/webhooks/{endpoint_id}/deliveries" },
  { method: "POST", path: "/api/v1/webhooks/{endpoint_id}/rotate-secret" },
  { method: "POST", path: "/api/v1/webhooks/{endpoint_id}/test" },
  { method: "GET", path: "/api/v1/exports" },
  { method: "POST", path: "/api/v1/exports" },
  { method: "GET", path: "/api/v1/exports/datasets" },
  { method: "GET", path: "/api/v1/exports/{job_id}" },
  { method: "GET", path: "/api/v1/exports/{job_id}/download" },
];

export class ConvexityApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly bodyText: string;
  readonly retryAfterSeconds: number | null;
  readonly requestId: string | null;

  constructor(opts: {
    status: number;
    method: string;
    path: string;
    bodyText: string;
    retryAfterSeconds?: number | null;
    requestId?: string | null;
  }) {
    super(`Convexity API ${opts.method} ${opts.path} failed (${opts.status}): ${opts.bodyText}`);
    this.name = "ConvexityApiError";
    this.status = opts.status;
    this.method = opts.method;
    this.path = opts.path;
    this.bodyText = opts.bodyText;
    this.retryAfterSeconds = opts.retryAfterSeconds ?? null;
    this.requestId = opts.requestId ?? null;
  }
}

export interface ConvexityClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  /** Maximum retries on 429 or transient 5xx for idempotent GET requests (default: 2). */
  maxRetries?: number;
  /** Base backoff delay in ms (default: 250). */
  retryBaseDelayMs?: number;
  /** Optional custom sleep function (useful in deterministic tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Optional per-request timeout in ms (default: 30000). */
  timeoutMs?: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function encodeSeg(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Path parameter must not be empty");
  return encodeURIComponent(trimmed);
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `?${s}` : "";
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header.trim());
  return Number.isFinite(secs) && secs >= 0 ? secs : null;
}

export class ConvexityClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;

  readonly quotes: {
    get: (ticker: string) => Promise<DataEnvelope<QuoteData>>;
    batch: (symbols: string[]) => Promise<DataEnvelope<BatchQuoteResponse>>;
    history: (
      ticker: string,
      opts?: { range?: HistoryRange | string; interval?: string },
    ) => Promise<DataEnvelope<HistoryData>>;
  };

  readonly company: {
    reference: (ticker: string) => Promise<DataEnvelope<ReferenceData>>;
    related: (
      ticker: string,
      opts?: { limit?: number; relation_type?: string },
    ) => Promise<DataEnvelope<RelatedData>>;
    events: (
      ticker: string,
      opts?: { lookback_quarters?: number },
    ) => Promise<DataEnvelope<EventData>>;
    screener: (request?: ScreenerRequest) => Promise<DataEnvelope<ScreenerResults>>;
  };

  readonly score: {
    get: (
      ticker: string,
      opts?: { window_days?: ScoreWindowDays | number; formula_version?: string },
    ) => Promise<DataEnvelope<ConvexityScoreDTO | null>>;
    distribution: (
      ticker: string,
      opts?: { window_days?: ScoreWindowDays | number; formula_version?: string },
    ) => Promise<DataEnvelope<SectorDistributionSummary>>;
    portfolio: (holdings: PortfolioHoldingInput[]) => Promise<PortfolioScoreEnvelope>;
    portfolioHistory: (
      holdings: PortfolioHoldingInput[],
      range?: HistoryRange | string,
    ) => Promise<DataEnvelope<HistoryData>>;
  };

  readonly webhooks: {
    list: () => Promise<WebhookDTO[] | { webhooks: WebhookDTO[] }>;
    create: (body: WebhookCreate) => Promise<CreatedWebhookDTO>;
    events: () => Promise<Record<string, unknown> | string[]>;
    get: (endpointId: string) => Promise<WebhookDTO>;
    delete: (endpointId: string) => Promise<void>;
    deliveries: (
      endpointId: string,
      opts?: { limit?: number },
    ) => Promise<DeliveryDTO[] | { deliveries: DeliveryDTO[] }>;
    rotateSecret: (endpointId: string) => Promise<SecretDTO>;
    test: (endpointId: string) => Promise<Record<string, unknown>>;
  };

  readonly exports: {
    datasets: () => Promise<Record<string, unknown> | Array<Record<string, unknown>>>;
    list: () => Promise<ExportJobDTO[] | { exports: ExportJobDTO[] }>;
    create: (body: ExportCreate) => Promise<ExportJobDTO>;
    get: (jobId: string) => Promise<ExportJobDTO>;
    download: (jobId: string) => Promise<ExportDownloadResult>;
  };

  constructor(opts: ConvexityClientOptions) {
    if (!opts.apiKey || /\s/.test(opts.apiKey)) {
      throw new Error("ConvexityClient requires a non-empty apiKey without whitespace");
    }
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.maxRetries = opts.maxRetries ?? 2;
    this.retryBaseDelayMs = opts.retryBaseDelayMs ?? 250;
    this.sleepFn = opts.sleep ?? defaultSleep;
    this.timeoutMs = opts.timeoutMs ?? 30_000;

    this.quotes = {
      get: (ticker) => this.requestJson("GET", `/quote/${encodeSeg(ticker)}`),
      batch: (symbols) => this.requestJson("POST", "/quote/batch", { symbols }),
      history: (ticker, q) =>
        this.requestJson(
          "GET",
          `/quote/history/${encodeSeg(ticker)}${buildQuery({ range: q?.range, interval: q?.interval })}`,
        ),
    };

    this.company = {
      reference: (ticker) => this.requestJson("GET", `/reference/${encodeSeg(ticker)}`),
      related: (ticker, q) =>
        this.requestJson(
          "GET",
          `/related/${encodeSeg(ticker)}${buildQuery({ limit: q?.limit, relation_type: q?.relation_type })}`,
        ),
      events: (ticker, q) =>
        this.requestJson(
          "GET",
          `/event/${encodeSeg(ticker)}${buildQuery({ lookback_quarters: q?.lookback_quarters })}`,
        ),
      screener: (request = {}) => this.requestJson("POST", "/screener", request),
    };

    this.score = {
      get: (ticker, q) =>
        this.requestJson(
          "GET",
          `/convexity-score/${encodeSeg(ticker)}${buildQuery({
            window_days: q?.window_days,
            formula_version: q?.formula_version,
          })}`,
        ),
      distribution: (ticker, q) =>
        this.requestJson(
          "GET",
          `/convexity-score/${encodeSeg(ticker)}/distribution${buildQuery({
            window_days: q?.window_days,
            formula_version: q?.formula_version,
          })}`,
        ),
      portfolio: (holdings) => this.requestJson("POST", "/convexity-score/portfolio", { holdings }),
      portfolioHistory: (holdings, range) =>
        this.requestJson(
          "POST",
          "/portfolio/history",
          range === undefined ? { holdings } : { holdings, range },
        ),
    };

    this.webhooks = {
      list: () => this.requestJson("GET", "/webhooks"),
      create: (body) => this.requestJson("POST", "/webhooks", body),
      events: () => this.requestJson("GET", "/webhooks/events"),
      get: (endpointId) => this.requestJson("GET", `/webhooks/${encodeSeg(endpointId)}`),
      delete: (endpointId) => this.requestVoid("DELETE", `/webhooks/${encodeSeg(endpointId)}`),
      deliveries: (endpointId, q) =>
        this.requestJson(
          "GET",
          `/webhooks/${encodeSeg(endpointId)}/deliveries${buildQuery({ limit: q?.limit })}`,
        ),
      rotateSecret: (endpointId) =>
        this.requestJson("POST", `/webhooks/${encodeSeg(endpointId)}/rotate-secret`),
      test: (endpointId) => this.requestJson("POST", `/webhooks/${encodeSeg(endpointId)}/test`),
    };

    this.exports = {
      datasets: () => this.requestJson("GET", "/exports/datasets"),
      list: () => this.requestJson("GET", "/exports"),
      create: (body) => this.requestJson("POST", "/exports", body),
      get: (jobId) => this.requestJson("GET", `/exports/${encodeSeg(jobId)}`),
      download: (jobId) => this.requestBinary("GET", `/exports/${encodeSeg(jobId)}/download`),
    };
  }

  /** Returns live quota usage, remaining calls, and rate-limit state for this key. */
  limits(): Promise<LimitsResponse> {
    return this.requestJson("GET", "/limits");
  }

  private async execute(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const isIdempotent = method === "GET";

    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const headers: Record<string, string> = {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
        };
        if (body !== undefined) headers["Content-Type"] = "application/json";

        const resp = await this.fetchImpl(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });

        if (resp.ok) return resp;

        const retryAfter = parseRetryAfter(resp.headers.get("retry-after"));
        const canRetry =
          attempt < this.maxRetries &&
          (resp.status === 429 || (isIdempotent && resp.status >= 500 && resp.status < 600));

        if (canRetry) {
          const delayMs =
            retryAfter !== null
              ? retryAfter * 1000
              : this.retryBaseDelayMs * Math.pow(2, attempt);
          await this.sleepFn(delayMs);
          continue;
        }

        const bodyText = await resp.text().catch(() => "");
        throw new ConvexityApiError({
          status: resp.status,
          method,
          path,
          bodyText,
          retryAfterSeconds: retryAfter,
          requestId: resp.headers.get("x-request-id"),
        });
      } finally {
        clearTimeout(timer);
      }
    }
  }

  private async requestJson<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const resp = await this.execute(method, path, body);
    return (await resp.json()) as T;
  }

  private async requestVoid(method: "DELETE", path: string): Promise<void> {
    await this.execute(method, path);
  }

  private async requestBinary(method: "GET", path: string): Promise<ExportDownloadResult> {
    const resp = await this.execute(method, path);
    const contentType = resp.headers.get("content-type") ?? "application/octet-stream";
    const buf = new Uint8Array(await resp.arrayBuffer());
    return {
      contentType,
      bytes: buf,
      text: () => new TextDecoder().decode(buf),
      json: <T = unknown>() => JSON.parse(new TextDecoder().decode(buf)) as T,
    };
  }
}
