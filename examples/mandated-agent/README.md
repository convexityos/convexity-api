# Mandated Autonomous Agent Quickstart (`am/1` + Convexity MCP)

Zero-dependency TypeScript quickstart showing how to guard Convexity MCP tool calls with an [`am/1` Agent Mandate](https://github.com/convexityos/agent-mandate) delegation chain and the reference pricing catalog in [`mcp/mandate-pricing.json`](../../mcp/mandate-pricing.json).

## What it demonstrates

1. **Delegated authority (`Principal -> Orchestrator -> Research Subagent`)**:
   - The principal issues a root Ed25519 `am/1` mandate (`$0.05` total, `$0.02` per call, `effect: "read"`, `purpose: ["market.research", "portfolio.observe"]`).
   - The orchestrator attenuates a child mandate for a research subagent (`$0.012` total, `$0.010` per call, `purpose: ["market.research"]`, `delegable: false`).
2. **Fail-closed tool pricing**:
   - Every MCP call is looked up in [`mcp/mandate-pricing.json`](../../mcp/mandate-pricing.json) (schema `am-mcp-pricing-v1`, directly consumable by both this TypeScript client and `vitna-code`'s Rust `vitna_mcp::ToolPricingCatalog::from_json_str`).
   - Uncatalogued tools fail closed before any network request is sent.
3. **Budget enforcement and provenance**:
   - Per-ancestor budgets are reserved atomically before each call; only `read` transport failures are refunded.
   - At completion, `client.provenance("USD")` emits a `MandateProvenanceRecord` matching `VitnaRunReceiptV1.mandate_provenance` in `convexityos/vitna-code`.

## Run

Requires Node 22.6+ (Node 24 LTS runs `.ts` natively with zero packages).

```sh
# Deterministic offline demo (no API key or network needed)
node examples/mandated-agent/quickstart.ts --demo

# Live mode against https://convexityos.com/api/v1/mcp
export CONVEXITY_API_KEY=cnvxty_live_...
node examples/mandated-agent/quickstart.ts

# Run unit and cross-language vector tests
node --test examples/mandated-agent/mandate-guard.test.ts
```
