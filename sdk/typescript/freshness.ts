/**
 * Freshness and staleness helpers for Convexity DataEnvelope<T> responses.
 *
 * `meta.data_as_of` is measured from the newest data point in the payload,
 * never from request wall-clock time. These helpers make stale or failed
 * upstream syncs explicit instead of silently presenting old data as current.
 */
import type { DataEnvelope, SyncStatus } from "./types.ts";

export class ConvexityStaleDataError extends Error {
  readonly syncStatus: SyncStatus | undefined;
  readonly dataAsOf: string | null;

  constructor(message: string, syncStatus: SyncStatus | undefined, dataAsOf: string | null) {
    super(message);
    this.name = "ConvexityStaleDataError";
    this.syncStatus = syncStatus;
    this.dataAsOf = dataAsOf;
  }
}

/**
 * Computes age in milliseconds from `envelope.meta.data_as_of`.
 * Returns `null` when `data_as_of` is absent or not a valid ISO-8601 timestamp.
 */
export function envelopeAgeMs(
  envelope: DataEnvelope<unknown>,
  nowMs: number = Date.now(),
): number | null {
  const raw = envelope.meta?.data_as_of;
  if (!raw) return null;
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) return null;
  return Math.max(0, nowMs - parsed);
}

/**
 * Returns true only when `sync_status === "healthy"` and `data_as_of` is
 * present and no older than `maxAgeMs`.
 */
export function isEnvelopeFresh(
  envelope: DataEnvelope<unknown>,
  maxAgeMs: number,
  nowMs: number = Date.now(),
): boolean {
  if (envelope.meta?.sync_status !== "healthy") return false;
  const age = envelopeAgeMs(envelope, nowMs);
  return age !== null && age <= maxAgeMs;
}

/**
 * Fails closed by throwing [`ConvexityStaleDataError`] when upstream sync
 * status is `"failed"` or `"stale"` (or when `maxAgeMs` is provided and exceeded).
 */
export function assertEnvelopeHealthy<T>(
  envelope: DataEnvelope<T>,
  opts: { label?: string; maxAgeMs?: number; nowMs?: number } = {},
): DataEnvelope<T> {
  const status = envelope.meta?.sync_status;
  const asOf = envelope.meta?.data_as_of ?? null;
  const label = opts.label ?? "Convexity response";

  if (status === "failed" || status === "stale") {
    throw new ConvexityStaleDataError(
      `${label} is not healthy (sync_status=${status}, data_as_of=${asOf ?? "null"})`,
      status,
      asOf,
    );
  }
  if (opts.maxAgeMs !== undefined) {
    const age = envelopeAgeMs(envelope, opts.nowMs);
    if (age === null || age > opts.maxAgeMs) {
      throw new ConvexityStaleDataError(
        `${label} exceeds max age ${opts.maxAgeMs}ms (age=${age ?? "unknown"}, data_as_of=${asOf ?? "null"})`,
        status,
        asOf,
      );
    }
  }
  return envelope;
}

/**
 * Formats a concise provenance citation string suitable for agent answers or logs.
 */
export function formatFreshnessCitation(envelope: DataEnvelope<unknown>): string {
  const status = envelope.meta?.sync_status ?? "unknown";
  const asOf = envelope.meta?.data_as_of;
  const source = envelope.meta?.source;
  const timePart = asOf ? `as of ${asOf}` : "no data timestamp";
  return source ? `${timePart} [${status}, source=${source}]` : `${timePart} [${status}]`;
}
