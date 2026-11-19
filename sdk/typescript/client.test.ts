import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ConvexityApiError,
  ConvexityClient,
  ConvexityStaleDataError,
  OPENAPI_OPERATIONS,
  assertEnvelopeHealthy,
  envelopeAgeMs,
  formatFreshnessCitation,
  isEnvelopeFresh,
  type DataEnvelope,
} from "./index.ts";

const OPENAPI_URL = new URL("../../openapi.json", import.meta.url);

test("OPENAPI_OPERATIONS matches every path and method in openapi.json (25/25)", () => {
  const spec = JSON.parse(readFileSync(OPENAPI_URL, "utf8")) as {
    paths: Record<string, Record<string, unknown>>;
  };

  const specOps = new Set<string>();
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const method of Object.keys(methods)) {
      const upper = method.toUpperCase();
      if (upper === "GET" || upper === "POST" || upper === "PUT" || upper === "DELETE" || upper === "PATCH") {
        specOps.add(`${upper} ${path}`);
      }
    }
  }

  const sdkOps = new Set(OPENAPI_OPERATIONS.map((op) => `${op.method} ${op.path}`));
  assert.equal(sdkOps.size, OPENAPI_OPERATIONS.length, "no duplicate entries in OPENAPI_OPERATIONS");

  const missing = [...specOps].filter((op) => !sdkOps.has(op));
  const extra = [...sdkOps].filter((op) => !specOps.has(op));
  assert.deepEqual(missing, [], `SDK missing OpenAPI operations: ${missing.join(", ")}`);
  assert.deepEqual(extra, [], `SDK has stale operations not in OpenAPI: ${extra.join(", ")}`);
  assert.equal(sdkOps.size, 25);
});

test("rejects empty or whitespace-containing API keys", () => {
  assert.throws(() => new ConvexityClient({ apiKey: "" }), /non-empty apiKey/);
  assert.throws(() => new ConvexityClient({ apiKey: "cnvxty_live_abc\n" }), /non-empty apiKey/);
  assert.throws(() => new ConvexityClient({ apiKey: "cnvxty live key" }), /non-empty apiKey/);
});

test("routes all 25 operations with expected HTTP method, URL encoding, query params, and auth header", async () => {
  const seen: Array<{ method: string; url: string; auth: string | null; body: unknown }> = [];

  const mockFetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    seen.push({ method, url, auth: headers.get("authorization"), body });

    if (method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    if (url.endsWith("/download")) {
      return new Response("symbol,score\nAAPL,0.82\n", {
        status: 200,
        headers: { "content-type": "text/csv" },
      });
    }
    return new Response(
      JSON.stringify({
        data: { ok: true },
        meta: { data_as_of: "2026-07-10T20:00:00Z", sync_status: "healthy", source: "convexity" },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const client = new ConvexityClient({
    apiKey: "cnvxty_live_test_key",
    baseUrl: "https://convexityos.com/api/v1/",
    fetch: mockFetch,
  });

  await client.quotes.get("BRK.B");
  await client.quotes.batch(["AAPL", "NVDA"]);
  await client.quotes.history("AAPL", { range: "1Y", interval: "1d" });
  await client.company.reference("AAPL");
  await client.company.related("AAPL", { limit: 10, relation_type: "peer" });
  await client.company.events("AAPL", { lookback_quarters: 4 });
  await client.company.screener({ limit: 5, sort_by: "ridge_score" });
  await client.score.get("AAPL", { window_days: 252, formula_version: "v2" });
  await client.score.distribution("AAPL", { window_days: 180 });
  await client.score.portfolio([{ ticker: "AAPL", weight: 0.6 }, { ticker: "NVDA", weight: 0.4 }]);
  await client.score.portfolioHistory([{ ticker: "AAPL", weight: 1.0 }], "1Y");
  await client.limits();
  await client.webhooks.list();
  await client.webhooks.create({ url: "https://hooks.example/rx", events: ["score.changed"] });
  await client.webhooks.events();
  await client.webhooks.get("wh_123");
  await client.webhooks.delete("wh_123");
  await client.webhooks.deliveries("wh_123", { limit: 25 });
  await client.webhooks.rotateSecret("wh_123");
  await client.webhooks.test("wh_123");
  await client.exports.datasets();
  await client.exports.list();
  await client.exports.create({ dataset: "scores", format: "csv" });
  await client.exports.get("exp_99");
  const dl = await client.exports.download("exp_99");

  assert.equal(seen.length, 25);
  assert.ok(seen.every((r) => r.auth === "Bearer cnvxty_live_test_key"));
  assert.equal(seen[0].method, "GET");
  assert.equal(seen[0].url, "https://convexityos.com/api/v1/quote/BRK.B");
  assert.equal(seen[2].url, "https://convexityos.com/api/v1/quote/history/AAPL?range=1Y&interval=1d");
  assert.equal(seen[7].url, "https://convexityos.com/api/v1/convexity-score/AAPL?window_days=252&formula_version=v2");
  assert.equal(seen[16].method, "DELETE");
  assert.equal(seen[16].url, "https://convexityos.com/api/v1/webhooks/wh_123");
  assert.equal(dl.contentType, "text/csv");
  assert.equal(dl.text(), "symbol,score\nAAPL,0.82\n");
});

test("retries idempotent GET on 429/503 honoring Retry-After, but never retries POST on 500", async () => {
  const sleeps: number[] = [];
  let getCalls = 0;
  let postCalls = 0;

  const mockFetch: typeof globalThis.fetch = async (_url, init) => {
    const method = init?.method ?? "GET";
    if (method === "GET") {
      getCalls += 1;
      if (getCalls === 1) {
        return new Response("rate limited", { status: 429, headers: { "retry-after": "2" } });
      }
      if (getCalls === 2) {
        return new Response("upstream busy", { status: 503 });
      }
      return new Response(
        JSON.stringify({ data: { symbol: "AAPL", name: "Apple" }, meta: { sync_status: "healthy" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    postCalls += 1;
    return new Response("internal error", {
      status: 500,
      headers: { "x-request-id": "req_fail_500" },
    });
  };

  const client = new ConvexityClient({
    apiKey: "cnvxty_live_retry_test",
    fetch: mockFetch,
    maxRetries: 2,
    retryBaseDelayMs: 100,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

  const q = await client.quotes.get("AAPL");
  assert.equal(q.data.symbol, "AAPL");
  assert.equal(getCalls, 3);
  assert.deepEqual(sleeps, [2000, 200]);

  await assert.rejects(
    () => client.webhooks.create({ url: "https://hooks.example/x", events: ["score.changed"] }),
    (err: unknown) =>
      err instanceof ConvexityApiError &&
      err.status === 500 &&
      err.requestId === "req_fail_500",
  );
  assert.equal(postCalls, 1, "POST must not retry on 500");
});

test("freshness helpers compute data_as_of age, fail closed on stale/failed, and format citations", () => {
  const now = Date.parse("2026-07-10T20:10:00Z");
  const healthy: DataEnvelope<{ price: number }> = {
    data: { price: 215.5 },
    meta: {
      data_as_of: "2026-07-10T20:05:00Z",
      sync_status: "healthy",
      source: "polygon",
    },
  };
  assert.equal(envelopeAgeMs(healthy, now), 5 * 60 * 1000);
  assert.equal(isEnvelopeFresh(healthy, 10 * 60 * 1000, now), true);
  assert.equal(isEnvelopeFresh(healthy, 60 * 1000, now), false);
  assert.equal(
    formatFreshnessCitation(healthy),
    "as of 2026-07-10T20:05:00Z [healthy, source=polygon]",
  );
  assert.equal(assertEnvelopeHealthy(healthy, { maxAgeMs: 10 * 60 * 1000, nowMs: now }), healthy);

  const stale: DataEnvelope<null> = {
    data: null,
    meta: { data_as_of: null, sync_status: "stale" },
  };
  assert.equal(envelopeAgeMs(stale, now), null);
  assert.equal(formatFreshnessCitation(stale), "no data timestamp [stale]");
  assert.throws(
    () => assertEnvelopeHealthy(stale, { label: "NVDA quote" }),
    (err: unknown) => err instanceof ConvexityStaleDataError && err.syncStatus === "stale",
  );
});
