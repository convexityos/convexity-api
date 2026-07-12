#!/usr/bin/env python3
"""Convexity API quickstart. Python 3.10+, stdlib only.

Mint a key in the Convexity terminal (Settings > Developer), then:

    export CONVEXITY_API_KEY=cnvxty_live_...
    python quickstart.py
"""
import json
import os
import urllib.request

BASE = "https://convexityos.com/api/v1"
KEY = os.environ["CONVEXITY_API_KEY"]


def call(path: str, body: dict | None = None) -> dict:
    """GET when body is None, POST otherwise. Returns the parsed JSON."""
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "Authorization": f"Bearer {KEY}",
            "Content-Type": "application/json",
        },
        method="POST" if body is not None else "GET",
    )
    with urllib.request.urlopen(req) as resp:
        return json.load(resp)


# Every response is a DataEnvelope: {"data": ..., "meta": {...}}.
# meta.data_as_of is when the newest data point was measured -- cite it.

quote = call("/quote/AAPL")
print(
    f"AAPL {quote['data']['price']} "
    f"({quote['data']['change_percent']:+.2f}%) "
    f"as of {quote['meta']['data_as_of']}"
)

batch = call("/quote/batch", {"symbols": ["MSFT", "NVDA", "GOOGL"]})
for q in batch["data"]["quotes"]:
    print(f"{q['symbol']}: {q['price']}")

score = call("/convexity-score/AAPL")
if score["data"] is None:
    print("AAPL: not scored")  # the valid response for unscored tickers
else:
    d = score["data"]
    print(
        f"AAPL Convexity Score: {d['ridge_score']} "
        f"(sector rank {d['sector_rank']}/{d['sector_universe_size']})"
    )

screen = call("/screener", {"limit": 5})
print(f"screener: {screen['data']['total_matches']} matches, showing 5")

limits = call("/limits")
print(
    f"quota: {limits['calls_remaining']} calls left this period "
    f"(tier: {limits['tier']})"
)
