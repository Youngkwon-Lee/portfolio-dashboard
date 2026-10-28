from __future__ import annotations

import asyncio
import sys
import tempfile
import unittest
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from research_workflow import (
    FixtureMarketDataProvider,
    MarketSnapshot,
    MockJevDecisionProvider,
    ResearchStore,
    build_strategy_signal,
    run_research,
    validate_snapshot,
)


class SlowDecisionProvider:
    async def evaluate(self, state, questions):
        await asyncio.sleep(0.05)
        return {"status": "evaluated", "answers": []}


class InvalidDecisionProvider:
    async def evaluate(self, state, questions):
        return {"status": "evaluated", "answers": "not-a-list"}


class ResearchWorkflowTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.runtime = tempfile.TemporaryDirectory()
        self.store = ResearchStore(str(Path(self.runtime.name) / "research.db"))
        self.provider = FixtureMarketDataProvider()

    async def asyncTearDown(self) -> None:
        self.runtime.cleanup()

    async def _run(self, **overrides):
        request = {
            "symbol": "005930",
            "exchange": "KRX",
            "interval": "1D",
            "source": "fixture",
            "strategy": "sma_cross",
            "request_key": None,
            **overrides,
        }
        return await run_research(
            request,
            store=self.store,
            market_provider=self.provider,
            decision_provider=MockJevDecisionProvider(),
        )

    async def test_fixture_to_decision_to_store_and_replay(self) -> None:
        first = await self._run(request_key="research:005930:1")
        replay = await self._run(request_key="research:005930:1")

        self.assertEqual(first["status"], "evaluated")
        self.assertEqual(first["source"], "fixture")
        self.assertEqual(first["snapshot"]["quality"]["status"], "ok")
        self.assertEqual(first["decision"]["provider"], "mock")
        self.assertEqual(first["run_id"], replay["run_id"])
        self.assertTrue(replay["replayed"])
        self.assertEqual(len(await self.store.list()), 1)

    async def test_future_and_open_bar_are_deferred(self) -> None:
        snapshot = await self.provider.snapshot("005930", "KRX", "1D")
        future_snapshot = replace(
            snapshot,
            observed_at=(datetime.now(timezone.utc) + timedelta(days=1)).isoformat(),
        )
        self.assertIn("observed_at_in_future", validate_snapshot(future_snapshot))
        self.assertIn("bar_not_closed", validate_snapshot(replace(snapshot, bar_closed=False)))

    async def test_missing_ohlcv_is_not_replaced_with_zero(self) -> None:
        snapshot = await self.provider.snapshot("005930", "KRX", "1D")
        bars = [dict(bar) for bar in snapshot.bars]
        bars[-1]["close"] = None
        invalid = replace(snapshot, bars=bars)
        self.assertIn("missing_ohlcv", validate_snapshot(invalid))

    async def test_timeout_is_deferred(self) -> None:
        result = await run_research(
            {
                "symbol": "005930",
                "exchange": "KRX",
                "interval": "1D",
                "source": "fixture",
                "strategy": "sma_cross",
            },
            store=self.store,
            market_provider=self.provider,
            decision_provider=SlowDecisionProvider(),
            timeout_seconds=0.001,
        )
        self.assertEqual(result["status"], "deferred")
        self.assertEqual(result["error"]["code"], "timeout")

    async def test_invalid_decision_response_is_deferred_without_fallback(self) -> None:
        result = await run_research(
            {
                "symbol": "005930",
                "exchange": "KRX",
                "interval": "1D",
                "source": "fixture",
                "strategy": "sma_cross",
            },
            store=self.store,
            market_provider=self.provider,
            decision_provider=InvalidDecisionProvider(),
        )
        self.assertEqual(result["status"], "deferred")
        self.assertEqual(result["error"]["code"], "decision_schema_error")

    async def test_strategy_reuses_existing_backtest_dispatcher(self) -> None:
        snapshot = await self.provider.snapshot("AAPL", "NASDAQ", "1D")
        signal = build_strategy_signal(snapshot, "rsi")
        self.assertEqual(signal["strategy"], "rsi")
        self.assertEqual(signal["bars_used"], 60)


if __name__ == "__main__":
    unittest.main()
