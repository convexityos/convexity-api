"""DataEnvelope freshness, staleness, and citation helpers for the Convexity API."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Generic, Optional, TypeVar

T = TypeVar("T")


class ConvexityStaleDataError(RuntimeError):
    """Raised when a DataEnvelope fails a freshness or upstream sync-health check."""

    def __init__(
        self,
        message: str,
        sync_status: Optional[str] = None,
        data_as_of: Optional[str] = None,
    ) -> None:
        super().__init__(message)
        self.sync_status = sync_status
        self.data_as_of = data_as_of


@dataclass(frozen=True)
class DataMeta:
    data_as_of: Optional[str] = None
    last_sync_at: Optional[str] = None
    sync_status: Optional[str] = None
    source: Optional[str] = None
    regime_gate_active: Optional[bool] = None

    @classmethod
    def from_dict(cls, raw: Optional[dict[str, Any]]) -> "DataMeta":
        if not raw:
            return cls()
        return cls(
            data_as_of=raw.get("data_as_of"),
            last_sync_at=raw.get("last_sync_at"),
            sync_status=raw.get("sync_status"),
            source=raw.get("source"),
            regime_gate_active=raw.get("regime_gate_active"),
        )


def _parse_iso8601(ts: str) -> Optional[datetime]:
    try:
        cleaned = ts[:-1] + "+00:00" if ts.endswith("Z") else ts
        dt = datetime.fromisoformat(cleaned)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except ValueError:
        return None


@dataclass(frozen=True)
class DataEnvelope(Generic[T]):
    """Standard Convexity response wrapper pairing payload data with freshness metadata."""

    data: T
    meta: DataMeta

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "DataEnvelope[Any]":
        return cls(
            data=raw.get("data"),
            meta=DataMeta.from_dict(raw.get("meta")),
        )

    def age_seconds(self, now: Optional[datetime] = None) -> Optional[float]:
        """Age in seconds measured strictly from meta.data_as_of (never request time)."""
        if not self.meta.data_as_of:
            return None
        parsed = _parse_iso8601(self.meta.data_as_of)
        if parsed is None:
            return None
        ref = now.astimezone(timezone.utc) if now is not None else datetime.now(timezone.utc)
        return max(0.0, (ref - parsed).total_seconds())

    def is_fresh(self, max_age_seconds: float, now: Optional[datetime] = None) -> bool:
        """True only when sync_status == 'healthy' and data_as_of is within max_age_seconds."""
        if self.meta.sync_status != "healthy":
            return False
        age = self.age_seconds(now=now)
        return age is not None and age <= max_age_seconds

    def assert_healthy(
        self,
        label: str = "Convexity response",
        max_age_seconds: Optional[float] = None,
        now: Optional[datetime] = None,
    ) -> "DataEnvelope[T]":
        """Fail closed by raising ConvexityStaleDataError on stale/failed or aged data."""
        status = self.meta.sync_status
        as_of = self.meta.data_as_of
        if status in ("stale", "failed"):
            raise ConvexityStaleDataError(
                f"{label} is not healthy (sync_status={status}, data_as_of={as_of or 'null'})",
                sync_status=status,
                data_as_of=as_of,
            )
        if max_age_seconds is not None:
            age = self.age_seconds(now=now)
            if age is None or age > max_age_seconds:
                age_desc = "unknown" if age is None else f"{age:.1f}s"
                raise ConvexityStaleDataError(
                    f"{label} exceeds max age {max_age_seconds}s (age={age_desc}, data_as_of={as_of or 'null'})",
                    sync_status=status,
                    data_as_of=as_of,
                )
        return self

    def citation(self) -> str:
        """Concise provenance citation string for agent answers and CLI output."""
        status = self.meta.sync_status or "unknown"
        time_part = f"as of {self.meta.data_as_of}" if self.meta.data_as_of else "no data timestamp"
        if self.meta.source:
            return f"{time_part} [{status}, source={self.meta.source}]"
        return f"{time_part} [{status}]"
