"""Shadow research workflow for TradingView/JeV experiments.

The module deliberately keeps research state outside the paper-trading ledger.
It provides deterministic fixture and mock providers for offline development and
leaves live TradingView/JeV calls behind an explicit configuration boundary.
"""

from __future__ import annotations

import asyncio
from getpass import getuser
import hashlib
import json
import logging
import math
import os
import subprocess
import sys
import time
import uuid
from dataclasses import asdict, dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Protocol

import aiosqlite
import httpx

import backtest_engine as bt
import us_client as public_market


logger = logging.getLogger("research_workflow")


RESEARCH_MODE = "shadow"
RESEARCH_POLICY_VERSION = "research-shadow-v1"
QUESTION_VERSION = "jev-questions-v1"
DEFAULT_STRATEGY = "sma_cross"
SUPPORTED_STRATEGIES = frozenset(bt.STRATEGIES)
DEFAULT_TIMEOUT_SECONDS = 8.0


class ResearchProviderError(RuntimeError):
    """A provider failure that should be shown as a deferred research run."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class MarketDataProvider(Protocol):
    async def search(self, query: str) -> list[dict[str, str]]: ...

    async def snapshot(
        self, symbol: str, exchange: str, interval: str
    ) -> "MarketSnapshot": ...


class DecisionProvider(Protocol):
    async def evaluate(
        self, state: dict[str, Any], questions: list[dict[str, str]]
    ) -> dict[str, Any]: ...


@dataclass(frozen=True)
class MarketSnapshot:
    snapshot_id: str
    symbol: str
    exchange: str
    currency: str
    interval: str
    source: str
    observed_at: str
    fetched_at: str
    bar_closed: bool
    latency_ms: int | None
    bars: list[dict[str, Any]]
    ohlcv: dict[str, float | str | None]
    indicators: dict[str, float | None]
    quality: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _hash_json(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _rsi(closes: list[float], period: int = 14) -> float | None:
    if len(closes) <= period:
        return None
    changes = [closes[index] - closes[index - 1] for index in range(1, len(closes))]
    window = changes[-period:]
    gains = [change for change in window if change > 0]
    losses = [-change for change in window if change < 0]
    average_gain = sum(gains) / period if gains else 0.0
    average_loss = sum(losses) / period if losses else 0.0
    if average_loss == 0:
        return 100.0
    relative_strength = average_gain / average_loss
    return round(100 - (100 / (1 + relative_strength)), 4)


def _fixture_bars(symbol: str) -> list[dict[str, Any]]:
    """Return a stable weekday-only series suitable for repeatable tests."""
    base_by_symbol = {"005930": 72_000.0, "AAPL": 190.0, "BTCUSD": 58_000.0}
    base = base_by_symbol.get(symbol.upper(), 100.0)
    start = date(2026, 7, 1)
    bars: list[dict[str, Any]] = []
    current_day = start
    index = 0
    while len(bars) < 60:
        if current_day.weekday() < 5:
            drift = 0.003 * math.sin(index / 4.0) + 0.0015 * index
            close = base * (1 + drift)
            previous_close = bars[-1]["close"] if bars else close * 0.995
            open_price = (previous_close + close) / 2
            high = max(open_price, close) * 1.006
            low = min(open_price, close) * 0.994
            bars.append(
                {
                    "date": current_day.isoformat(),
                    "open": round(open_price, 4),
                    "high": round(high, 4),
                    "low": round(low, 4),
                    "close": round(close, 4),
                    "volume": float(1_000_000 + index * 2_500),
                }
            )
            index += 1
        current_day += timedelta(days=1)
    return bars


class FixtureMarketDataProvider:
    """Offline market provider. Results are explicitly marked as fixture data."""

    _instruments = [
        {"symbol": "005930", "exchange": "KRX", "name": "삼성전자", "currency": "KRW"},
        {"symbol": "AAPL", "exchange": "NASDAQ", "name": "Apple Inc.", "currency": "USD"},
        {"symbol": "BTCUSD", "exchange": "CRYPTO", "name": "Bitcoin", "currency": "USD"},
    ]

    async def search(self, query: str) -> list[dict[str, str]]:
        normalized = query.strip().lower()
        if not normalized:
            return [dict(item) for item in self._instruments]
        return [
            dict(item)
            for item in self._instruments
            if normalized in item["symbol"].lower()
            or normalized in item["exchange"].lower()
            or normalized in item["name"].lower()
        ]

    async def snapshot(self, symbol: str, exchange: str, interval: str) -> MarketSnapshot:
        normalized_symbol = symbol.strip().upper()
        normalized_exchange = exchange.strip().upper()
        instrument = next(
            (
                item
                for item in self._instruments
                if item["symbol"] == normalized_symbol and item["exchange"] == normalized_exchange
            ),
            None,
        )
        if instrument is None:
            raise ResearchProviderError("instrument_not_found", "fixture 종목을 찾을 수 없습니다.")
        if interval != "1D":
            raise ResearchProviderError("unsupported_interval", "fixture는 일봉만 지원합니다.")

        bars = _fixture_bars(normalized_symbol)
        closes = [float(bar["close"]) for bar in bars]
        latest = bars[-1]
        previous = bars[-21]
        indicators = {
            "return_20d_pct": round((closes[-1] / closes[-21] - 1) * 100, 4),
            "sma_20": round(sum(closes[-20:]) / 20, 4),
            "rsi_14": _rsi(closes),
        }
        observed = datetime(2026, 9, 18, 20, 0, tzinfo=timezone.utc)
        return MarketSnapshot(
            snapshot_id=f"fixture-{_hash_json([normalized_symbol, normalized_exchange, interval])[:16]}",
            symbol=normalized_symbol,
            exchange=normalized_exchange,
            currency=instrument["currency"],
            interval=interval,
            source="fixture",
            observed_at=_iso(observed),
            fetched_at=_iso(_utc_now()),
            bar_closed=True,
            latency_ms=0,
            bars=bars,
            ohlcv={
                "date": latest["date"],
                "open": latest["open"],
                "high": latest["high"],
                "low": latest["low"],
                "close": latest["close"],
                "volume": latest["volume"],
            },
            indicators=indicators,
            quality={"status": "ok", "issues": [], "provider_mode": "fixture"},
        )


PUBLIC_INSTRUMENTS = [
    {"symbol": "005930", "exchange": "KRX", "name": "삼성전자", "currency": "KRW"},
    {"symbol": "AAPL", "exchange": "NASDAQ", "name": "Apple Inc.", "currency": "USD"},
    {"symbol": "MSFT", "exchange": "NASDAQ", "name": "Microsoft Corp.", "currency": "USD"},
    {"symbol": "BTC-USD", "exchange": "CRYPTO", "name": "Bitcoin / USD", "currency": "USD"},
    {"symbol": "ETH-USD", "exchange": "CRYPTO", "name": "Ethereum / USD", "currency": "USD"},
    {"symbol": "SOL-USD", "exchange": "CRYPTO", "name": "Solana / USD", "currency": "USD"},
    {"symbol": "BNB-USD", "exchange": "CRYPTO", "name": "BNB / USD", "currency": "USD"},
    {"symbol": "XRP-USD", "exchange": "CRYPTO", "name": "XRP / USD", "currency": "USD"},
    {"symbol": "ADA-USD", "exchange": "CRYPTO", "name": "Cardano / USD", "currency": "USD"},
    {"symbol": "DOGE-USD", "exchange": "CRYPTO", "name": "Dogecoin / USD", "currency": "USD"},
]


def _public_yahoo_symbol(symbol: str, exchange: str) -> str:
    normalized = symbol.strip().upper()
    normalized_exchange = exchange.strip().upper()
    if normalized_exchange == "KRX" and not normalized.endswith((".KS", ".KQ")):
        return f"{normalized}.KS"
    if normalized_exchange == "KOSDAQ" and not normalized.endswith((".KS", ".KQ")):
        return f"{normalized}.KQ"
    if normalized_exchange == "CRYPTO":
        if normalized.endswith("-USD"):
            return normalized
        if normalized.endswith("USD"):
            return f"{normalized[:-3]}-USD"
        return f"{normalized}-USD"
    return normalized


class PublicYahooMarketDataProvider:
    """Explicit manual Yahoo/yfinance provider for the free research path."""

    async def search(self, query: str) -> list[dict[str, str]]:
        normalized = query.strip().lower()
        if not normalized:
            return [dict(item) for item in PUBLIC_INSTRUMENTS]
        return [
            dict(item)
            for item in PUBLIC_INSTRUMENTS
            if normalized in item["symbol"].lower()
            or normalized in item["exchange"].lower()
            or normalized in item["name"].lower()
        ]

    async def snapshot(self, symbol: str, exchange: str, interval: str) -> MarketSnapshot:
        if interval != "1D":
            raise ResearchProviderError("unsupported_interval", "Yahoo public MVP는 일봉만 지원합니다.")
        yahoo_symbol = _public_yahoo_symbol(symbol, exchange)
        started = time.perf_counter()
        try:
            bars = await public_market.get_us_chart(yahoo_symbol, "3M")
        except Exception as exc:  # noqa: BLE001 - provider details stay out of the API
            if "RateLimit" in type(exc).__name__ or "Too Many Requests" in str(exc):
                logger.warning("Yahoo public provider rate limited for %s", yahoo_symbol)
                raise ResearchProviderError("public_rate_limited", "Yahoo Finance public rate limit에 도달했습니다. 잠시 후 다시 시도하세요.") from exc
            logger.exception("Yahoo public provider failed for %s", yahoo_symbol)
            raise ResearchProviderError("public_provider_error", "Yahoo Finance public data 조회에 실패했습니다.") from exc
        if not bars:
            raise ResearchProviderError("public_data_empty", "Yahoo Finance public data가 비어 있습니다.")
        latest = bars[-1]
        try:
            latest_date = date.fromisoformat(str(latest["date"]))
        except (KeyError, TypeError, ValueError) as exc:
            raise ResearchProviderError("public_schema_error", "Yahoo Finance 날짜 형식이 올바르지 않습니다.") from exc
        bar_closed = latest_date < _utc_now().date()
        closes = [float(bar["close"]) for bar in bars if bar.get("close") is not None]
        indicators = {
            "return_20d_pct": round((closes[-1] / closes[-21] - 1) * 100, 4) if len(closes) >= 21 else None,
            "sma_20": round(sum(closes[-20:]) / 20, 4) if len(closes) >= 20 else None,
            "rsi_14": _rsi(closes),
        }
        currency = "KRW" if exchange.strip().upper() in {"KRX", "KOSDAQ", "KOSPI"} else "USD"
        return MarketSnapshot(
            snapshot_id=f"yahoo-public-{_hash_json([yahoo_symbol, interval, latest.get('date')])[:16]}",
            symbol=symbol.strip().upper(),
            exchange=exchange.strip().upper(),
            currency=currency,
            interval=interval,
            source="yahoo_public",
            observed_at=f"{latest_date.isoformat()}T23:59:59Z",
            fetched_at=_iso(_utc_now()),
            bar_closed=bar_closed,
            latency_ms=round((time.perf_counter() - started) * 1000),
            bars=bars,
            ohlcv=latest,
            indicators=indicators,
            quality={
                "status": "ok" if bar_closed else "unknown",
                "issues": [] if bar_closed else ["latest_public_bar_may_be_open"],
                "provider_mode": "yahoo_public",
                "disclaimer": "Public Yahoo Finance data; not TradingView MCP data.",
            },
        )


TRADINGVIEW_MCP_URL = "https://mcp.tradingview.com/mcp"
TYPESAFE_API_URL = "https://api.typesafe.ai/v1/systemone"
TRADINGVIEW_KEYCHAIN_SERVICE = "portfolio-dashboard.tradingview.mcp.oauth"


def _keychain_tradingview_token() -> str:
    if sys.platform != "darwin":
        return ""
    try:
        result = subprocess.run(
            ["security", "find-generic-password", "-a", getuser(), "-s", TRADINGVIEW_KEYCHAIN_SERVICE, "-w"],
            check=True,
            capture_output=True,
            text=True,
            timeout=2,
        )
        payload = json.loads(result.stdout.strip())
        expires_at = payload.get("expires_at")
        if expires_at and float(expires_at) <= time.time():
            return ""
        return str(payload.get("access_token", "")).strip()
    except (OSError, subprocess.SubprocessError, ValueError, TypeError, json.JSONDecodeError):
        return ""


def _configured_tradingview_token() -> str:
    return os.getenv("TRADINGVIEW_MCP_ACCESS_TOKEN", "").strip() or _keychain_tradingview_token()


def _configured_jev_key() -> str:
    return (os.getenv("TYPESAFE_API_KEY") or os.getenv("JEV_API_KEY") or "").strip()


class UnconfiguredTradingViewProvider:
    """Safe boundary until an OAuth access token is injected by the backend."""

    async def search(self, query: str) -> list[dict[str, str]]:
        raise ResearchProviderError(
            "tradingview_not_configured",
            "TradingView 공식 MCP 인증이 구성되지 않았습니다.",
        )

    async def snapshot(self, symbol: str, exchange: str, interval: str) -> MarketSnapshot:
        raise ResearchProviderError(
            "tradingview_not_configured",
            "TradingView 공식 MCP 인증이 구성되지 않았습니다.",
        )


class TradingViewMcpProvider:
    """Minimal read-only client for the official streamable HTTP MCP server.

    OAuth browser consent and encrypted token storage remain product concerns.
    This adapter only accepts a backend-injected access token and never exposes
    it in errors or persisted research records.
    """

    protocol_version = "2025-03-26"

    def __init__(self, url: str | None = None, access_token: str | None = None, timeout: float = 12.0):
        self.url = (url or os.getenv("TRADINGVIEW_MCP_URL") or TRADINGVIEW_MCP_URL).strip()
        self.access_token = (access_token or _configured_tradingview_token()).strip()
        self.timeout = timeout
        if not self.access_token:
            raise ResearchProviderError(
                "tradingview_not_configured",
                "TradingView 공식 MCP access token이 구성되지 않았습니다.",
            )

    @staticmethod
    def _response_payload(response: httpx.Response) -> dict[str, Any] | list[Any] | None:
        content_type = response.headers.get("content-type", "")
        if "text/event-stream" in content_type:
            events: list[Any] = []
            for line in response.text.splitlines():
                if line.startswith("data:"):
                    raw = line[5:].strip()
                    if raw:
                        try:
                            events.append(json.loads(raw))
                        except json.JSONDecodeError:
                            continue
            return events[-1] if events else None
        try:
            return response.json()
        except (ValueError, json.JSONDecodeError):
            return None

    @staticmethod
    def _tool_result(payload: Any) -> Any:
        if not isinstance(payload, dict):
            raise ResearchProviderError("tradingview_schema_error", "TradingView MCP 응답 형식이 올바르지 않습니다.")
        if payload.get("error"):
            raise ResearchProviderError("tradingview_rpc_error", "TradingView MCP read-only 호출이 실패했습니다.")
        result = payload.get("result", payload)
        if not isinstance(result, dict):
            return result
        if result.get("isError"):
            raise ResearchProviderError("tradingview_tool_error", "TradingView MCP read-only 도구 호출이 실패했습니다.")
        content = result.get("content")
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    text = block.get("text", "")
                    try:
                        return json.loads(text)
                    except (TypeError, json.JSONDecodeError):
                        return {"text": str(text)}
        return result

    async def _call_tool(self, name: str, arguments: dict[str, Any]) -> Any:
        headers = {
            "Authorization": f"Bearer {self.access_token}",
            "Accept": "application/json, text/event-stream",
            "Content-Type": "application/json",
        }
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                initialize = await client.post(
                    self.url,
                    headers=headers,
                    json={
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": "initialize",
                        "params": {
                            "protocolVersion": self.protocol_version,
                            "capabilities": {},
                            "clientInfo": {"name": "portfolio-dashboard", "version": "0.1"},
                        },
                    },
                )
                if initialize.status_code in {401, 403}:
                    raise ResearchProviderError("tradingview_auth_failed", "TradingView MCP 인증이 거부되었습니다.")
                if initialize.status_code == 429:
                    raise ResearchProviderError("tradingview_rate_limited", "TradingView MCP 요청 한도에 도달했습니다.")
                initialize.raise_for_status()
                initialize_payload = self._response_payload(initialize)
                session_id = initialize.headers.get("mcp-session-id")
                if isinstance(initialize_payload, dict) and initialize_payload.get("error"):
                    raise ResearchProviderError("tradingview_rpc_error", "TradingView MCP 초기화가 실패했습니다.")

                initialized_headers = dict(headers)
                if session_id:
                    initialized_headers["Mcp-Session-Id"] = session_id
                await client.post(
                    self.url,
                    headers=initialized_headers,
                    json={"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}},
                )
                response = await client.post(
                    self.url,
                    headers=initialized_headers,
                    json={
                        "jsonrpc": "2.0",
                        "id": 2,
                        "method": "tools/call",
                        "params": {"name": name, "arguments": arguments},
                    },
                )
                if response.status_code in {401, 403}:
                    raise ResearchProviderError("tradingview_auth_failed", "TradingView MCP 인증이 거부되었습니다.")
                if response.status_code == 429:
                    raise ResearchProviderError("tradingview_rate_limited", "TradingView MCP 요청 한도에 도달했습니다.")
                response.raise_for_status()
                return self._tool_result(self._response_payload(response))
        except ResearchProviderError:
            raise
        except httpx.TimeoutException as exc:
            raise ResearchProviderError("tradingview_timeout", "TradingView MCP 응답 시간이 초과되었습니다.") from exc
        except httpx.HTTPError as exc:
            raise ResearchProviderError("tradingview_provider_error", "TradingView MCP 연결에 실패했습니다.") from exc

    async def search(self, query: str) -> list[dict[str, str]]:
        payload = await self._call_tool("search_symbols", {"query": query.strip()})
        candidates = payload.get("symbols", payload) if isinstance(payload, dict) else payload
        if not isinstance(candidates, list):
            raise ResearchProviderError("tradingview_schema_error", "TradingView symbol search 응답이 올바르지 않습니다.")
        normalized = []
        for item in candidates[:20]:
            if not isinstance(item, dict) or not item.get("symbol"):
                continue
            symbol = str(item["symbol"])
            exchange, _, ticker = symbol.partition(":")
            normalized.append(
                {
                    "symbol": ticker or symbol,
                    "exchange": str(item.get("exchange") or exchange),
                    "name": str(item.get("description") or ticker or symbol),
                    "currency": "KRW" if exchange in {"KRX", "KOSDAQ", "KOSPI"} else "USD",
                }
            )
        return normalized

    async def snapshot(self, symbol: str, exchange: str, interval: str) -> MarketSnapshot:
        if interval != "1D":
            raise ResearchProviderError("unsupported_interval", "TradingView MVP는 일봉만 지원합니다.")
        routed_symbol = symbol if ":" in symbol else f"{exchange}:{symbol}"
        started = time.perf_counter()
        payload = await self._call_tool(
            "get_ohlcv",
            {"symbol": routed_symbol, "interval": interval, "count": 60, "summary": False},
        )
        raw_bars = payload.get("bars", payload.get("data", [])) if isinstance(payload, dict) else payload
        if not isinstance(raw_bars, list) or not raw_bars:
            raise ResearchProviderError("tradingview_schema_error", "TradingView OHLCV 응답에 bars가 없습니다.")
        bars: list[dict[str, Any]] = []
        for raw in raw_bars:
            if not isinstance(raw, dict):
                raise ResearchProviderError("tradingview_schema_error", "TradingView OHLCV bar 형식이 올바르지 않습니다.")
            timestamp = raw.get("t", raw.get("timestamp"))
            try:
                parsed = datetime.fromtimestamp(float(timestamp), timezone.utc) if isinstance(timestamp, (int, float)) else datetime.fromisoformat(str(timestamp).replace("Z", "+00:00"))
                bars.append(
                    {
                        "date": _iso(parsed),
                        "open": raw.get("o", raw.get("open")),
                        "high": raw.get("h", raw.get("high")),
                        "low": raw.get("l", raw.get("low")),
                        "close": raw.get("c", raw.get("close")),
                        "volume": raw.get("v", raw.get("volume")),
                    }
                )
            except (TypeError, ValueError, OverflowError) as exc:
                raise ResearchProviderError("tradingview_schema_error", "TradingView timestamp 형식이 올바르지 않습니다.") from exc
        last = bars[-1]
        closes = [float(bar["close"]) for bar in bars if bar.get("close") is not None]
        if len(closes) < 20:
            indicators = {"return_20d_pct": None, "sma_20": None, "rsi_14": None}
        else:
            indicators = {
                "return_20d_pct": round((closes[-1] / closes[-21] - 1) * 100, 4),
                "sma_20": round(sum(closes[-20:]) / 20, 4),
                "rsi_14": _rsi(closes),
            }
        bar_closed = bool(payload.get("bar_closed", payload.get("barClosed", False))) if isinstance(payload, dict) else False
        observed_at = str(payload.get("observed_at") or last["date"]) if isinstance(payload, dict) else last["date"]
        return MarketSnapshot(
            snapshot_id=f"tradingview-{_hash_json([routed_symbol, interval, last.get('date')])[:16]}",
            symbol=symbol.split(":")[-1].upper(),
            exchange=exchange.upper(),
            currency="KRW" if exchange.upper() in {"KRX", "KOSDAQ", "KOSPI"} else "USD",
            interval=interval,
            source="tradingview_mcp",
            observed_at=observed_at,
            fetched_at=_iso(_utc_now()),
            bar_closed=bar_closed,
            latency_ms=round((time.perf_counter() - started) * 1000),
            bars=bars,
            ohlcv=last,
            indicators=indicators,
            quality={
                "status": "ok" if bar_closed else "unknown",
                "issues": [] if bar_closed else ["bar_closed_not_reported_by_provider"],
                "provider_mode": "tradingview_mcp",
            },
        )

class MockJevDecisionProvider:
    """Deterministic JeV-shaped response for M1; never claims to be live JeV."""

    model_version = "mock-jev-0.1"

    async def evaluate(
        self, state: dict[str, Any], questions: list[dict[str, str]]
    ) -> dict[str, Any]:
        quality_ok = state["snapshot"]["quality"]["status"] == "ok"
        signal = state["strategy_signal"]["signal"]
        answers = [
            {
                "question_id": "evidence_sufficiency",
                "answer": "sufficient" if quality_ok else "defer",
                "distribution": {"sufficient": 0.82 if quality_ok else 0.08, "defer": 0.18 if quality_ok else 0.92},
                "confidence": 0.82 if quality_ok else 0.92,
                "reason_code": "fixture_snapshot_quality_ok" if quality_ok else "snapshot_quality_failed",
            },
            {
                "question_id": "signal_alignment",
                "answer": "actionable" if signal in {"BUY", "SELL"} else "mixed",
                "distribution": {"actionable": 0.71 if signal in {"BUY", "SELL"} else 0.24, "mixed": 0.29 if signal in {"BUY", "SELL"} else 0.76},
                "confidence": 0.71 if signal in {"BUY", "SELL"} else 0.76,
                "reason_code": "fixture_strategy_event",
            },
            {
                "question_id": "market_regime_fit",
                "answer": "needs_review",
                "distribution": {"fit": 0.34, "needs_review": 0.52, "poor_fit": 0.14},
                "confidence": 0.52,
                "reason_code": "fixture_requires_domain_validation",
            },
        ]
        return {
            "status": "evaluated" if quality_ok else "deferred",
            "provider": "mock",
            "model_version": self.model_version,
            "question_version": QUESTION_VERSION,
            "answers": answers,
            "overall": "review" if quality_ok else "defer",
            "confidence": round(sum(answer["confidence"] for answer in answers) / len(answers), 4),
            "usage": None,
            "cost": None,
            "latency_ms": 0,
        }


class UnconfiguredJevDecisionProvider:
    model_version = None

    async def evaluate(
        self, state: dict[str, Any], questions: list[dict[str, str]]
    ) -> dict[str, Any]:
        raise ResearchProviderError("jev_not_configured", "Jev 인증이 구성되지 않았습니다.")


class TypeSafeJevDecisionProvider:
    """Official TypeSafe System One HTTP adapter using the JeV model."""

    def __init__(self, api_url: str | None = None, api_key: str | None = None, model: str | None = None, timeout: float = 12.0):
        self.api_url = (api_url or os.getenv("JEV_API_URL") or TYPESAFE_API_URL).strip()
        self.api_key = (api_key or _configured_jev_key()).strip()
        self.model = (model or os.getenv("JEV_MODEL") or "jev-latest").strip()
        self.timeout = timeout
        if not self.api_key:
            raise ResearchProviderError("jev_not_configured", "Jev(TypeSafe) API key가 구성되지 않았습니다.")

    @staticmethod
    def _question_payload() -> dict[str, dict[str, Any]]:
        return {
            "evidence_sufficiency": {
                "type": "choice",
                "instructions": "Is the market snapshot sufficient for an investment research review?",
                "criteria": {
                    "sufficient": "The snapshot has enough complete, chronological OHLCV evidence.",
                    "defer": "The snapshot is missing, stale, future-dated, or has an open bar.",
                },
            },
            "signal_alignment": {
                "type": "choice",
                "instructions": "Does the strategy signal have a coherent action state based on the supplied state?",
                "criteria": {
                    "actionable": "The strategy emitted a BUY or SELL event.",
                    "mixed": "The strategy has no current action event or the evidence is ambiguous.",
                },
            },
            "market_regime_fit": {
                "type": "choice",
                "instructions": "Is the current market context suitable for this signal?",
                "criteria": {
                    "fit": "The supplied indicators support the strategy signal.",
                    "needs_review": "The supplied state is insufficient for a confident regime judgment.",
                    "poor_fit": "The supplied indicators conflict with the strategy signal.",
                },
            },
        }

    @staticmethod
    def _normalize_answer(question_id: str, answer: Any) -> dict[str, Any]:
        if not isinstance(answer, dict):
            raise ResearchProviderError("decision_schema_error", "Jev 응답 answer 형식이 올바르지 않습니다.")
        choice = answer.get("choice") or answer.get("answer")
        if not isinstance(choice, str):
            raise ResearchProviderError("decision_schema_error", "Jev Choice 응답에 choice가 없습니다.")
        confidence = answer.get("confidence")
        probabilities = answer.get("probabilities")
        if not isinstance(confidence, (int, float)) or not math.isfinite(float(confidence)):
            raise ResearchProviderError("decision_schema_error", "Jev Choice 응답에 confidence가 없습니다.")
        return {
            "question_id": question_id,
            "answer": choice,
            "distribution": probabilities if isinstance(probabilities, dict) else {},
            "confidence": float(confidence),
            "reason_code": "typesafe_choice",
        }

    async def evaluate(
        self, state: dict[str, Any], questions: list[dict[str, str]]
    ) -> dict[str, Any]:
        started = time.perf_counter()
        payload = {"state": state, "model": self.model, "questions": self._question_payload()}
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                response = await client.post(
                    self.api_url,
                    headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
                    json=payload,
                )
        except httpx.TimeoutException as exc:
            raise ResearchProviderError("jev_timeout", "Jev 응답 시간이 초과되었습니다.") from exc
        except httpx.HTTPError as exc:
            raise ResearchProviderError("jev_provider_error", "Jev 연결에 실패했습니다.") from exc
        if response.status_code in {401, 403}:
            raise ResearchProviderError("jev_auth_failed", "Jev 인증이 거부되었습니다.")
        if response.status_code == 429:
            raise ResearchProviderError("jev_rate_limited", "Jev 요청 한도에 도달했습니다.")
        if response.status_code >= 500:
            raise ResearchProviderError("jev_provider_error", "Jev provider 서버 오류가 발생했습니다.")
        try:
            response.raise_for_status()
            response_payload = response.json()
        except (httpx.HTTPError, ValueError, json.JSONDecodeError) as exc:
            raise ResearchProviderError("decision_schema_error", "Jev 응답 JSON 형식이 올바르지 않습니다.") from exc
        answers_payload = response_payload.get("answers", response_payload.get("choices")) if isinstance(response_payload, dict) else None
        if not isinstance(answers_payload, dict):
            raise ResearchProviderError("decision_schema_error", "Jev 응답에 answers가 없습니다.")
        answers = [self._normalize_answer(question_id, answers_payload.get(question_id)) for question_id in self._question_payload()]
        return {
            "status": "evaluated",
            "provider": "typesafe",
            "model_version": response_payload.get("model", self.model),
            "question_version": QUESTION_VERSION,
            "answers": answers,
            "overall": "review",
            "confidence": round(sum(answer["confidence"] for answer in answers) / len(answers), 4),
            "usage": response_payload.get("usage") if isinstance(response_payload.get("usage"), dict) else None,
            "cost": None,
            "latency_ms": round((time.perf_counter() - started) * 1000),
        }


def connection_status() -> dict[str, Any]:
    tv_configured = bool(_configured_tradingview_token())
    jev_configured = bool(_configured_jev_key())
    return {
        "mode": RESEARCH_MODE,
        "live_verified": False,
        "fixture_available": True,
        "public_data_available": True,
        "tradingview": {
            "status": "configured_unverified" if tv_configured else "not_configured",
            "configured": tv_configured,
            "auth_owner": "backend",
            "oauth": "OAuth 2.1",
            "server_url": os.getenv("TRADINGVIEW_MCP_URL", TRADINGVIEW_MCP_URL),
        },
        "jev": {
            "status": "configured_unverified" if jev_configured else "not_configured",
            "configured": jev_configured,
            "auth_owner": "backend",
            "api_url": os.getenv("JEV_API_URL", TYPESAFE_API_URL),
            "model": os.getenv("JEV_MODEL", "jev-latest"),
        },
        "public_data": {
            "status": "available",
            "provider": "Yahoo Finance / yfinance",
            "live_verified": False,
        },
        "secrets_exposed": False,
    }


def validate_snapshot(snapshot: MarketSnapshot, now: datetime | None = None) -> list[str]:
    """Validate time and OHLCV invariants without filling missing values."""
    issues: list[str] = []
    current_time = now or _utc_now()
    try:
        observed = datetime.fromisoformat(snapshot.observed_at.replace("Z", "+00:00"))
        if observed > current_time + timedelta(minutes=5):
            issues.append("observed_at_in_future")
    except ValueError:
        issues.append("observed_at_invalid")
    if not snapshot.bar_closed:
        issues.append("bar_not_closed")
    if len(snapshot.bars) < 20:
        issues.append("insufficient_bars")

    previous_date: datetime | None = None
    for bar in snapshot.bars:
        required = ("date", "open", "high", "low", "close", "volume")
        if any(field not in bar or bar[field] is None for field in required):
            issues.append("missing_ohlcv")
            break
        try:
            parsed_date = datetime.fromisoformat(str(bar["date"]).replace("Z", "+00:00"))
            values = {field: float(bar[field]) for field in required[1:]}
        except (TypeError, ValueError):
            issues.append("invalid_ohlcv")
            break
        if previous_date is not None and parsed_date <= previous_date:
            issues.append("bars_not_chronological")
            break
        if not all(math.isfinite(value) for value in values.values()):
            issues.append("non_finite_ohlcv")
            break
        if min(values[field] for field in ("open", "high", "low", "close")) <= 0:
            issues.append("non_positive_price")
            break
        if values["volume"] < 0:
            issues.append("negative_volume")
            break
        if values["high"] < max(values["open"], values["close"]):
            issues.append("high_below_body")
            break
        if values["low"] > min(values["open"], values["close"]):
            issues.append("low_above_body")
            break
        previous_date = parsed_date
    return sorted(set(issues))


def build_strategy_signal(snapshot: MarketSnapshot, strategy: str) -> dict[str, Any]:
    if strategy not in SUPPORTED_STRATEGIES:
        raise ResearchProviderError("unsupported_strategy", "지원하지 않는 전략입니다.")
    bars = [bt.Bar(**bar) for bar in snapshot.bars]
    result = bt.run(bars, 1_000_000, strategy)
    latest_event = result.trades[-1] if result.trades else None
    signal = latest_event["side"] if latest_event else "HOLD"
    return {
        "strategy": strategy,
        "strategy_label": result.strategy_label,
        "signal": signal,
        "signal_basis": "latest_completed_strategy_event",
        "latest_event": latest_event,
        "bars_used": len(bars),
        "backtest_return_pct": result.total_return_pct,
    }


def _questions() -> list[dict[str, str]]:
    return [
        {"id": "evidence_sufficiency", "prompt": "Is the market snapshot sufficient for review?"},
        {"id": "signal_alignment", "prompt": "Does the strategy signal have a coherent action state?"},
        {"id": "market_regime_fit", "prompt": "Is the current market context suitable for this signal?"},
    ]


def _error(code: str, message: str) -> dict[str, str]:
    return {"code": code, "message": message}


class ResearchStore:
    """Separate SQLite store for immutable research runs."""

    def __init__(self, path: str | None = None):
        self.path = path or os.getenv(
            "RESEARCH_DB_PATH",
            str(Path(__file__).resolve().parent / "research.db"),
        )

    async def init(self) -> None:
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        async with aiosqlite.connect(self.path) as db:
            await db.executescript(
                """
                CREATE TABLE IF NOT EXISTS research_runs (
                    run_id TEXT PRIMARY KEY,
                    request_key TEXT UNIQUE,
                    status TEXT NOT NULL,
                    symbol TEXT NOT NULL,
                    exchange TEXT NOT NULL,
                    interval TEXT NOT NULL,
                    source TEXT NOT NULL,
                    strategy TEXT NOT NULL,
                    input_hash TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    snapshot_json TEXT,
                    state_json TEXT,
                    decision_json TEXT,
                    error_json TEXT,
                    result_json TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_research_created_at
                    ON research_runs(created_at DESC);
                """
            )
            await db.commit()

    async def save(self, result: dict[str, Any]) -> None:
        await self.init()
        async with aiosqlite.connect(self.path) as db:
            await db.execute(
                """
                INSERT INTO research_runs
                (run_id, request_key, status, symbol, exchange, interval, source,
                 strategy, input_hash, created_at, snapshot_json, state_json,
                 decision_json, error_json, result_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT DO NOTHING
                """,
                (
                    result["run_id"],
                    result.get("request_key"),
                    result["status"],
                    result["symbol"],
                    result["exchange"],
                    result["interval"],
                    result["source"],
                    result["strategy"],
                    result["input_hash"],
                    result["created_at"],
                    json.dumps(result.get("snapshot"), ensure_ascii=False),
                    json.dumps(result.get("state"), ensure_ascii=False),
                    json.dumps(result.get("decision"), ensure_ascii=False),
                    json.dumps(result.get("error"), ensure_ascii=False),
                    json.dumps(result, ensure_ascii=False),
                ),
            )
            await db.commit()

    async def get_by_request_key(self, request_key: str) -> dict[str, Any] | None:
        await self.init()
        async with aiosqlite.connect(self.path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute(
                "SELECT result_json FROM research_runs WHERE request_key = ?",
                (request_key,),
            )
            row = await cursor.fetchone()
            return json.loads(row["result_json"]) if row else None

    async def get(self, run_id: str) -> dict[str, Any] | None:
        await self.init()
        async with aiosqlite.connect(self.path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute(
                "SELECT result_json FROM research_runs WHERE run_id = ?",
                (run_id,),
            )
            row = await cursor.fetchone()
            return json.loads(row["result_json"]) if row else None

    async def list(self, limit: int = 20) -> list[dict[str, Any]]:
        await self.init()
        bounded_limit = max(1, min(limit, 100))
        async with aiosqlite.connect(self.path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute(
                """
                SELECT run_id, request_key, status, symbol, exchange, interval,
                       source, strategy, created_at, error_json, result_json
                FROM research_runs
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (bounded_limit,),
            )
            rows = await cursor.fetchall()
            summaries = []
            for row in rows:
                result = json.loads(row["result_json"])
                summaries.append(
                    {
                        "run_id": result["run_id"],
                        "request_key": result.get("request_key"),
                        "status": result["status"],
                        "symbol": result["symbol"],
                        "exchange": result["exchange"],
                        "interval": result["interval"],
                        "source": result["source"],
                        "strategy": result["strategy"],
                        "created_at": result["created_at"],
                        "signal": (result.get("state") or {}).get("strategy_signal", {}).get("signal"),
                        "overall": (result.get("decision") or {}).get("overall"),
                        "error": result.get("error"),
                    }
                )
            return summaries


async def run_research(
    request: dict[str, Any],
    store: ResearchStore,
    market_provider: MarketDataProvider | None = None,
    decision_provider: DecisionProvider | None = None,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    """Run one immutable shadow analysis, returning deferred on provider faults."""
    symbol = request["symbol"].strip().upper()
    exchange = request["exchange"].strip().upper()
    interval = request.get("interval", "1D")
    source = request.get("source", "fixture")
    strategy = request.get("strategy", DEFAULT_STRATEGY)
    request_key = request.get("request_key")
    if request_key:
        replay = await store.get_by_request_key(request_key)
        if replay is not None:
            replay["replayed"] = True
            return replay

    provider = market_provider or (FixtureMarketDataProvider() if source == "fixture" else UnconfiguredTradingViewProvider())
    decision = decision_provider or MockJevDecisionProvider()
    created_at = _iso(_utc_now())
    started = time.perf_counter()
    snapshot: MarketSnapshot | None = None
    state: dict[str, Any] | None = None
    decision_result: dict[str, Any] | None = None
    error: dict[str, str] | None = None
    status = "evaluated"

    try:
        snapshot = await provider.snapshot(symbol, exchange, interval)
        quality_issues = validate_snapshot(snapshot)
        if quality_issues:
            status = "deferred"
            error = _error("data_quality", ", ".join(quality_issues))
        else:
            signal = build_strategy_signal(snapshot, strategy)
            state = {
                "snapshot": snapshot.to_dict(),
                "strategy_signal": signal,
                "policy_version": RESEARCH_POLICY_VERSION,
            }
            decision_result = await asyncio.wait_for(
                decision.evaluate(state, _questions()), timeout=timeout_seconds
            )
            if (
                not isinstance(decision_result, dict)
                or decision_result.get("status") not in {"evaluated", "deferred"}
                or not isinstance(decision_result.get("answers"), list)
            ):
                raise ResearchProviderError(
                    "decision_schema_error",
                    "판단 provider 응답 형식이 올바르지 않습니다.",
                )
            if decision_result.get("status") != "evaluated":
                status = "deferred"
    except asyncio.TimeoutError:
        status = "deferred"
        error = _error("timeout", "판단 provider 응답 시간이 초과되었습니다.")
    except ResearchProviderError as exc:
        status = "deferred"
        error = _error(exc.code, str(exc))
    except (KeyError, TypeError, ValueError) as exc:
        status = "deferred"
        error = _error("schema_error", f"연구 입력 또는 응답 형식이 올바르지 않습니다: {type(exc).__name__}")
    except Exception:
        status = "error"
        error = _error("provider_error", "연구 provider 처리에 실패했습니다.")

    snapshot_dict = snapshot.to_dict() if snapshot else None
    input_hash = _hash_json(
        {
            "symbol": symbol,
            "exchange": exchange,
            "interval": interval,
            "strategy": strategy,
            "snapshot": snapshot_dict,
            "question_version": QUESTION_VERSION,
        }
    )
    result = {
        "run_id": str(uuid.uuid4()),
        "request_key": request_key,
        "status": status,
        "mode": RESEARCH_MODE,
        "execution_mode": "paper",
        "live_allowed": False,
        "live_verified": False,
        "symbol": symbol,
        "exchange": exchange,
        "interval": interval,
        "source": source,
        "strategy": strategy,
        "strategy_version": "backtest-engine-existing",
        "question_version": QUESTION_VERSION,
        "policy_version": RESEARCH_POLICY_VERSION,
        "input_hash": input_hash,
        "created_at": created_at,
        "latency_ms": round((time.perf_counter() - started) * 1000),
        "snapshot": snapshot_dict,
        "state": state,
        "decision": decision_result,
        "error": error,
        "replayed": False,
    }
    await store.save(result)
    if request_key:
        persisted = await store.get_by_request_key(request_key)
        if persisted is not None and persisted["run_id"] != result["run_id"]:
            persisted["replayed"] = True
            return persisted
    return result
