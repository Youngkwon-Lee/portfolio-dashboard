from __future__ import annotations

import asyncio
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from trading_safety import (  # noqa: E402
    LiveTradingBlocked,
    SafetyController,
    SafetyViolation,
)


class SafetyControllerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.state_path = Path(self.temp_dir.name) / "safety.json"

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def controller(self, now=None) -> SafetyController:
        return SafetyController(self.state_path, now=now)

    def test_paper_is_default_and_live_is_fail_closed(self) -> None:
        controller = self.controller()
        contract = controller.contract()
        self.assertEqual(contract["execution_mode"], "paper")
        self.assertFalse(contract["live_allowed"])
        self.assertFalse(contract["credential_input_allowed"])
        with self.assertRaises(LiveTradingBlocked):
            controller.start_session("live-session", mode="live")

    def test_duplicate_order_key_is_persisted_and_rejected(self) -> None:
        controller = self.controller()
        controller.start_session("paper-session")
        self.assertTrue(controller.reserve_order("BTC:2026-07-30T12:00Z:BUY"))
        self.assertFalse(controller.reserve_order("BTC:2026-07-30T12:00Z:BUY"))

        restarted = self.controller()
        self.assertFalse(restarted.reserve_order("BTC:2026-07-30T12:00Z:BUY"))

    def test_unclean_reconnect_requires_explicit_reconciliation(self) -> None:
        self.controller().start_session("session-before-crash")

        restarted = self.controller()
        with self.assertRaisesRegex(SafetyViolation, "상태 대사"):
            restarted.start_session("session-after-crash")

        persisted = self.controller()
        self.assertTrue(persisted.state.reconciliation_required)
        with self.assertRaises(SafetyViolation):
            persisted.acknowledge_reconciliation("wrong")
        persisted.acknowledge_reconciliation("RECONCILE_PAPER_STATE")
        persisted.start_session("session-after-reconciliation")

    def test_daily_loss_halt_persists_until_next_utc_day(self) -> None:
        clock = [datetime(2026, 7, 30, 12, tzinfo=timezone.utc)]
        controller = self.controller(now=lambda: clock[0])
        controller.start_session("paper-session")
        controller.evaluate_capital(97_999, 100_000, 100_000)
        self.assertTrue(controller.state.daily_halt)

        restarted = self.controller(now=lambda: clock[0])
        with self.assertRaisesRegex(SafetyViolation, "일일 손실"):
            restarted.reserve_order("ETH:blocked")

        clock[0] += timedelta(days=1)
        restarted.assert_can_trade()
        self.assertFalse(restarted.state.daily_halt)

    def test_drawdown_and_manual_kill_switch_persist(self) -> None:
        controller = self.controller()
        controller.start_session("paper-session")
        controller.evaluate_capital(89_999, 100_000, 100_000)
        self.assertTrue(controller.state.kill_switch)

        restarted = self.controller()
        with self.assertRaisesRegex(SafetyViolation, "최대 낙폭"):
            restarted.assert_can_trade()
        with self.assertRaises(SafetyViolation):
            restarted.reset_kill_switch("wrong")
        restarted.reset_kill_switch("RESET_PAPER_KILL_SWITCH")
        restarted.assert_can_trade()

    def test_corrupt_state_fails_closed(self) -> None:
        self.state_path.write_text("{not-json", encoding="utf-8")
        controller = self.controller()
        self.assertTrue(controller.state.kill_switch)
        self.assertTrue(controller.state.reconciliation_required)
        with self.assertRaises(SafetyViolation):
            controller.assert_can_trade()


class TradingBotIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.state_path = Path(self.temp_dir.name) / "safety.json"
        self.db_path = Path(self.temp_dir.name) / "paper.db"
        os.environ["PORTFOLIO_DB_PATH"] = str(self.db_path)
        os.environ["TRADING_SAFETY_STATE_PATH"] = str(self.state_path)

        import trading_bot

        self.bot = trading_bot
        self.original_safety = trading_bot._safety
        trading_bot._safety = SafetyController(self.state_path)
        trading_bot._safety.start_session("integration-session")

    async def asyncTearDown(self) -> None:
        self.bot._safety = self.original_safety
        self.temp_dir.cleanup()

    async def test_execute_order_deduplicates_before_second_mutation(self) -> None:
        status = self.bot.BotStatus(
            mode="paper",
            initial_capital=1_000_000,
            current_capital=1_000_000,
            equity_capital=1_000_000,
            peak_capital=1_000_000,
            daily_start_cap=1_000_000,
        )
        with (
            patch.object(self.bot.db, "save_trade", new=AsyncMock()),
            patch.object(self.bot.notifier, "notify_trade", new=AsyncMock()),
        ):
            first = await self.bot.execute_order(
                "BTC", self.bot.Signal.BUY, 50_000, status, "cycle:BTC:BUY"
            )
            replayed_status = self.bot.BotStatus(
                mode="paper",
                initial_capital=1_000_000,
                current_capital=1_000_000,
                equity_capital=1_000_000,
                peak_capital=1_000_000,
                daily_start_cap=1_000_000,
            )
            second = await self.bot.execute_order(
                "BTC", self.bot.Signal.BUY, 50_000, replayed_status, "cycle:BTC:BUY"
            )

        self.assertIsNotNone(first)
        self.assertIsNone(second)
        self.assertEqual(replayed_status.current_capital, 1_000_000)
        self.assertEqual(replayed_status.trade_count, 0)
        self.assertEqual(status.trade_count, 1)

    async def test_live_mode_never_reaches_paper_mutation(self) -> None:
        status = self.bot.BotStatus(mode="live")
        with self.assertRaises(LiveTradingBlocked):
            await self.bot.execute_order(
                "BTC", self.bot.Signal.BUY, 50_000, status, "cycle:BTC:BUY"
            )

    async def test_unknown_strategy_is_rejected_instead_of_falling_back_to_buy(self) -> None:
        with self.assertRaisesRegex(SafetyViolation, "허용되지 않은"):
            self.bot.configure("paper", "typo-means-buy", ["BTC"], 1_000_000)


if __name__ == "__main__":
    unittest.main()
