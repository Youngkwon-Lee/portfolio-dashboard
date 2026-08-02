from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import us_client  # noqa: E402


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


if __name__ == "__main__":
    unittest.main()
