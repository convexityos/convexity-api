import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  MandateError,
  MandateSpendTracker,
  MandatedConvexityMcpClient,
  ToolPricingCatalog,
  generateAgentKeyPair,
  keyPairFromSeed,
  signMandateJws,
  verifyMandateChain,
} from "./mandate-guard.ts";

const PRICING_URL = new URL("../../mcp/mandate-pricing.json", import.meta.url);
const MCP_README_URL = new URL("../../mcp/README.md", import.meta.url);

test("mcp/mandate-pricing.json covers all 12 documented Convexity MCP tools with read effect", () => {
  const catalog = ToolPricingCatalog.fromFile(PRICING_URL);
  const tools = catalog.list();
  assert.equal(tools.length, 12);

  const readme = readFileSync(MCP_README_URL, "utf8");
  for (const spec of tools) {
    assert.equal(spec.server, "convexity");
    assert.equal(spec.effect, "read");
    assert.equal(spec.resource_uri, `https://convexityos.com/api/v1/mcp/${spec.tool}`);
    assert.equal(spec.amount.cur, "USD");
    assert.ok(readme.includes(`\`${spec.tool}\``), `mcp/README.md should document ${spec.tool}`);
  }
});

test("verifies published convexityos/agent-mandate am/1 key and chain vectors", () => {
  const principal = keyPairFromSeed(new Uint8Array(32).fill(0x01));
  const agentA = keyPairFromSeed(new Uint8Array(32).fill(0x02));

  assert.equal(principal.did, "did:key:z6Mkon3Necd6NkkyfoGoHxid2znGc59LU3K7mubaRcFbLfLX");
  assert.equal(principal.jkt, "UDDReOZl1ipXAfp9wYsm13sDBMK5og--QWdBjzuf6o4");
  assert.equal(agentA.did, "did:key:z6Mko9hTggMwjSTEaJaPUfE6tqcy2xvU6BnNq3e3o8qVBiyH");
  assert.equal(agentA.jkt, "aVBtapLd11SUVKIMGJfPzOEDuN0sXcmzJQNVT-_sKEU");

  const rootTok =
    "eyJhbGciOiJFZERTQSIsInR5cCI6ImFwcGxpY2F0aW9uL2FnZW50LW1hbmRhdGUrand0Iiwia2lkIjoiZGlkOmtleTp6Nk1rb24zTmVjZDZOa2t5Zm9Hb0h4aWQyem5HYzU5TFUzSzdtdWJhUmNGYkxmTFgifQ.eyJ2IjoiYW0vMSIsInR5cCI6Im1hbmRhdGUiLCJqdGkiOiJtbmRfMCIsImlzcyI6ImRpZDprZXk6ejZNa29uM05lY2Q2TmtreWZvR29IeGlkMnpuR2M1OUxVM0s3bXViYVJjRmJMZkxYIiwic3ViIjoiZGlkOmtleTp6Nk1rbzloVGdnTXdqU1RFYUphUFVmRTZ0cWN5Mnh2VTZCbk5xM2UzbzhxVkJpeUgiLCJwYXIiOm51bGwsImlhdCI6MTc5OTk5OTk0MCwibmJmIjoxNzk5OTk5OTQwLCJleHAiOjE4MDAwMDM2MDAsImNuZiI6eyJqa3QiOiJhVkJ0YXBMZDExU1VWS0lNR0pmUHpPRUR1TjBzWGNtekpRTlZULV9zS0VVIn0sImxlZGdlciI6Imh0dHBzOi8vbGVkZ2VyLmV4YW1wbGUuY29tIiwiY2F2Ijp7Im1heF90b3RhbCI6eyJjdXIiOiJVU0QiLCJhbXQiOiIxMDAuMDAifSwibWF4X3Blcl90eG4iOnsiY3VyIjoiVVNEIiwiYW10IjoiMS4wMCJ9LCJhdWQiOlsiKi53ZWF0aGVyY28uY29tIl0sInJlc291cmNlcyI6WyJodHRwczovL2FwaS53ZWF0aGVyY28uY29tL3YzLyoiXSwicHVycG9zZSI6WyJyZXNlYXJjaC5yZWFkb25seSJdLCJkZXB0aCI6MywiZGVsZWdhYmxlIjp0cnVlLCJjdXJyZW5jeSI6IlVTRCJ9fQ.nM7HeV-LeN6DP3sGIFHNINW8X2fVwsR0BKBzy-Zi8Chd6HkWruRdO3V27OwC-G_FvFepfBBjPMZONxt2pVbBCQ";
  const childOk =
    "eyJhbGciOiJFZERTQSIsInR5cCI6ImFwcGxpY2F0aW9uL2FnZW50LW1hbmRhdGUrand0Iiwia2lkIjoiZGlkOmtleTp6Nk1rbzloVGdnTXdqU1RFYUphUFVmRTZ0cWN5Mnh2VTZCbk5xM2UzbzhxVkJpeUgifQ.eyJ2IjoiYW0vMSIsInR5cCI6Im1hbmRhdGUiLCJqdGkiOiJtbmRfMSIsImlzcyI6ImRpZDprZXk6ejZNa285aFRnZ013alNURWFKYVBVZkU2dHFjeTJ4dlU2Qm5OcTNlM284cVZCaXlIIiwic3ViIjoiZGlkOmtleTp6Nk1rdlJYTlljRTdNTWR1eW5XVGdlS2JEYVQxaWlqRFNDOHBacVhaYzhySFByZjIiLCJwYXIiOiJtbmRfMCIsImlhdCI6MTc5OTk5OTk0MCwibmJmIjoxNzk5OTk5OTQwLCJleHAiOjE4MDAwMDM2MDAsImNuZiI6eyJqa3QiOiJuUklFMlZtS2RNakwxSkQ3dGJWN2ZYVmdYeG12MEdLbk1GV1JVSk1UZjlRIn0sImxlZGdlciI6Imh0dHBzOi8vbGVkZ2VyLmV4YW1wbGUuY29tIiwiY2F2Ijp7Im1heF90b3RhbCI6eyJjdXIiOiJVU0QiLCJhbXQiOiIxMC4wMCJ9LCJtYXhfcGVyX3R4biI6eyJjdXIiOiJVU0QiLCJhbXQiOiIwLjUwIn0sImRlcHRoIjoyfX0.zTqeYjLRoUDTQSPxCjRJthFC7YlapUdffkEh6SEmGSDkjVwyPkJUef3aqr-iFuL5QtvMQq9-00g37U5FhrmvAA";
  const childWidens =
    "eyJhbGciOiJFZERTQSIsInR5cCI6ImFwcGxpY2F0aW9uL2FnZW50LW1hbmRhdGUrand0Iiwia2lkIjoiZGlkOmtleTp6Nk1rbzloVGdnTXdqU1RFYUphUFVmRTZ0cWN5Mnh2VTZCbk5xM2UzbzhxVkJpeUgifQ.eyJ2IjoiYW0vMSIsInR5cCI6Im1hbmRhdGUiLCJqdGkiOiJtbmRfMSIsImlzcyI6ImRpZDprZXk6ejZNa285aFRnZ013alNURWFKYVBVZkU2dHFjeTJ4dlU2Qm5OcTNlM284cVZCaXlIIiwic3ViIjoiZGlkOmtleTp6Nk1rdlJYTlljRTdNTWR1eW5XVGdlS2JEYVQxaWlqRFNDOHBacVhaYzhySFByZjIiLCJwYXIiOiJtbmRfMCIsImlhdCI6MTc5OTk5OTk0MCwibmJmIjoxNzk5OTk5OTQwLCJleHAiOjE4MDAwMDM2MDAsImNuZiI6eyJqa3QiOiJuUklFMlZtS2RNakwxSkQ3dGJWN2ZYVmdYeG12MEdLbk1GV1JVSk1UZjlRIn0sImxlZGdlciI6Imh0dHBzOi8vbGVkZ2VyLmV4YW1wbGUuY29tIiwiY2F2Ijp7Im1heF9wZXJfdHhuIjp7ImN1ciI6IlVTRCIsImFtdCI6IjUuMDAifX19.UJH8U6aDl0I211PFJi1hFrwLbwNGKAF8VF5EDOE-9O_ew4YxUe70vAiZ4HUuh11z5AIifzs1-c8YDnEFdEpWAg";

  const verified = verifyMandateChain([rootTok, childOk], {
    trustedRootIssuers: new Set([principal.did]),
    ledger: "https://ledger.example.com",
    now: 1800000000,
    request: {
      resource: "https://api.weatherco.com/v3/forecast/94110",
      amount: { cur: "USD", amt: "0.02" },
      effect: "read",
      purpose: "research.readonly",
      taskId: "tsk_conformance",
    },
  });
  assert.deepEqual(verified.path, ["mnd_0", "mnd_1"]);
  assert.equal(verified.effective.max_per_txn?.amt, "0.50");

  assert.throws(
    () =>
      verifyMandateChain([rootTok, childWidens], {
        trustedRootIssuers: new Set([principal.did]),
        ledger: "https://ledger.example.com",
        now: 1800000000,
      }),
    (err: unknown) => err instanceof MandateError && err.code === "attenuation_violation",
  );
});

test("MandatedConvexityMcpClient enforces attenuation, budgets, fail-closed tools, and read-only refunds", async () => {
  const principal = generateAgentKeyPair();
  const agent = generateAgentKeyPair();
  const ledger = "https://ledger.convexityos.com";

  const rootToken = signMandateJws(
    {
      v: "am/1",
      typ: "mandate",
      jti: "mnd_root",
      iss: principal.did,
      sub: agent.did,
      par: null,
      iat: 1000,
      nbf: 1000,
      exp: 5000,
      cnf: { jkt: agent.jkt },
      ledger,
      cav: {
        currency: "USD",
        max_total: { cur: "USD", amt: "0.012" },
        max_per_txn: { cur: "USD", amt: "0.010" },
        aud: ["convexityos.com"],
        resources: ["https://convexityos.com/api/v1/mcp/*"],
        purpose: ["market.research"],
        effect: "read",
      },
    },
    principal,
  );

  const pricing = ToolPricingCatalog.fromFile(PRICING_URL);
  const tracker = new MandateSpendTracker();
  let transportCalls = 0;
  let shouldFailNext = false;

  const client = new MandatedConvexityMcpClient({
    tokens: [rootToken],
    trustedRootIssuers: new Set([principal.did]),
    ledger,
    pricing,
    tracker,
    clock: () => 2000,
    transport: async (toolName) => {
      transportCalls += 1;
      if (shouldFailNext) {
        shouldFailNext = false;
        throw new Error("simulated 503");
      }
      return { content: [{ type: "text", text: `ok:${toolName}` }], isError: false };
    },
  });

  // Unpriced tool refused before transport runs.
  await assert.rejects(
    () => client.callTool("unregistered_tool"),
    (err: unknown) => err instanceof MandateError && err.code === "unpriced_tool",
  );
  assert.equal(transportCalls, 0);

  // Portfolio tool outside purpose refused before transport runs.
  await assert.rejects(
    () => client.callTool("get_portfolio"),
    (err: unknown) => err instanceof MandateError && err.code === "purpose_not_covered",
  );
  assert.equal(transportCalls, 0);

  // Failing read call is refunded automatically.
  shouldFailNext = true;
  await assert.rejects(() => client.callTool("get_convexity_score", { ticker: "AAPL" }), /simulated 503/);
  assert.equal(transportCalls, 1);
  assert.equal(tracker.spentOn("mnd_root")?.amt, "0");

  // Two successful calls ($0.005 + $0.005 = $0.010) succeed; third ($0.005) exceeds $0.012 cap.
  await client.callTool("get_convexity_score", { ticker: "AAPL" });
  await client.callTool("get_convexity_score", { ticker: "NVDA" });
  assert.equal(transportCalls, 3);

  await assert.rejects(
    () => client.callTool("get_convexity_score", { ticker: "MSFT" }),
    (err: unknown) => err instanceof MandateError && err.code === "budget_exhausted",
  );
  assert.equal(transportCalls, 3);

  const prov = client.provenance("USD");
  assert.equal(prov.root_jti, "mnd_root");
  assert.deepEqual(prov.path, ["mnd_root"]);
  assert.equal(prov.total_spent, "0.01");
  assert.equal(prov.spend_digests.length, 2);
});
