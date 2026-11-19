# Convexity Public API

Developer home for the [Convexity](https://convexityos.com) public API: a pinned OpenAPI spec, the MCP server manifest, and runnable quickstarts. This repo holds the contract, not the implementation.

- **Base URL:** `https://convexityos.com/api/v1`
- **Live OpenAPI schema:** `https://convexityos.com/api/v1/openapi.json` (source of truth; [`openapi.json`](openapi.json) in this repo is a pinned snapshot)
- **MCP endpoint:** `https://convexityos.com/api/v1/mcp` (connection guide in [`mcp/`](mcp/))
- **Questions or bugs:** open a GitHub issue on this repo

## Authentication

Every route requires a Bearer API key:

```
Authorization: Bearer cnvxty_live_...
```

Keys are minted in the Convexity terminal under **Settings > Developer** on plans with API access. The plaintext key is shown exactly once at mint time; only a hash is stored server-side. Each key carries the scopes you choose when minting it (see below).

## Plans, quotas, and rate limits

| Plan | Monthly API calls | Burst limits |
|---|---:|---|
| Pro Plus | 10,000 | 60/min, 5,000/day |
| Developer | 100,000 | 60/min, 5,000/day |
| Quant | 1,000,000 | 2,000/min, 1,000,000/day |

Figures as of 2026-07-11. The authoritative numbers for *your* key are always live at `GET /api/v1/limits`, which returns calls used this period, calls remaining, the period reset time, and your rate limit. Current pricing: [convexityos.com/pricing](https://convexityos.com/pricing).

## Scopes

| Scope | Grants | Plans |
|---|---|---|
| `quote:read` | Quotes and price history | any API plan |
| `data:read` | Reference data, screener, events, related companies | any API plan |
| `score:read` | Convexity Score endpoints | any API plan |
| `portfolio:read` | The key owner's own portfolio book over MCP (holdings, tax lots, signals, Copilot plays) | any API plan |
| `webhooks:manage` | Webhook management | Developer, Quant |
| `export:read` | Dataset export jobs | Developer, Quant |

## The DataEnvelope

Every market-data response wraps its payload in the same envelope (management endpoints like `/limits`, `/webhooks`, and `/exports` return plain objects):

```json
{
  "data": { "...": "..." },
  "meta": {
    "data_as_of": "2026-07-10T20:00:04Z",
    "last_sync_at": "2026-07-10T21:00:00Z",
    "sync_status": "healthy",
    "source": "..."
  }
}
```

Three properties worth knowing before you build on it:

- `data_as_of` is computed from the newest data point in the response, never from the request time. Two requests five minutes apart with no new upstream data return the same `data_as_of`.
- Empty results are explicit: `data` comes back empty (or `null`) with `data_as_of: null`. You can always tell "no data exists" apart from "data is stale" apart from an error.
- `sync_status` is one of `healthy | stale | failed | unknown | preview | historical`, reflecting the upstream sync pipeline for that source.

## REST surface

22 routes as of 2026-07-11. Full request/response schemas are in [`openapi.json`](openapi.json).

**Quotes** (`quote:read`)

| Route | Returns |
|---|---|
| `GET /quote/{ticker}` | Single quote: price, change, market cap, volume |
| `POST /quote/batch` | Quotes for up to 25 symbols in one call |
| `GET /quote/history/{ticker}` | OHLCV bars; `range` of `1D 1W 1M 3M YTD 1Y 2Y ALL`, optional `interval` |

**Company data** (`data:read`)

| Route | Returns |
|---|---|
| `GET /reference/{ticker}` | Company profile, key stats, valuation fields |
| `GET /related/{ticker}` | Peers, sector members, supply-chain counterparties |
| `GET /event/{ticker}` | Upcoming earnings plus recent actuals vs estimates |
| `POST /screener` | Screen US equities; every criterion optional, absent means no filter |

**Convexity Score** (`score:read`)

| Route | Returns |
|---|---|
| `GET /convexity-score/{ticker}` | Latest score with factor contributions and sector percentile; `window_days` of 180, 252, or 1260 |
| `GET /convexity-score/{ticker}/distribution` | Sector score distribution |
| `POST /convexity-score/portfolio` | Aggregate score over a submitted holdings list |
| `POST /portfolio/history` | Score history over a submitted holdings list |

Methodology: [convexityos.com/methodology/convexity-score](https://convexityos.com/methodology/convexity-score). `data: null` is the valid response for unscored tickers.

**Webhooks** (`webhooks:manage`, Developer and Quant)

| Route | Purpose |
|---|---|
| `POST /webhooks`, `GET /webhooks` | Create and list endpoints |
| `GET /webhooks/events` | Event catalog |
| `GET /webhooks/{id}`, `DELETE /webhooks/{id}` | Inspect, remove |
| `GET /webhooks/{id}/deliveries` | Delivery log |
| `POST /webhooks/{id}/rotate-secret` | Rotate the signing secret |
| `POST /webhooks/{id}/test` | Send a test ping |

**Exports** (`export:read`, Developer and Quant)

| Route | Purpose |
|---|---|
| `GET /exports/datasets` | Available datasets |
| `POST /exports`, `GET /exports` | Create and list export jobs |
| `GET /exports/{job_id}` | Job status |
| `GET /exports/{job_id}/download` | Download the finished file |

**Account**

| Route | Purpose |
|---|---|
| `GET /limits` | Quota and rate-limit state for the calling key |

## MCP server

The same API is exposed as a remote MCP (Model Context Protocol) server at `https://convexityos.com/api/v1/mcp`, Streamable HTTP transport, so Claude Code, Claude Desktop, and any MCP-capable client can call Convexity data as tools. Unlike most data APIs consumed by agents, every tool result carries the full envelope, so an agent can say "as of `<timestamp>`" instead of passing stale data off as current.

Connection snippets, the twelve-tool catalog, and the registry manifest: [`mcp/`](mcp/).

## Quickstarts

Set `CONVEXITY_API_KEY` to a minted key, then:

- [`examples/quickstart.sh`](examples/quickstart.sh) - curl
- [`examples/python/quickstart.py`](examples/python/quickstart.py) - Python, stdlib only
- [`examples/typescript/quickstart.ts`](examples/typescript/quickstart.ts) - TypeScript, Node 18+, no dependencies
- [`examples/mandated-agent/`](examples/mandated-agent/) - Delegated `am/1` Agent Mandate guard over Convexity MCP using [`mcp/mandate-pricing.json`](mcp/mandate-pricing.json) (Node 22.6+, no dependencies)

## Codegen

Point any OpenAPI generator at the live schema URL or at the pinned [`openapi.json`](openapi.json). The snapshot is refreshed with `python scripts/refresh_spec.py`, which prunes the schema to the public contract and writes stable-sorted JSON, so the commit history of `openapi.json` doubles as a machine-readable API diff log. Human-readable changes: [`CHANGELOG.md`](CHANGELOG.md).

## License

Contents of this repository (spec snapshot, examples, docs) are MIT licensed. Use of the Convexity API itself is governed by the [Terms of Service](https://convexityos.com/terms).
