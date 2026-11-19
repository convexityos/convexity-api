/**
 * Mandated Convexity MCP agent quickstart. Node 22.6+ / Node 24 LTS, zero dependencies.
 *
 * Demonstrates a Principal -> Orchestrator -> Research Subagent am/1 delegation chain
 * guarding Convexity MCP tool calls using mcp/mandate-pricing.json:
 *
 *   # Offline verification demo (no API key or network needed):
 *   node examples/mandated-agent/quickstart.ts --demo
 *
 *   # Live mode against https://convexityos.com/api/v1/mcp:
 *   export CONVEXITY_API_KEY=cnvxty_live_...
 *   node examples/mandated-agent/quickstart.ts
 */
import {
  MandateError,
  MandateSpendTracker,
  MandatedConvexityMcpClient,
  ToolPricingCatalog,
  createHttpConvexityMcpTransport,
  generateAgentKeyPair,
  signMandateJws,
  type McpTransport,
} from "./mandate-guard.ts";

const PRICING_PATH = new URL("../../mcp/mandate-pricing.json", import.meta.url);
const LEDGER = "https://ledger.convexityos.com";

const demoFlag = process.argv.includes("--demo");
const apiKey = process.env.CONVEXITY_API_KEY;
const isDemo = demoFlag || !apiKey;

if (!apiKey && !demoFlag) {
  console.log("CONVEXITY_API_KEY not set; running deterministic offline --demo mode.\n");
}

// 1. Mint keys for Principal, Orchestrator, and Research Subagent.
const principal = generateAgentKeyPair();
const orchestrator = generateAgentKeyPair();
const researcher = generateAgentKeyPair();

const now = Math.floor(Date.now() / 1000);

// 2. Principal grants Orchestrator a $0.05 read-only budget across research and portfolio observation.
const rootToken = signMandateJws(
  {
    v: "am/1",
    typ: "mandate",
    jti: "mnd_root_session",
    iss: principal.did,
    sub: orchestrator.did,
    par: null,
    iat: now,
    nbf: now,
    exp: now + 3600,
    cnf: { jkt: orchestrator.jkt },
    ledger: LEDGER,
    cav: {
      currency: "USD",
      max_total: { cur: "USD", amt: "0.05" },
      max_per_txn: { cur: "USD", amt: "0.02" },
      aud: ["convexityos.com"],
      resources: ["https://convexityos.com/api/v1/mcp/*"],
      purpose: ["market.research", "portfolio.observe"],
      effect: "read",
      depth: 2,
      delegable: true,
    },
  },
  principal,
);

// 3. Orchestrator attenuates a narrower delegation for the Research Subagent:
//    $0.012 total, $0.01 per call, market.research ONLY (portfolio tools blocked).
const childToken = signMandateJws(
  {
    v: "am/1",
    typ: "mandate",
    jti: "mnd_subagent_research",
    iss: orchestrator.did,
    sub: researcher.did,
    par: "mnd_root_session",
    iat: now,
    nbf: now,
    exp: now + 1800,
    cnf: { jkt: researcher.jkt },
    ledger: LEDGER,
    cav: {
      max_total: { cur: "USD", amt: "0.012" },
      max_per_txn: { cur: "USD", amt: "0.010" },
      purpose: ["market.research"],
      depth: 1,
      delegable: false,
    },
  },
  orchestrator,
);

const pricing = ToolPricingCatalog.fromFile(PRICING_PATH);
const tracker = new MandateSpendTracker();

const demoTransport: McpTransport = async (toolName, args) => ({
  content: [
    {
      type: "text",
      text: JSON.stringify({
        demo_mode: true,
        tool: toolName,
        args,
        note: "Offline dry-run transport; pass CONVEXITY_API_KEY for live Convexity MCP envelopes.",
      }),
    },
  ],
  isError: false,
});

const client = new MandatedConvexityMcpClient({
  tokens: [rootToken, childToken],
  trustedRootIssuers: new Set([principal.did]),
  ledger: LEDGER,
  pricing,
  tracker,
  transport: isDemo ? demoTransport : createHttpConvexityMcpTransport(apiKey!),
});

console.log(`Loaded ${pricing.list().length} priced Convexity MCP tools from mcp/mandate-pricing.json`);
console.log(`Delegated chain: ${principal.did.slice(0, 20)}... -> ${orchestrator.did.slice(0, 20)}... -> ${researcher.did.slice(0, 20)}...\n`);

// Allowed call 1: get_quote ($0.001, purpose: market.research)
const quoteRes = await client.callTool("get_quote", { tickers: ["AAPL", "NVDA"] });
console.log("[ALLOW] get_quote ($0.001):", quoteRes.content[0]?.text?.slice(0, 140));

// Allowed call 2: get_convexity_score ($0.005, purpose: market.research)
const scoreRes = await client.callTool("get_convexity_score", { ticker: "AAPL" });
console.log("[ALLOW] get_convexity_score ($0.005):", scoreRes.content[0]?.text?.slice(0, 140));

// Blocked call 1: portfolio tool outside subagent's attenuated purpose
try {
  await client.callTool("get_portfolio", {});
  throw new Error("Expected get_portfolio to be refused");
} catch (err) {
  if (!(err instanceof MandateError)) throw err;
  console.log(`[DENY]  get_portfolio -> ${err.code}: ${err.message}`);
}

// Blocked call 2: unpriced / unknown tool fails closed before touching network
try {
  await client.callTool("execute_trade", { ticker: "AAPL" });
  throw new Error("Expected execute_trade to be refused");
} catch (err) {
  if (!(err instanceof MandateError)) throw err;
  console.log(`[DENY]  execute_trade -> ${err.code}: ${err.message}`);
}

// Blocked call 3: run_screener ($0.010) exceeds remaining subagent budget ($0.006 left of $0.012)
try {
  await client.callTool("run_screener", { limit: 5 });
  throw new Error("Expected run_screener to exceed remaining budget");
} catch (err) {
  if (!(err instanceof MandateError)) throw err;
  console.log(`[DENY]  run_screener ($0.010) -> ${err.code}: ${err.message}`);
}

console.log("\nMandate provenance (ready for VitnaRunReceiptV1.mandate_provenance):");
console.log(JSON.stringify(client.provenance("USD"), null, 2));
