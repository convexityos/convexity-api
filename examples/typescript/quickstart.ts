/**
 * Convexity API quickstart. Node 18+ (global fetch), no dependencies.
 *
 * Mint a key in the Convexity terminal (Settings > Developer), then:
 *
 *   export CONVEXITY_API_KEY=cnvxty_live_...
 *   npx tsx quickstart.ts
 */
const BASE = "https://convexityos.com/api/v1";
const KEY = process.env.CONVEXITY_API_KEY;
if (!KEY) throw new Error("Set CONVEXITY_API_KEY to your cnvxty_live_... key");

/** Every response is a DataEnvelope: data plus freshness metadata. */
interface DataEnvelope<T> {
  data: T;
  meta: {
    data_as_of: string | null; // when the newest data point was measured
    last_sync_at: string | null;
    sync_status: "healthy" | "stale" | "failed" | "unknown" | "preview" | "historical";
    source: string | null;
  };
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const resp = await fetch(BASE + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`${resp.status} ${await resp.text()}`);
  return resp.json() as Promise<T>;
}

const quote = await call<DataEnvelope<{ symbol: string; price: number | null; change_percent: number | null }>>(
  "/quote/AAPL",
);
console.log(`AAPL ${quote.data.price} as of ${quote.meta.data_as_of}`);

const score = await call<DataEnvelope<{ ridge_score: number; ridge_score_pct: number | null } | null>>(
  "/convexity-score/AAPL",
);
// data: null is the valid response for unscored tickers, not an error
console.log(score.data === null ? "AAPL: not scored" : `Convexity Score: ${score.data.ridge_score}`);

const screen = await call<DataEnvelope<{ total_matches: number }>>("/screener", { limit: 5 });
console.log(`screener: ${screen.data.total_matches} matches`);
