# Convexity TypeScript SDK

Zero-dependency typed client for all 22 paths (25 operations) of the Convexity Public API (`openapi.json`), using native `fetch` (Node 18+, Deno, Bun, browsers).

## Usage

```ts
import {
  ConvexityClient,
  assertEnvelopeHealthy,
  formatFreshnessCitation,
} from "./index.ts";

const client = new ConvexityClient({
  apiKey: process.env.CONVEXITY_API_KEY!,
});

const quote = assertEnvelopeHealthy(await client.quotes.get("AAPL"), {
  label: "AAPL quote",
  maxAgeMs: 15 * 60 * 1000,
});
console.log(quote.data.price, formatFreshnessCitation(quote));

const score = await client.score.get("AAPL", { window_days: 252 });
console.log(score.data === null ? "unscored" : score.data.ridge_score);

const limits = await client.limits();
console.log(`${limits.calls_remaining} calls remaining (${limits.tier})`);
```

## Surface

- `client.quotes`: `get`, `batch`, `history`
- `client.company`: `reference`, `related`, `events`, `screener`
- `client.score`: `get`, `distribution`, `portfolio`, `portfolioHistory`
- `client.webhooks`: `list`, `create`, `events`, `get`, `delete`, `deliveries`, `rotateSecret`, `test`
- `client.exports`: `datasets`, `list`, `create`, `get`, `download`
- `client.limits()`

## Safety & Freshness

- Retries with exponential backoff ONLY on `429 Too Many Requests` (honoring `Retry-After`) and transient `5xx` for idempotent `GET` requests. Non-idempotent `POST` and `DELETE` calls are never retried on `5xx`.
- `envelopeAgeMs`, `isEnvelopeFresh`, `assertEnvelopeHealthy`, and `formatFreshnessCitation` operate strictly on `meta.data_as_of` and `meta.sync_status`.

## Test

```sh
node --test sdk/typescript/client.test.ts
```
