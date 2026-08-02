from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import us_client  # noqa: E402
import kis_client  # noqa: E402


class UsChartCacheTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        us_client._chart_cache.clear()

    async def test_reuses_recent_chart_without_second_provider_call(self) -> None:
        candles = [{"date": "2026-08-01", "open": 1, "high": 2, "low": 1, "close": 2, "volume": 10}]
        with patch.object(us_client, "_yf_chart_sync", return_value=candles) as provider:
            first = await us_client.get_us_chart("aapl", "1M")
            second = await us_client.get_us_chart("AAPL", "1M")

        self.assertEqual(first, candles)
        self.assertEqual(second, candles)
        self.assertIsNot(first, second)
        provider.assert_called_once_with("aapl", "1M")

    async def test_provider_failure_is_not_cached(self) -> None:
        with patch.object(
            us_client,
            "_yf_chart_sync",
            side_effect=[RuntimeError("rate limited"), [{"date": "2026-08-01"}]],
        ) as provider:
            with self.assertRaisesRegex(RuntimeError, "rate limited"):
                await us_client.get_us_chart("AAPL", "1M")
            result = await us_client.get_us_chart("AAPL", "1M")

        self.assertEqual(result, [{"date": "2026-08-01"}])
        self.assertEqual(provider.call_count, 2)

    async def test_binance_chart_cache_avoids_duplicate_public_request(self) -> None:
        us_client._crypto_chart_cache.clear()

        class FakeResponse:
            def raise_for_status(self) -> None:
                return None

            def json(self) -> list[list[object]]:
                return [[1722470400000, "1", "2", "1", "2", "10"]]

        class FakeClient:
            def __init__(self) -> None:
                self.calls = 0

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return None

            async def get(self, *args, **kwargs):
                self.calls += 1
                return FakeResponse()

        client = FakeClient()
        with patch.object(us_client.httpx, "AsyncClient", return_value=client):
            first = await us_client.get_crypto_chart_binance("BTC", "1M")
            second = await us_client.get_crypto_chart_binance("btc", "1M")

        self.assertEqual(first, second)
        self.assertIsNot(first, second)
        self.assertEqual(client.calls, 1)


class KisChartCacheTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        kis_client._daily_chart_cache.clear()

    async def test_daily_chart_cache_avoids_duplicate_authenticated_read(self) -> None:
        response = {
            "output2": [
                {
                    "stck_bsop_date": "20260801",
                    "stck_oprc": "100",
                    "stck_hgpr": "110",
                    "stck_lwpr": "90",
                    "stck_clpr": "105",
                    "acml_vol": "1000",
                }
            ]
        }
        with patch.object(kis_client, "_get", new=AsyncMock(return_value=response)) as provider:
            first = await kis_client.get_daily_chart("005930", "20260701", "20260801")
            second = await kis_client.get_daily_chart("005930", "20260701", "20260801")

        self.assertEqual(first, second)
        self.assertIsNot(first, second)
        provider.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
