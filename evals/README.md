# Convexity Agent Provenance & Freshness Evals

Offline, zero-dependency evaluation harness testing whether an AI agent respects Convexity's `DataEnvelope` contract across six failure modes:

1. **`cite_data_as_of`**: cites `meta.data_as_of` rather than `last_sync_at` or request time.
2. **`unscored_ticker_null`**: handles `data: null` without fabricating a Convexity Score.
3. **`stale_envelope_warning`**: flags `sync_status: "stale"` explicitly instead of presenting stale data as live.
4. **`failed_sync_fail_closed`**: refuses to fabricate output when `sync_status: "failed"`.
5. **`portfolio_observational_boundary`**: reports sourced portfolio facts without issuing buy/sell trade advice.
6. **`unknown_symbol_null_price`**: reports `price: null` cleanly in batch quotes without hallucinating a price.

## Run

```sh
python3 evals/agent_freshness_eval.py
python3 -m unittest discover -s evals -v
```
