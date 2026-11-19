"""Unit and OpenAPI contract parity tests for the stdlib-only Python SDK and CLI."""

from __future__ import annotations

import io
import json
import pathlib
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timezone

SDK_ROOT = pathlib.Path(__file__).resolve().parents[1]
REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]
if str(SDK_ROOT) not in sys.path:
    sys.path.insert(0, str(SDK_ROOT))

from convexity_sdk import (  # noqa: E402
    ConvexityApiError,
    ConvexityClient,
    ConvexityStaleDataError,
    DataEnvelope,
    OPENAPI_OPERATIONS,
)
from convexity_sdk.cli import main as cli_main  # noqa: E402


class TestPythonSdk(unittest.TestCase):
    def test_openapi_operations_parity_25_of_25(self) -> None:
        spec = json.loads((REPO_ROOT / "openapi.json").read_text(encoding="utf-8"))
        spec_ops: set[tuple[str, str]] = set()
        for path, methods in spec["paths"].items():
            for method in methods:
                upper = method.upper()
                if upper in ("GET", "POST", "PUT", "DELETE", "PATCH"):
                    spec_ops.add((upper, path))

        sdk_ops = set(OPENAPI_OPERATIONS)
        self.assertEqual(len(sdk_ops), len(OPENAPI_OPERATIONS))
        self.assertEqual(spec_ops - sdk_ops, set(), "SDK missing OpenAPI operations")
        self.assertEqual(sdk_ops - spec_ops, set(), "SDK has stale operations not in OpenAPI")
        self.assertEqual(len(sdk_ops), 25)

    def test_rejects_empty_or_whitespace_api_key(self) -> None:
        with self.assertRaises(ValueError):
            ConvexityClient("")
        with self.assertRaises(ValueError):
            ConvexityClient("cnvxty_live_bad\n")
        with self.assertRaises(ValueError):
            ConvexityClient("cnvxty live")

    def test_all_25_operations_routing_and_auth(self) -> None:
        seen: list[tuple[str, str, str, object]] = []

        def transport(method: str, url: str, headers: dict[str, str], body: bytes | None, _timeout: float):
            parsed = json.loads(body.decode("utf-8")) if body else None
            seen.append((method, url, headers.get("Authorization", ""), parsed))
            if method == "DELETE":
                return 204, {}, b""
            if url.endswith("/download"):
                return 200, {"Content-Type": "text/csv"}, b"symbol,score\nAAPL,0.82\n"
            payload = {
                "data": {"ok": True},
                "meta": {"data_as_of": "2026-07-10T20:00:00Z", "sync_status": "healthy", "source": "convexity"},
            }
            return 200, {"Content-Type": "application/json"}, json.dumps(payload).encode("utf-8")

        c = ConvexityClient("cnvxty_live_py_test", base_url="https://convexityos.com/api/v1/", transport=transport)

        c.quotes.get("BRK.B")
        c.quotes.batch(["AAPL", "NVDA"])
        c.quotes.history("AAPL", range="1Y", interval="1d")
        c.company.reference("AAPL")
        c.company.related("AAPL", limit=10, relation_type="peer")
        c.company.events("AAPL", lookback_quarters=4)
        c.company.screener({"limit": 5})
        c.score.get("AAPL", window_days=252, formula_version="v2")
        c.score.distribution("AAPL", window_days=180)
        c.score.portfolio([{"ticker": "AAPL", "weight": 0.6}])
        c.score.portfolio_history([{"ticker": "AAPL", "weight": 1.0}], range="1Y")
        c.limits()
        c.webhooks.list()
        c.webhooks.create("https://hooks.example/rx", ["score.changed"])
        c.webhooks.events()
        c.webhooks.get("wh_1")
        c.webhooks.delete("wh_1")
        c.webhooks.deliveries("wh_1", limit=20)
        c.webhooks.rotate_secret("wh_1")
        c.webhooks.test("wh_1")
        c.exports.datasets()
        c.exports.list()
        c.exports.create("scores", format="csv")
        c.exports.get("exp_1")
        dl = c.exports.download("exp_1")

        self.assertEqual(len(seen), 25)
        self.assertTrue(all(auth == "Bearer cnvxty_live_py_test" for _, _, auth, _ in seen))
        self.assertEqual(seen[0][1], "https://convexityos.com/api/v1/quote/BRK.B")
        self.assertEqual(seen[2][1], "https://convexityos.com/api/v1/quote/history/AAPL?range=1Y&interval=1d")
        self.assertEqual(seen[16][0], "DELETE")
        self.assertEqual(dl.content_type, "text/csv")
        self.assertEqual(dl.text(), "symbol,score\nAAPL,0.82\n")

    def test_retries_get_429_and_503_never_retries_post_500(self) -> None:
        sleeps: list[float] = []
        counts = {"GET": 0, "POST": 0}

        def transport(method: str, _url: str, _headers: dict[str, str], _body: bytes | None, _timeout: float):
            counts[method] += 1
            if method == "GET":
                if counts["GET"] == 1:
                    return 429, {"Retry-After": "2"}, b"rate limited"
                if counts["GET"] == 2:
                    return 503, {}, b"busy"
                body = json.dumps({"data": {"symbol": "AAPL"}, "meta": {"sync_status": "healthy"}}).encode("utf-8")
                return 200, {"Content-Type": "application/json"}, body
            return 500, {"X-Request-Id": "req_500"}, b"internal error"

        c = ConvexityClient(
            "cnvxty_live_retry",
            transport=transport,
            max_retries=2,
            retry_base_delay_s=0.1,
            sleep_fn=sleeps.append,
        )
        res = c.quotes.get("AAPL")
        self.assertEqual(res.data["symbol"], "AAPL")
        self.assertEqual(counts["GET"], 3)
        self.assertEqual(sleeps, [2.0, 0.2])

        with self.assertRaises(ConvexityApiError) as ctx:
            c.webhooks.create("https://hooks.example/rx", ["score.changed"])
        self.assertEqual(ctx.exception.status, 500)
        self.assertEqual(ctx.exception.request_id, "req_500")
        self.assertEqual(counts["POST"], 1)

    def test_freshness_and_cli_strict_mode(self) -> None:
        now = datetime(2026, 7, 10, 20, 10, 0, tzinfo=timezone.utc)
        healthy = DataEnvelope.from_dict(
            {
                "data": {"symbol": "AAPL", "price": 215.5},
                "meta": {
                    "data_as_of": "2026-07-10T20:05:00Z",
                    "sync_status": "healthy",
                    "source": "polygon",
                },
            }
        )
        self.assertEqual(healthy.age_seconds(now=now), 300.0)
        self.assertTrue(healthy.is_fresh(600.0, now=now))
        self.assertFalse(healthy.is_fresh(60.0, now=now))
        self.assertEqual(healthy.citation(), "as of 2026-07-10T20:05:00Z [healthy, source=polygon]")

        stale = DataEnvelope.from_dict({"data": None, "meta": {"data_as_of": None, "sync_status": "stale"}})
        with self.assertRaises(ConvexityStaleDataError):
            stale.assert_healthy("AAPL")

        # CLI --strict-freshness exits 3 on stale envelope
        def stale_transport(_m, _u, _h, _b, _t):
            payload = {"data": {"symbol": "AAPL", "price": 200.0}, "meta": {"data_as_of": "2026-07-01T00:00:00Z", "sync_status": "stale"}}
            return 200, {"Content-Type": "application/json"}, json.dumps(payload).encode("utf-8")

        client = ConvexityClient("cnvxty_live_cli", transport=stale_transport)
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            rc = cli_main(["--strict-freshness", "quote", "AAPL"], client=client)
        self.assertEqual(rc, 3)
        self.assertIn("freshness error", err.getvalue())


if __name__ == "__main__":
    unittest.main()
