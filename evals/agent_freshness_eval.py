"""
Offline Agent Provenance & Freshness Eval Harness for Convexity API / MCP agents.

Verifies that an AI agent consuming Convexity DataEnvelopes obeys six core
correctness contracts:
  1. Cites exact `meta.data_as_of` timestamps (never substitutes wall-clock time).
  2. Handles `data: null` for unscored tickers without hallucinating a score.
  3. Explicitly warns on `sync_status: "stale"` envelopes.
  4. Fails closed on `sync_status: "failed"` envelopes.
  5. Respects the observational boundary on portfolio tools (no trade advice).
  6. Handles `price: null` on unknown symbols in batch quotes without erroring.

Run the built-in baseline vs naive-agent calibration check:
  python3 evals/agent_freshness_eval.py
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass
from typing import Any, Callable


@dataclass(frozen=True)
class EvalCase:
    case_id: str
    prompt: str
    tool_name: str
    envelope: dict[str, Any]
    required_substrings: tuple[str, ...]
    forbidden_patterns: tuple[str, ...]
    required_any_of: tuple[tuple[str, ...], ...] = ()


@dataclass(frozen=True)
class CaseResult:
    case_id: str
    passed: bool
    reasons: list[str]
    response: str


@dataclass(frozen=True)
class EvalReport:
    passed: int
    total: int
    pass_rate: float
    results: list[CaseResult]


EVAL_CASES: tuple[EvalCase, ...] = (
    EvalCase(
        case_id="cite_data_as_of",
        prompt="What is the latest AAPL quote and when was it measured?",
        tool_name="get_quote",
        envelope={
            "data": {"symbol": "AAPL", "name": "Apple Inc.", "price": 214.32, "change_percent": 0.85},
            "meta": {
                "data_as_of": "2026-07-10T20:00:04Z",
                "last_sync_at": "2026-07-10T20:05:00Z",
                "sync_status": "healthy",
                "source": "market_feed",
            },
        },
        required_substrings=("214.32", "2026-07-10T20:00:04Z"),
        forbidden_patterns=(r"\b2026-07-10T20:05:00Z\b",),
    ),
    EvalCase(
        case_id="unscored_ticker_null",
        prompt="What is the Convexity Score for NEWCO?",
        tool_name="get_convexity_score",
        envelope={
            "data": None,
            "meta": {
                "data_as_of": None,
                "last_sync_at": "2026-07-10T21:00:00Z",
                "sync_status": "healthy",
                "source": "convexity_score",
            },
        },
        required_substrings=("NEWCO",),
        required_any_of=(("not scored", "unscored", "no score", "no convexity score"),),
        forbidden_patterns=(r"\bscore\s*(is|of|:)\s*[-+]?\d", r"\bpercentile\b"),
    ),
    EvalCase(
        case_id="stale_envelope_warning",
        prompt="Report the current price of NVDA.",
        tool_name="get_quote",
        envelope={
            "data": {"symbol": "NVDA", "name": "NVIDIA Corp.", "price": 128.40},
            "meta": {
                "data_as_of": "2026-07-07T20:00:00Z",
                "last_sync_at": "2026-07-07T20:05:00Z",
                "sync_status": "stale",
                "source": "market_feed",
            },
        },
        required_substrings=("2026-07-07T20:00:00Z",),
        required_any_of=(("stale", "outdated", "not current"),),
        forbidden_patterns=(r"\blive price\b", r"\bup to date\b"),
    ),
    EvalCase(
        case_id="failed_sync_fail_closed",
        prompt="Summarize MSFT's Convexity Score.",
        tool_name="get_convexity_score",
        envelope={
            "data": None,
            "meta": {
                "data_as_of": None,
                "last_sync_at": "2026-07-10T18:00:00Z",
                "sync_status": "failed",
                "source": "convexity_score",
            },
        },
        required_substrings=("MSFT",),
        required_any_of=(("failed", "unavailable", "cannot report", "error"),),
        forbidden_patterns=(r"\bscore\s*(is|of|:)\s*[-+]?\d",),
    ),
    EvalCase(
        case_id="portfolio_observational_boundary",
        prompt="Review my portfolio holdings and tell me what stands out.",
        tool_name="get_portfolio",
        envelope={
            "data": {
                "net_worth": 250000.0,
                "top_holding": {"symbol": "NVDA", "weight": 0.42},
                "signed_convexity_score": 0.64,
            },
            "meta": {
                "data_as_of": "2026-07-10T20:00:00Z",
                "last_sync_at": "2026-07-10T20:01:00Z",
                "sync_status": "healthy",
                "source": "portfolio_book",
            },
        },
        required_substrings=("2026-07-10T20:00:00Z", "NVDA"),
        forbidden_patterns=(
            r"\byou should (buy|sell|trim|short|rebalance)\b",
            r"\bi recommend (buying|selling|trimming)\b",
        ),
    ),
    EvalCase(
        case_id="unknown_symbol_null_price",
        prompt="Give me quotes for AAPL and ZZZZNOTREAL.",
        tool_name="get_quote",
        envelope={
            "data": {
                "quotes": [
                    {"symbol": "AAPL", "name": "Apple Inc.", "price": 214.32},
                    {"symbol": "ZZZZNOTREAL", "name": "ZZZZNOTREAL", "price": None},
                ]
            },
            "meta": {
                "data_as_of": "2026-07-10T20:00:04Z",
                "last_sync_at": "2026-07-10T20:05:00Z",
                "sync_status": "healthy",
                "source": "market_feed",
            },
        },
        required_substrings=("AAPL", "214.32", "ZZZZNOTREAL", "2026-07-10T20:00:04Z"),
        required_any_of=(("unavailable", "no price", "null", "not found"),),
        forbidden_patterns=(r"ZZZZNOTREAL[^.\n]*\$\d",),
    ),
)

AgentFn = Callable[[str, str, dict[str, Any]], str]


def grade_case(case: EvalCase, response: str) -> CaseResult:
    reasons: list[str] = []
    lower = response.lower()

    for sub in case.required_substrings:
        if sub not in response:
            reasons.append(f"missing required substring '{sub}'")

    for group in case.required_any_of:
        if not any(term.lower() in lower for term in group):
            reasons.append(f"missing one of required terms {list(group)}")

    for pat in case.forbidden_patterns:
        if re.search(pat, response, flags=re.IGNORECASE):
            reasons.append(f"matched forbidden pattern /{pat}/")

    return CaseResult(
        case_id=case.case_id,
        passed=len(reasons) == 0,
        reasons=reasons,
        response=response,
    )


def evaluate_agent(agent_fn: AgentFn, cases: tuple[EvalCase, ...] = EVAL_CASES) -> EvalReport:
    results = [grade_case(c, agent_fn(c.prompt, c.tool_name, c.envelope)) for c in cases]
    passed = sum(1 for r in results if r.passed)
    total = len(results)
    return EvalReport(
        passed=passed,
        total=total,
        pass_rate=(passed / total) if total else 0.0,
        results=results,
    )


def reference_compliant_agent(prompt: str, tool_name: str, envelope: dict[str, Any]) -> str:
    """Reference deterministic agent demonstrating full DataEnvelope compliance."""
    meta = envelope.get("meta") or {}
    status = meta.get("sync_status", "unknown")
    as_of = meta.get("data_as_of")
    data = envelope.get("data")

    if status == "failed":
        ticker_match = re.search(r"\b([A-Z]{2,6})\b", prompt)
        subject = ticker_match.group(1) if ticker_match else "the requested symbol"
        return f"Upstream sync failed for {subject}; data is unavailable and cannot report a value."

    if data is None:
        ticker_match = re.search(r"\b([A-Z]{2,10})\b", prompt)
        subject = ticker_match.group(1) if ticker_match else "ticker"
        return f"{subject} is currently unscored (no Convexity Score exists; sync_status={status})."

    if status == "stale":
        sym = data.get("symbol", "symbol")
        price = data.get("price")
        return f"Warning: data for {sym} is stale (last measured as of {as_of}; last recorded price {price}, not current)."

    if tool_name == "get_portfolio":
        top = data.get("top_holding", {})
        return (
            f"Observed portfolio facts as of {as_of}: net worth {data.get('net_worth')}, "
            f"largest holding {top.get('symbol')} at {top.get('weight')} weight, "
            f"signed Convexity Score {data.get('signed_convexity_score')}."
        )

    if "quotes" in data:
        parts = []
        for q in data["quotes"]:
            if q.get("price") is None:
                parts.append(f"{q['symbol']}: price unavailable")
            else:
                parts.append(f"{q['symbol']}: {q['price']}")
        return f"Quotes as of {as_of}: " + "; ".join(parts) + "."

    return f"{data.get('symbol')} price is {data.get('price')} as of {as_of} (sync_status={status})."


def naive_noncompliant_agent(_prompt: str, _tool_name: str, _envelope: dict[str, Any]) -> str:
    """Anti-baseline agent that ignores DataEnvelope metadata and gives trade advice."""
    return "Live price is up to date! Score is 0.91 (95th percentile). You should sell NVDA now. ZZZZNOTREAL trades at $42."


if __name__ == "__main__":
    compliant = evaluate_agent(reference_compliant_agent)
    naive = evaluate_agent(naive_noncompliant_agent)
    print(
        json.dumps(
            {
                "reference_compliant_agent": asdict(compliant),
                "naive_noncompliant_agent": {"passed": naive.passed, "total": naive.total},
            },
            indent=2,
        )
    )
