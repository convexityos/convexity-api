"""Zero-dependency Python client covering all 22 paths (25 operations) of the Convexity Public API."""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable, Optional

from .envelope import DataEnvelope

DEFAULT_BASE_URL = "https://convexityos.com/api/v1"

# Authoritative list of all 25 OpenAPI operations implemented by this SDK.
# Verified against openapi.json by sdk/python/tests/test_sdk.py.
OPENAPI_OPERATIONS: tuple[tuple[str, str], ...] = (
    ("GET", "/api/v1/quote/{ticker}"),
    ("POST", "/api/v1/quote/batch"),
    ("GET", "/api/v1/quote/history/{ticker}"),
    ("GET", "/api/v1/reference/{ticker}"),
    ("GET", "/api/v1/related/{ticker}"),
    ("GET", "/api/v1/event/{ticker}"),
    ("POST", "/api/v1/screener"),
    ("GET", "/api/v1/convexity-score/{ticker}"),
    ("GET", "/api/v1/convexity-score/{ticker}/distribution"),
    ("POST", "/api/v1/convexity-score/portfolio"),
    ("POST", "/api/v1/portfolio/history"),
    ("GET", "/api/v1/limits"),
    ("GET", "/api/v1/webhooks"),
    ("POST", "/api/v1/webhooks"),
    ("GET", "/api/v1/webhooks/events"),
    ("GET", "/api/v1/webhooks/{endpoint_id}"),
    ("DELETE", "/api/v1/webhooks/{endpoint_id}"),
    ("GET", "/api/v1/webhooks/{endpoint_id}/deliveries"),
    ("POST", "/api/v1/webhooks/{endpoint_id}/rotate-secret"),
    ("POST", "/api/v1/webhooks/{endpoint_id}/test"),
    ("GET", "/api/v1/exports"),
    ("POST", "/api/v1/exports"),
    ("GET", "/api/v1/exports/datasets"),
    ("GET", "/api/v1/exports/{job_id}"),
    ("GET", "/api/v1/exports/{job_id}/download"),
)

TransportFn = Callable[
    [str, str, dict[str, str], Optional[bytes], float],
    tuple[int, dict[str, str], bytes],
]


class ConvexityApiError(RuntimeError):
    """HTTP error raised when the Convexity API returns a non-2xx status."""

    def __init__(
        self,
        status: int,
        method: str,
        path: str,
        body_text: str,
        retry_after_seconds: Optional[float] = None,
        request_id: Optional[str] = None,
    ) -> None:
        super().__init__(f"Convexity API {method} {path} failed ({status}): {body_text}")
        self.status = status
        self.method = method
        self.path = path
        self.body_text = body_text
        self.retry_after_seconds = retry_after_seconds
        self.request_id = request_id


@dataclass(frozen=True)
class ExportDownload:
    content_type: str
    data: bytes

    def text(self) -> str:
        return self.data.decode("utf-8")

    def json(self) -> Any:
        return json.loads(self.text())


def _encode_seg(value: str) -> str:
    cleaned = value.strip()
    if not cleaned:
        raise ValueError("Path parameter must not be empty")
    return urllib.parse.quote(cleaned, safe="")


def _build_query(params: dict[str, Any]) -> str:
    filtered = [(k, str(v)) for k, v in params.items() if v is not None]
    return f"?{urllib.parse.urlencode(filtered)}" if filtered else ""


def _parse_retry_after(headers: dict[str, str]) -> Optional[float]:
    for k, v in headers.items():
        if k.lower() == "retry-after":
            try:
                val = float(v.strip())
                return val if val >= 0 else None
            except ValueError:
                return None
    return None


def _get_header(headers: dict[str, str], name: str) -> Optional[str]:
    target = name.lower()
    for k, v in headers.items():
        if k.lower() == target:
            return v
    return None


def _urllib_transport(
    method: str,
    url: str,
    headers: dict[str, str],
    body: Optional[bytes],
    timeout_s: float,
) -> tuple[int, dict[str, str], bytes]:
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            return resp.status, dict(resp.headers.items()), resp.read()
    except urllib.error.HTTPError as err:
        raw = err.read() if err.fp is not None else b""
        return err.code, dict(err.headers.items()) if err.headers else {}, raw


class _QuotesApi:
    def __init__(self, client: "ConvexityClient") -> None:
        self._c = client

    def get(self, ticker: str) -> DataEnvelope[dict[str, Any]]:
        return DataEnvelope.from_dict(self._c._request_json("GET", f"/quote/{_encode_seg(ticker)}"))

    def batch(self, symbols: list[str]) -> DataEnvelope[dict[str, Any]]:
        return DataEnvelope.from_dict(self._c._request_json("POST", "/quote/batch", {"symbols": symbols}))

    def history(
        self,
        ticker: str,
        *,
        range: Optional[str] = None,
        interval: Optional[str] = None,
    ) -> DataEnvelope[dict[str, Any]]:
        qs = _build_query({"range": range, "interval": interval})
        return DataEnvelope.from_dict(self._c._request_json("GET", f"/quote/history/{_encode_seg(ticker)}{qs}"))


class _CompanyApi:
    def __init__(self, client: "ConvexityClient") -> None:
        self._c = client

    def reference(self, ticker: str) -> DataEnvelope[dict[str, Any]]:
        return DataEnvelope.from_dict(self._c._request_json("GET", f"/reference/{_encode_seg(ticker)}"))

    def related(
        self,
        ticker: str,
        *,
        limit: Optional[int] = None,
        relation_type: Optional[str] = None,
    ) -> DataEnvelope[dict[str, Any]]:
        qs = _build_query({"limit": limit, "relation_type": relation_type})
        return DataEnvelope.from_dict(self._c._request_json("GET", f"/related/{_encode_seg(ticker)}{qs}"))

    def events(
        self,
        ticker: str,
        *,
        lookback_quarters: Optional[int] = None,
    ) -> DataEnvelope[dict[str, Any]]:
        qs = _build_query({"lookback_quarters": lookback_quarters})
        return DataEnvelope.from_dict(self._c._request_json("GET", f"/event/{_encode_seg(ticker)}{qs}"))

    def screener(self, request: Optional[dict[str, Any]] = None) -> DataEnvelope[dict[str, Any]]:
        return DataEnvelope.from_dict(self._c._request_json("POST", "/screener", request or {}))


class _ScoreApi:
    def __init__(self, client: "ConvexityClient") -> None:
        self._c = client

    def get(
        self,
        ticker: str,
        *,
        window_days: Optional[int] = None,
        formula_version: Optional[str] = None,
    ) -> DataEnvelope[Optional[dict[str, Any]]]:
        qs = _build_query({"window_days": window_days, "formula_version": formula_version})
        return DataEnvelope.from_dict(
            self._c._request_json("GET", f"/convexity-score/{_encode_seg(ticker)}{qs}")
        )

    def distribution(
        self,
        ticker: str,
        *,
        window_days: Optional[int] = None,
        formula_version: Optional[str] = None,
    ) -> DataEnvelope[dict[str, Any]]:
        qs = _build_query({"window_days": window_days, "formula_version": formula_version})
        return DataEnvelope.from_dict(
            self._c._request_json("GET", f"/convexity-score/{_encode_seg(ticker)}/distribution{qs}")
        )

    def portfolio(self, holdings: list[dict[str, Any]]) -> DataEnvelope[dict[str, Any]]:
        return DataEnvelope.from_dict(
            self._c._request_json("POST", "/convexity-score/portfolio", {"holdings": holdings})
        )

    def portfolio_history(
        self,
        holdings: list[dict[str, Any]],
        *,
        range: Optional[str] = None,
    ) -> DataEnvelope[dict[str, Any]]:
        payload: dict[str, Any] = {"holdings": holdings}
        if range is not None:
            payload["range"] = range
        return DataEnvelope.from_dict(self._c._request_json("POST", "/portfolio/history", payload))


class _WebhooksApi:
    def __init__(self, client: "ConvexityClient") -> None:
        self._c = client

    def list(self) -> Any:
        return self._c._request_json("GET", "/webhooks")

    def create(
        self,
        url: str,
        events: list[str],
        *,
        description: Optional[str] = None,
        ticker_filter: Optional[list[str]] = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"url": url, "events": events}
        if description is not None:
            payload["description"] = description
        if ticker_filter is not None:
            payload["ticker_filter"] = ticker_filter
        return self._c._request_json("POST", "/webhooks", payload)

    def events(self) -> Any:
        return self._c._request_json("GET", "/webhooks/events")

    def get(self, endpoint_id: str) -> dict[str, Any]:
        return self._c._request_json("GET", f"/webhooks/{_encode_seg(endpoint_id)}")

    def delete(self, endpoint_id: str) -> None:
        self._c._execute("DELETE", f"/webhooks/{_encode_seg(endpoint_id)}")

    def deliveries(self, endpoint_id: str, *, limit: Optional[int] = None) -> Any:
        qs = _build_query({"limit": limit})
        return self._c._request_json("GET", f"/webhooks/{_encode_seg(endpoint_id)}/deliveries{qs}")

    def rotate_secret(self, endpoint_id: str) -> dict[str, Any]:
        return self._c._request_json("POST", f"/webhooks/{_encode_seg(endpoint_id)}/rotate-secret")

    def test(self, endpoint_id: str) -> dict[str, Any]:
        return self._c._request_json("POST", f"/webhooks/{_encode_seg(endpoint_id)}/test")


class _ExportsApi:
    def __init__(self, client: "ConvexityClient") -> None:
        self._c = client

    def datasets(self) -> Any:
        return self._c._request_json("GET", "/exports/datasets")

    def list(self) -> Any:
        return self._c._request_json("GET", "/exports")

    def create(
        self,
        dataset: str,
        *,
        format: Optional[str] = None,
        params: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"dataset": dataset}
        if format is not None:
            payload["format"] = format
        if params is not None:
            payload["params"] = params
        return self._c._request_json("POST", "/exports", payload)

    def get(self, job_id: str) -> dict[str, Any]:
        return self._c._request_json("GET", f"/exports/{_encode_seg(job_id)}")

    def download(self, job_id: str) -> ExportDownload:
        _, headers, raw = self._c._execute("GET", f"/exports/{_encode_seg(job_id)}/download")
        ct = _get_header(headers, "content-type") or "application/octet-stream"
        return ExportDownload(content_type=ct, data=raw)


class ConvexityClient:
    """Zero-dependency Python client for the Convexity Public API."""

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = DEFAULT_BASE_URL,
        transport: Optional[TransportFn] = None,
        max_retries: int = 2,
        retry_base_delay_s: float = 0.25,
        sleep_fn: Callable[[float], None] = time.sleep,
        timeout_s: float = 30.0,
    ) -> None:
        if not api_key or any(ch.isspace() for ch in api_key):
            raise ValueError("ConvexityClient requires a non-empty api_key without whitespace")
        self._api_key = api_key
        self._base_url = base_url.strip().rstrip("/")
        self._transport = transport or _urllib_transport
        self._max_retries = max_retries
        self._retry_base_delay_s = retry_base_delay_s
        self._sleep_fn = sleep_fn
        self._timeout_s = timeout_s

        self.quotes = _QuotesApi(self)
        self.company = _CompanyApi(self)
        self.score = _ScoreApi(self)
        self.webhooks = _WebhooksApi(self)
        self.exports = _ExportsApi(self)

    def limits(self) -> dict[str, Any]:
        """Returns live quota usage, calls remaining, and rate-limit state for this key."""
        return self._request_json("GET", "/limits")

    def _execute(
        self,
        method: str,
        path: str,
        body_obj: Any = None,
    ) -> tuple[int, dict[str, str], bytes]:
        url = f"{self._base_url}{path}"
        body = json.dumps(body_obj).encode("utf-8") if body_obj is not None else None
        is_idempotent = method == "GET"

        attempt = 0
        while True:
            headers = {
                "Authorization": f"Bearer {self._api_key}",
                "Accept": "application/json",
            }
            if body is not None:
                headers["Content-Type"] = "application/json"

            status, resp_headers, raw = self._transport(method, url, headers, body, self._timeout_s)
            if 200 <= status < 300:
                return status, resp_headers, raw

            retry_after = _parse_retry_after(resp_headers)
            can_retry = attempt < self._max_retries and (
                status == 429 or (is_idempotent and 500 <= status < 600)
            )
            if can_retry:
                delay = retry_after if retry_after is not None else self._retry_base_delay_s * (2**attempt)
                self._sleep_fn(delay)
                attempt += 1
                continue

            raise ConvexityApiError(
                status=status,
                method=method,
                path=path,
                body_text=raw.decode("utf-8", errors="replace"),
                retry_after_seconds=retry_after,
                request_id=_get_header(resp_headers, "x-request-id"),
            )

    def _request_json(self, method: str, path: str, body_obj: Any = None) -> Any:
        _, _, raw = self._execute(method, path, body_obj)
        return json.loads(raw.decode("utf-8"))
