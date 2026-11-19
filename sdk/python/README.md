# Convexity Python SDK & CLI

Zero-dependency Python 3.11+ client and CLI covering all 22 REST paths (25 operations) in `openapi.json`, using Python's standard library only.

## Usage

```python
import os
from convexity_sdk import ConvexityClient

client = ConvexityClient(api_key=os.environ["CONVEXITY_API_KEY"])

quote = client.quotes.get("AAPL").assert_healthy("AAPL quote", max_age_seconds=900)
print(quote.data["price"], quote.citation())

score = client.score.get("AAPL", window_days=252)
print("unscored" if score.data is None else score.data["ridge_score"])

limits = client.limits()
print(limits["calls_remaining"], limits["tier"])
```

## CLI

```sh
export CONVEXITY_API_KEY=cnvxty_live_...
PYTHONPATH=sdk/python python3 -m convexity_sdk quote AAPL
PYTHONPATH=sdk/python python3 -m convexity_sdk --strict-freshness score AAPL --window-days 252
PYTHONPATH=sdk/python python3 -m convexity_sdk --json limits
```

`--strict-freshness` exits with status `3` if the returned `DataEnvelope` has `sync_status` of `stale` or `failed`.

## Test

```sh
python3 -m unittest discover -s sdk/python/tests -v
```
