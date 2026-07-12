#!/usr/bin/env bash
# Convexity API quickstart (curl).
# Mint a key in the Convexity terminal: Settings > Developer.
set -euo pipefail
: "${CONVEXITY_API_KEY:?Set CONVEXITY_API_KEY to your cnvxty_live_... key}"

BASE="https://convexityos.com/api/v1"
AUTH="Authorization: Bearer ${CONVEXITY_API_KEY}"
JSON="Content-Type: application/json"

echo "# Single quote (scope: quote:read)"
curl -sS -H "$AUTH" "$BASE/quote/AAPL"
echo

echo "# Batch quotes, up to 25 symbols (scope: quote:read)"
curl -sS -H "$AUTH" -H "$JSON" \
  -d '{"symbols": ["AAPL", "MSFT", "NVDA"]}' \
  "$BASE/quote/batch"
echo

echo "# Three months of daily bars (scope: quote:read)"
curl -sS -H "$AUTH" "$BASE/quote/history/AAPL?range=3M"
echo

echo "# Latest Convexity Score; data is null for unscored tickers (scope: score:read)"
curl -sS -H "$AUTH" "$BASE/convexity-score/AAPL"
echo

echo "# Screener; every criterion is optional, absent means no filter (scope: data:read)"
curl -sS -H "$AUTH" -H "$JSON" \
  -d '{"limit": 5}' \
  "$BASE/screener"
echo

echo "# Your quota and rate-limit state"
curl -sS -H "$AUTH" "$BASE/limits"
echo
