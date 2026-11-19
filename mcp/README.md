# Convexity MCP server

Convexity's public API exposed over the Model Context Protocol, so AI agents can call cited market data as tools.

- **Endpoint:** `https://convexityos.com/api/v1/mcp`
- **Transport:** Streamable HTTP, stateless (one JSON-RPC message per POST, no SSE stream, no session id; `GET` returns 405 by design)
- **Protocol versions:** `2025-06-18`, `2025-03-26`
- **Auth:** the same Bearer API key as the REST surface (`cnvxty_live_...`), minted in the Convexity terminal under Settings > Developer

## Connect

Claude Code:

```sh
claude mcp add --transport http convexity https://convexityos.com/api/v1/mcp \
  --header "Authorization: Bearer YOUR_KEY"
```

Any MCP client (`.mcp.json` or equivalent):

```json
{
  "mcpServers": {
    "convexity": {
      "type": "http",
      "url": "https://convexityos.com/api/v1/mcp",
      "headers": { "Authorization": "Bearer YOUR_KEY" }
    }
  }
}
```

## Tools

Twelve tools, all read-only. Market-data tools need the matching scope on your key; the portfolio tools return only the key owner's own book and are observational by design: they state sourced facts and never advise a trade.

| Tool | Scope | Returns |
|---|---|---|
| `get_quote` | `quote:read` | Current quotes for up to 25 tickers; unknown symbols return `price: null`, never an error |
| `get_price_history` | `quote:read` | OHLCV history for one ticker, ranges 1D to ALL |
| `get_convexity_score` | `score:read` | Latest Convexity Score with factor contributions and sector percentile; `data: null` for unscored tickers |
| `get_company_reference` | `data:read` | Company profile, key stats, valuation fields |
| `run_screener` | `data:read` | Screen US equities by score percentile, sector, market cap, valuation ratios, insider buys, and more |
| `get_company_events` | `data:read` | Upcoming earnings date plus recent actuals vs estimates |
| `get_related_companies` | `data:read` | Peers, sector members, supply-chain counterparties |
| `get_portfolio` | `portfolio:read` | The owner's holdings, net worth, signed Convexity Score, concentration, asset mix |
| `get_tax_lots` | `portfolio:read` | Harvestable losses, realized gains year to date, open lots, wash-sale watch |
| `get_signals` | `portfolio:read` | Observed-fact signals on the owner's book, plus disclosed insider and congressional trades in held names |
| `get_position` | `portfolio:read` | The owner's position in one ticker: cost basis, unrealized P&L, position health |
| `run_copilot_play` | `portfolio:read` | One on-demand Copilot play (`morning_briefing`, `rebalance`, `tax_moves`, `equity`) returning a sourced artifact |

## Behavior worth knowing

- **Metering:** only `tools/call` counts against your monthly quota. `initialize`, `tools/list`, and `ping` are free; per-minute rate limits still apply to every request.
- **Envelopes:** tool results are full `DataEnvelope`s (`data` plus `meta`), so your agent sees `data_as_of` and `sync_status` and can cite freshness instead of guessing.
- **Scope failures** are returned as in-band tool errors (`isError: true`) naming the missing scope, not transport-level 403s, so an LLM client can read the message and tell its user which scope to mint.

## Mandated agents (`am/1`)

[`mandate-pricing.json`](mandate-pricing.json) publishes a machine-readable `am-mcp-pricing-v1` catalog covering all twelve Convexity MCP tools with canonical resource URIs (`https://convexityos.com/api/v1/mcp/<tool>`), `effect: "read"` classifications, purpose tags (`market.research` or `portfolio.observe`), and reference per-call USD weights for [`agent-mandate`](https://github.com/convexityos/agent-mandate) budget enforcement. Amounts are internal budget weights for agent-side spend caps; plan quota consumption is always governed by `GET /api/v1/limits`.

The file loads directly into both `vitna-code`'s Rust `vitna_mcp::ToolPricingCatalog::from_json_str` and the zero-dependency TypeScript quickstart in [`../examples/mandated-agent/`](../examples/mandated-agent/).

## Registry manifest

[`server.json`](server.json) is the manifest for the [MCP registry](https://registry.modelcontextprotocol.io) (format retrieved 2026-07-11 from the modelcontextprotocol/registry reference docs). Before publishing:

1. Validate against the `$schema` URL in the file; the schema evolves.
2. The `com.convexityos/*` namespace requires DNS verification of convexityos.com (a TXT record, per the registry docs). The zero-setup alternative is the GitHub-verified namespace `io.github.convexityos/convexity`.
