"""Command-line interface for the Convexity Public API (python3 -m convexity_sdk)."""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import asdict
from typing import Any, Optional, Sequence

from .client import ConvexityApiError, ConvexityClient, DEFAULT_BASE_URL
from .envelope import ConvexityStaleDataError, DataEnvelope


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="convexity",
        description="CLI for the Convexity Public API with explicit DataEnvelope freshness citations.",
    )
    parser.add_argument(
        "--api-key",
        default=None,
        help="Convexity API key (defaults to CONVEXITY_API_KEY).",
    )
    parser.add_argument(
        "--base-url",
        default=DEFAULT_BASE_URL,
        help=f"API base URL (default: {DEFAULT_BASE_URL}).",
    )
    parser.add_argument(
        "--json",
        dest="as_json",
        action="store_true",
        help="Print raw JSON output.",
    )
    parser.add_argument(
        "--strict-freshness",
        action="store_true",
        help="Exit non-zero if sync_status is stale or failed.",
    )

    sub = parser.add_subparsers(dest="command", required=True)

    p_quote = sub.add_parser("quote", help="Fetch latest quote for one ticker.")
    p_quote.add_argument("ticker")

    p_batch = sub.add_parser("batch", help="Fetch quotes for up to 25 tickers.")
    p_batch.add_argument("tickers", nargs="+")

    p_hist = sub.add_parser("history", help="Fetch OHLCV history for one ticker.")
    p_hist.add_argument("ticker")
    p_hist.add_argument("--range", default=None)
    p_hist.add_argument("--interval", default=None)

    p_score = sub.add_parser("score", help="Fetch Convexity Score for one ticker.")
    p_score.add_argument("ticker")
    p_score.add_argument("--window-days", type=int, default=None)

    p_ref = sub.add_parser("reference", help="Fetch company reference profile.")
    p_ref.add_argument("ticker")

    p_screen = sub.add_parser("screener", help="Run US equities screener.")
    p_screen.add_argument("--limit", type=int, default=10)
    p_screen.add_argument("--sort-by", default=None)

    sub.add_parser("limits", help="Show quota and rate-limit state for this key.")
    return parser


def _emit_envelope(env: DataEnvelope[Any], *, as_json: bool, strict: bool, label: str) -> None:
    if strict:
        env.assert_healthy(label=label)
    if as_json:
        print(json.dumps({"data": env.data, "meta": asdict(env.meta)}, indent=2))
    else:
        print(f"{label}: {env.citation()}")
        print(json.dumps(env.data, indent=2))


def main(
    argv: Optional[Sequence[str]] = None,
    *,
    client: Optional[ConvexityClient] = None,
) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    if client is None:
        key = args.api_key or os.environ.get("CONVEXITY_API_KEY", "")
        if not key:
            print("Set CONVEXITY_API_KEY or pass --api-key", file=sys.stderr)
            return 2
        client = ConvexityClient(api_key=key, base_url=args.base_url)

    try:
        if args.command == "quote":
            env = client.quotes.get(args.ticker)
            _emit_envelope(env, as_json=args.as_json, strict=args.strict_freshness, label=f"quote {args.ticker}")
        elif args.command == "batch":
            env = client.quotes.batch(args.tickers)
            _emit_envelope(env, as_json=args.as_json, strict=args.strict_freshness, label="batch quotes")
        elif args.command == "history":
            env = client.quotes.history(args.ticker, range=args.range, interval=args.interval)
            _emit_envelope(env, as_json=args.as_json, strict=args.strict_freshness, label=f"history {args.ticker}")
        elif args.command == "score":
            env = client.score.get(args.ticker, window_days=args.window_days)
            _emit_envelope(env, as_json=args.as_json, strict=args.strict_freshness, label=f"score {args.ticker}")
        elif args.command == "reference":
            env = client.company.reference(args.ticker)
            _emit_envelope(env, as_json=args.as_json, strict=args.strict_freshness, label=f"reference {args.ticker}")
        elif args.command == "screener":
            req: dict[str, Any] = {"limit": args.limit}
            if args.sort_by:
                req["sort_by"] = args.sort_by
            env = client.company.screener(req)
            _emit_envelope(env, as_json=args.as_json, strict=args.strict_freshness, label="screener")
        elif args.command == "limits":
            print(json.dumps(client.limits(), indent=2))
        else:
            parser.error(f"Unknown command: {args.command}")
        return 0
    except ConvexityStaleDataError as err:
        print(f"freshness error: {err}", file=sys.stderr)
        return 3
    except ConvexityApiError as err:
        print(f"api error: {err}", file=sys.stderr)
        return 1
