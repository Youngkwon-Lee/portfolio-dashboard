from __future__ import annotations

import json as jsonlib
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import research_workflow as research  # noqa: E402


class FakeResponse:
    def __init__(self, payload, status_code=200, headers=None):
        self._payload = payload
        self.status_code = status_code
        self.headers = headers or {"content-type": "application/json"}
        self.text = jsonlib.dumps(payload)

    def json(self):
        return self._payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class FakeMcpClient:
    calls: list[dict] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return None

    def __init__(self, *args, **kwargs):
        self.__class__.calls = []

    async def post(self, url, headers, json):
        self.__class__.calls.append({"url": url, "headers": headers, "json": json})
        method = json.get("method")
        if method == "initialize":
            return FakeResponse(
                {"jsonrpc": "2.0", "id": 1, "result": {"protocolVersion": "2025-03-26"}},
                headers={"content-type": "application/json", "mcp-session-id": "fixture-session"},
            )
        if method == "notifications/initialized":
            return FakeResponse({}, status_code=202)
        tool_name = json["params"]["name"]
        if tool_name == "search_symbols":
            data = {"symbols": [{"symbol": "NASDAQ:AAPL", "description": "Apple Inc.", "exchange": "NASDAQ"}]}
        else:
            data = {
                "bars": [
                    {"t": 1_725_067_200 + index * 86_400, "o": 100 + index, "h": 102 + index, "l": 99 + index, "c": 101 + index, "v": 1000 + index}
                    for index in range(21)
                ],
                "bar_closed": True,
            }
        return FakeResponse(
            {
                "jsonrpc": "2.0",
                "id": 2,
                "result": {"content": [{"type": "text", "text": jsonlib.dumps(data)}]},
            }
        )


class FakeJevClient:
    last_payload: dict | None = None

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return None

    def __init__(self, *args, **kwargs):
        return None

    async def post(self, url, headers, json):
        self.__class__.last_payload = json
        return FakeResponse(
            {
                "model": "jev-1.13.0",
                "answers": {
                    question_id: {
                        "type": "choice",
                        "choice": "sufficient" if question_id == "evidence_sufficiency" else "needs_review",
                        "confidence": 0.8,
                        "probabilities": {"sufficient": 0.8, "defer": 0.2},
                    }
                    for question_id in ("evidence_sufficiency", "signal_alignment", "market_regime_fit")
                },
                "usage": {"input_tokens": 10, "output_tokens": 5},
            }
        )


class ResearchProviderTests(unittest.IsolatedAsyncioTestCase):
    async def test_public_yahoo_provider_reuses_existing_yfinance_contract(self):
        bars = [
            {"date": f"2026-08-{index:02d}", "open": 100 + index, "high": 102 + index, "low": 99 + index, "close": 101 + index, "volume": 1000 + index}
            for index in range(1, 22)
        ]
        with patch.object(research.public_market, "get_us_chart", new=AsyncMock(return_value=bars)) as provider_call:
            provider = research.PublicYahooMarketDataProvider()
            snapshot = await provider.snapshot("AAPL", "NASDAQ", "1D")

        provider_call.assert_awaited_once_with("AAPL", "3M")
        self.assertEqual(snapshot.source, "yahoo_public")
        self.assertTrue(snapshot.bar_closed)
        self.assertEqual(snapshot.quality["provider_mode"], "yahoo_public")

    async def test_public_yahoo_provider_lists_and_maps_crypto_symbols(self):
        provider = research.PublicYahooMarketDataProvider()
        instruments = await provider.search("ETH")
        self.assertEqual(instruments[0]["symbol"], "ETH-USD")

        with patch.object(research.public_market, "get_us_chart", new=AsyncMock(return_value=[
            {"date": f"2026-08-{index:02d}", "open": 100 + index, "high": 102 + index, "low": 99 + index, "close": 101 + index, "volume": 1000 + index}
            for index in range(1, 22)
        ])) as provider_call:
            await provider.snapshot("ETH", "CRYPTO", "1D")

        provider_call.assert_awaited_once_with("ETH-USD", "3M")

    async def test_tradingview_adapter_uses_read_only_mcp_tools_and_normalizes_bars(self):
        with patch.object(research.httpx, "AsyncClient", FakeMcpClient):
            provider = research.TradingViewMcpProvider(url="https://example.test/mcp", access_token="test-token")
            instruments = await provider.search("Apple")
            snapshot = await provider.snapshot("AAPL", "NASDAQ", "1D")

        self.assertEqual(instruments[0]["symbol"], "AAPL")
        self.assertEqual(snapshot.source, "tradingview_mcp")
        self.assertTrue(snapshot.bar_closed)
        self.assertEqual(len(snapshot.bars), 21)
        self.assertEqual(research.validate_snapshot(snapshot), [])
        self.assertEqual(FakeMcpClient.calls[0]["json"]["method"], "initialize")
        self.assertEqual(FakeMcpClient.calls[-1]["json"]["params"]["name"], "get_ohlcv")

    async def test_typesafe_adapter_sends_typed_questions_and_normalizes_choice_answers(self):
        with patch.object(research.httpx, "AsyncClient", FakeJevClient):
            provider = research.TypeSafeJevDecisionProvider(api_key="test-key")
            result = await provider.evaluate({"snapshot": {}, "strategy_signal": {}}, [])

        self.assertEqual(result["provider"], "typesafe")
        self.assertEqual(result["model_version"], "jev-1.13.0")
        self.assertEqual(len(result["answers"]), 3)
        self.assertEqual(FakeJevClient.last_payload["model"], "jev-latest")
        self.assertEqual(FakeJevClient.last_payload["questions"]["signal_alignment"]["type"], "choice")


if __name__ == "__main__":
    unittest.main()
