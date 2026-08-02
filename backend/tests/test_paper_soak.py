from __future__ import annotations

import logging
import math
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import trading_bot  # noqa: E402
from trading_safety import (  # noqa: E402
    MAX_RESERVED_ORDER_KEYS,
    SafetyController,
    SafetyViolation,
)


def _bounded_env(name: str, default: int, minimum: int, maximum: int) -> int:
    value = int(os.getenv(name, str(default)))
    if not minimum <= value <= maximum:
        raise RuntimeError(f"{name} must be between {minimum} and {maximum}")
    return value


SOAK_CYCLES = _bounded_env(
    "PAPER_SOAK_CYCLES",
    600,
    MAX_RESERVED_ORDER_KEYS // 2 + 1,
    10_000,
)
FAULT_CYCLES = _bounded_env("PAPER_SOAK_FAULT_CYCLES", 50, 1, 1_000)
KILL_CYCLES = _bounded_env("PAPER_SOAK_KILL_CYCLES", 100, 1, 1_000)
RESTART_INTERVAL = 100


class PaperTradingSoakTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        runtime = Path(self.temp_dir.name)
        self.db_path = runtime / "paper-soak.db"
        self.state_path = runtime / "paper-safety.json"

        self.bot = trading_bot
        self.original_safety = self.bot._safety
        self.original_status = self.bot._status
        self.original_db_path = self.bot.db.DB_PATH
        self.original_chart_cache = self.bot._chart_cache.copy()
        self.original_price_cache = self.bot._price_cache.copy()
        self.original_log_level = self.bot.logger.level

        self.bot.db.DB_PATH = str(self.db_path)
        self.bot._safety = SafetyController(self.state_path)
        self.bot._status = self._fresh_status()
        self.bot._chart_cache.clear()
        self.bot._price_cache.clear()
        self.bot.logger.setLevel(logging.CRITICAL)
        await self.bot.db.init_db()

        self.session_id = "paper-soak-session-0"
        self.bot._safety.start_session(self.session_id)

    async def asyncTearDown(self) -> None:
        self.bot._safety = self.original_safety
        self.bot._status = self.original_status
        self.bot.db.DB_PATH = self.original_db_path
        self.bot._chart_cache.clear()
        self.bot._chart_cache.update(self.original_chart_cache)
        self.bot._price_cache.clear()
        self.bot._price_cache.update(self.original_price_cache)
        self.bot.logger.setLevel(self.original_log_level)
        self.temp_dir.cleanup()

    def _fresh_status(self) -> trading_bot.BotStatus:
        return self.bot.BotStatus(
            mode="paper",
            strategy="dual_mom",
            symbols=["BTC"],
            initial_capital=1_000_000,
            current_capital=1_000_000,
            equity_capital=1_000_000,
            peak_capital=1_000_000,
            daily_start_cap=1_000_000,
        )

    async def test_order_replay_and_unclean_restart_soak(self) -> None:
        status = self._fresh_status()
        first_buy_key = "soak:0:BTC:BUY"
        reconnects = 0

        with patch.object(self.bot.notifier, "notify_trade", new=AsyncMock()):
            for cycle in range(SOAK_CYCLES):
                buy_key = f"soak:{cycle}:BTC:BUY"
                sell_key = f"soak:{cycle}:BTC:SELL"
                buy_price = 50_000 + cycle % 17
                sell_price = buy_price + 100

                bought = await self.bot.execute_order(
                    "BTC", self.bot.Signal.BUY, buy_price, status, buy_key
                )
                self.assertIsNotNone(bought)

                duplicate_status = self._fresh_status()
                duplicate = await self.bot.execute_order(
                    "BTC", self.bot.Signal.BUY, buy_price, duplicate_status, buy_key
                )
                self.assertIsNone(duplicate)
                self.assertEqual(duplicate_status.trade_count, 0)
                self.assertEqual(duplicate_status.current_capital, 1_000_000)

                sold = await self.bot.execute_order(
                    "BTC", self.bot.Signal.SELL, sell_price, status, sell_key
                )
                self.assertIsNotNone(sold)
                self.assertNotIn("BTC", status.positions)

                if (cycle + 1) % RESTART_INTERVAL == 0:
                    reconnects += 1
                    restarted = SafetyController(self.state_path)
                    next_session = f"paper-soak-session-{reconnects}"
                    with self.assertRaisesRegex(SafetyViolation, "상태 대사"):
                        restarted.start_session(next_session)

                    self.bot._safety = restarted
                    blocked_status = self._fresh_status()
                    with self.assertRaises(SafetyViolation):
                        await self.bot.execute_order(
                            "BTC",
                            self.bot.Signal.BUY,
                            50_000,
                            blocked_status,
                            f"blocked:{cycle}",
                        )
                    self.assertEqual(blocked_status.trade_count, 0)
                    self.assertEqual(blocked_status.current_capital, 1_000_000)

                    restarted.acknowledge_reconciliation("RECONCILE_PAPER_STATE")
                    restarted.start_session(next_session)
                    self.session_id = next_session

            # More than 1,000 reservations evicts the oldest JSON cache entry.
            # The durable trade ledger must still reject the historical replay.
            historical_replay = self._fresh_status()
            replay = await self.bot.execute_order(
                "BTC", self.bot.Signal.BUY, 50_000, historical_replay, first_buy_key
            )
            self.assertIsNone(replay)
            self.assertEqual(historical_replay.trade_count, 0)
            self.assertEqual(historical_replay.current_capital, 1_000_000)

        trades = await self.bot.db.load_trades(SOAK_CYCLES * 2 + 10)
        self.assertEqual(len(trades), SOAK_CYCLES * 2)
        self.assertEqual(len({trade["id"] for trade in trades}), len(trades))
        self.bot._safety.end_session(self.session_id)

        print(
            "SOAK_EVIDENCE "
            f"order_cycles={SOAK_CYCLES} committed_trades={len(trades)} "
            f"duplicate_replays={SOAK_CYCLES + 1} reconnects={reconnects}"
        )

    async def test_market_data_faults_never_mutate_the_ledger(self) -> None:
        reserved_before = list(self.bot._safety.state.reserved_order_keys)

        async def finish_cycle(delay: float) -> None:
            if delay >= 60:
                self.bot._status.running = False

        notifier_patches = (
            patch.object(self.bot.notifier, "notify_trade", new=AsyncMock()),
            patch.object(self.bot.notifier, "send", new=AsyncMock()),
            patch.object(self.bot.notifier, "notify_circuit_breaker", new=AsyncMock()),
            patch.object(self.bot.notifier, "notify_daily_report", new=AsyncMock()),
        )

        for fault_cycle in range(FAULT_CYCLES):
            status = self._fresh_status()
            self.bot._status = status

            if fault_cycle % 2 == 0:
                price = AsyncMock(
                    side_effect=httpx.ConnectError(
                        "simulated market-data disconnect",
                        request=httpx.Request("GET", "https://example.invalid/price"),
                    )
                )
                signal = AsyncMock(return_value=(self.bot.Signal.BUY, {}))
            else:
                price = AsyncMock(return_value={"current_price": math.nan})
                signal = AsyncMock(return_value=(self.bot.Signal.BUY, {}))

            with (
                patch.object(self.bot, "_cached_price", new=price),
                patch.object(self.bot, "generate_signal", new=signal),
                patch.object(self.bot.asyncio, "sleep", side_effect=finish_cycle),
                notifier_patches[0],
                notifier_patches[1],
                notifier_patches[2],
                notifier_patches[3],
            ):
                await self.bot._bot_loop()

            self.assertFalse(status.running)
            self.assertEqual(status.trade_count, 0)
            self.assertEqual(status.current_capital, 1_000_000)
            self.assertEqual(status.positions, {})
            self.assertEqual(status.last_signal["BTC"]["signal"], "ERROR")

        self.assertEqual(
            self.bot._safety.state.reserved_order_keys,
            reserved_before,
        )
        trades = await self.bot.db.load_trades(10)
        self.assertEqual(trades, [])

        print(
            "SOAK_EVIDENCE "
            f"market_fault_cycles={FAULT_CYCLES} committed_trades=0"
        )

    async def test_ledger_failure_requires_reconciliation_before_retry(self) -> None:
        status = self._fresh_status()
        with (
            patch.object(
                self.bot.db,
                "save_trade",
                new=AsyncMock(side_effect=OSError("simulated ledger outage")),
            ),
            patch.object(self.bot.notifier, "notify_trade", new=AsyncMock()),
        ):
            with self.assertRaisesRegex(SafetyViolation, "상태 대사"):
                await self.bot.execute_order(
                    "BTC", self.bot.Signal.BUY, 50_000, status, "ledger:failed:BUY"
                )

        self.assertEqual(status.trade_count, 0)
        self.assertEqual(status.current_capital, 1_000_000)
        self.assertEqual(status.positions, {})
        self.assertTrue(self.bot._safety.state.reconciliation_required)

        restarted = SafetyController(self.state_path)
        self.assertTrue(restarted.state.reconciliation_required)
        with self.assertRaises(SafetyViolation):
            restarted.assert_can_trade()

        self.bot._safety = restarted
        retry_status = self._fresh_status()
        with self.assertRaises(SafetyViolation):
            await self.bot.execute_order(
                "BTC", self.bot.Signal.BUY, 50_000, retry_status, "ledger:retry:BUY"
            )
        self.assertEqual(retry_status.trade_count, 0)

        print("SOAK_EVIDENCE ledger_failures=1 retries_blocked=1")

    async def test_loss_limits_and_kill_switch_persist_under_repetition(self) -> None:
        controller = self.bot._safety
        blocked_attempts = 0

        for cycle in range(KILL_CYCLES):
            controller.trigger_kill_switch(f"simulated kill cycle {cycle}")
            controller = SafetyController(self.state_path)
            with self.assertRaises(SafetyViolation):
                controller.assert_can_trade()
            blocked_attempts += 1
            controller.reset_kill_switch("RESET_PAPER_KILL_SWITCH")
            controller.assert_can_trade()

        controller.evaluate_capital(97_999, 100_000, 100_000)
        daily_restart = SafetyController(self.state_path)
        with self.assertRaisesRegex(SafetyViolation, "일일 손실"):
            daily_restart.assert_can_trade()
        blocked_attempts += 1

        # Use a separate state file so the persistent daily halt cannot mask
        # the drawdown kill-switch assertion.
        drawdown_path = Path(self.temp_dir.name) / "drawdown-safety.json"
        drawdown = SafetyController(drawdown_path)
        drawdown.start_session("drawdown-session")
        drawdown.evaluate_capital(89_999, 100_000, 100_000)
        drawdown_restart = SafetyController(drawdown_path)
        with self.assertRaisesRegex(SafetyViolation, "최대 낙폭"):
            drawdown_restart.assert_can_trade()
        blocked_attempts += 1

        print(
            "SOAK_EVIDENCE "
            f"kill_cycles={KILL_CYCLES} loss_limit_checks=2 "
            f"blocked_attempts={blocked_attempts}"
        )


if __name__ == "__main__":
    unittest.main()
