from __future__ import annotations

import os
import sys
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest.mock import AsyncMock, patch


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

TEST_RUNTIME = tempfile.TemporaryDirectory()
os.environ["PORTFOLIO_DB_PATH"] = str(Path(TEST_RUNTIME.name) / "api-test.db")
os.environ["TRADING_SAFETY_STATE_PATH"] = str(
    Path(TEST_RUNTIME.name) / "api-safety.json"
)

from fastapi.testclient import TestClient  # noqa: E402
import main  # noqa: E402


class ApiSafetyContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.client_context = TestClient(main.app)
        cls.client = cls.client_context.__enter__()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.client_context.__exit__(None, None, None)
        TEST_RUNTIME.cleanup()

    def test_health_and_safety_contract_are_paper_only(self) -> None:
        health = self.client.get("/health")
        self.assertEqual(health.status_code, 200)
        self.assertEqual(health.json()["execution_mode"], "paper")
        self.assertFalse(health.json()["live_allowed"])

        safety = self.client.get("/api/trading/safety")
        self.assertEqual(safety.status_code, 200)
        self.assertEqual(safety.json()["execution_mode"], "paper")
        self.assertFalse(safety.json()["credential_input_allowed"])

    def test_kis_order_endpoint_blocks_before_client_call(self) -> None:
        with patch.object(main.kis, "place_order", new=AsyncMock()) as downstream:
            response = self.client.post(
                "/api/order",
                json={"ticker": "005930", "side": "buy", "qty": 1, "price": 0},
            )
        self.assertEqual(response.status_code, 403)
        downstream.assert_not_awaited()

    def test_live_bot_start_blocks_before_configuration(self) -> None:
        with (
            patch.object(main.bot, "configure") as configure,
            patch.object(main.bot, "start", new=AsyncMock()) as start,
        ):
            response = self.client.post(
                "/api/bot/start",
                json={
                    "mode": "live",
                    "strategy": "dual_mom",
                    "symbols": ["BTC"],
                    "initial_capital": 1_000_000,
                },
            )
        self.assertEqual(response.status_code, 403)
        configure.assert_not_called()
        start.assert_not_awaited()

    def test_legacy_credentials_are_rejected_without_echo(self) -> None:
        marker = "dummy-secret-that-must-not-echo"
        response = self.client.post(
            "/api/bot/start",
            json={
                "mode": "paper",
                "strategy": "dual_mom",
                "symbols": ["BTC"],
                "initial_capital": 1_000_000,
                "binance_api_key": marker,
                "binance_api_secret": marker,
            },
        )
        self.assertEqual(response.status_code, 422)
        self.assertNotIn(marker, response.text)

    def test_authenticated_account_endpoints_are_blocked(self) -> None:
        with (
            patch.object(main.kis, "get_balance", new=AsyncMock()) as kis_balance,
            patch.object(main.upbit, "get_balance", new=AsyncMock()) as upbit_balance,
            patch.object(main.wallet, "get_binance_balance", new=AsyncMock()) as binance,
        ):
            responses = [
                self.client.get("/api/balance"),
                self.client.get("/api/upbit/balance"),
                self.client.get("/api/wallet/binance"),
                self.client.post("/api/wallet/binance", json={"api_key": "x", "api_secret": "y"}),
            ]
        self.assertTrue(all(response.status_code == 403 for response in responses))
        kis_balance.assert_not_awaited()
        upbit_balance.assert_not_awaited()
        binance.assert_not_awaited()

    def test_backtest_rejects_invalid_inputs_before_market_data_lookup(self) -> None:
        invalid_payloads = [
            {"ticker": "BTC", "initial": 0},
            {"ticker": "BTC", "period": "5Y"},
            {"ticker": "BTC", "strategy": "not_real"},
            {"ticker": "BTC USD"},
            {"ticker": "BTC", "commission_bps": -1},
            {"ticker": "BTC", "slippage_bps": 501},
        ]
        with patch.object(main, "get_chart", new=AsyncMock()) as get_chart:
            for payload in invalid_payloads:
                with self.subTest(payload=payload):
                    response = self.client.post("/api/backtest", json=payload)
                    self.assertEqual(response.status_code, 422)
        get_chart.assert_not_awaited()

    def test_backtest_provider_failure_is_sanitized_as_502(self) -> None:
        with patch.object(
            main,
            "get_chart",
            new=AsyncMock(side_effect=RuntimeError("provider secret must not echo")),
        ) as get_chart:
            response = self.client.post("/api/backtest", json={"ticker": "BTC"})

        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json(), {"detail": "가격 데이터 조회 실패"})
        self.assertNotIn("provider secret must not echo", response.text)
        get_chart.assert_awaited_once_with("BTC", "1Y")

    def test_backtest_rejects_insufficient_market_data(self) -> None:
        candles = [
            {"date": str(i), "open": 1, "high": 1, "low": 1, "close": 1, "volume": 1}
            for i in range(9)
        ]
        with patch.object(
            main,
            "get_chart",
            new=AsyncMock(
                return_value={
                    "candles": candles,
                    "source": "fixture provider",
                    "fetched_at": "2026-08-02T00:00:00+00:00",
                }
            ),
        ):
            response = self.client.post("/api/backtest", json={"ticker": "BTC"})

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json(), {"detail": "데이터 부족 (최소 10개 캔들 필요)"})

    def test_backtest_requires_enough_data_for_period_split_validation(self) -> None:
        candles = [
            {"date": str(i), "open": 1, "high": 1, "low": 1, "close": 1, "volume": 1}
            for i in range(12)
        ]
        with patch.object(
            main,
            "get_chart",
            new=AsyncMock(
                return_value={
                    "candles": candles,
                    "source": "fixture provider",
                    "fetched_at": "2026-08-02T00:00:00+00:00",
                }
            ),
        ):
            response = self.client.post("/api/backtest", json={"ticker": "BTC"})

        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            response.json(),
            {"detail": "데이터 부족 (기간 분할 검증에 최소 20개 캔들 필요)"},
        )

    def test_backtest_rejects_invalid_or_non_chronological_dates(self) -> None:
        candles = [
            {"date": f"2025-01-{i + 1:02d}", "open": 1, "high": 1, "low": 1, "close": 1, "volume": 1}
            for i in range(20)
        ]
        candles[10]["date"] = "not-a-date"
        with patch.object(main, "get_chart", new=AsyncMock(return_value={"candles": candles})):
            response = self.client.post("/api/backtest", json={"ticker": "BTC"})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json(), {"detail": "가격 데이터 날짜 형식이 올바르지 않습니다"})

        ordered = [
            {"date": (date(2025, 1, 1) + timedelta(days=i)).isoformat(), "open": 1, "high": 1, "low": 1, "close": 1, "volume": 1}
            for i in range(20)
        ]
        ordered[10]["date"] = ordered[9]["date"]
        with patch.object(main, "get_chart", new=AsyncMock(return_value={"candles": ordered})):
            response = self.client.post("/api/backtest", json={"ticker": "BTC"})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json(), {"detail": "가격 데이터 날짜 순서가 올바르지 않습니다"})

        mixed_timezone = [
            {"date": (date(2025, 1, 1) + timedelta(days=i)).isoformat(), "open": 1, "high": 1, "low": 1, "close": 1, "volume": 1}
            for i in range(20)
        ]
        mixed_timezone[1]["date"] = "2025-01-02T00:00:00+00:00"
        with patch.object(main, "get_chart", new=AsyncMock(return_value={"candles": mixed_timezone})):
            response = self.client.post("/api/backtest", json={"ticker": "BTC"})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json(), {"detail": "가격 데이터 날짜 형식이 일관되지 않습니다"})

    def test_backtest_rejects_invalid_ohlc_values(self) -> None:
        candles = [
            {"date": (date(2025, 1, 1) + timedelta(days=i)).isoformat(), "open": 1, "high": 1, "low": 1, "close": 1, "volume": 1}
            for i in range(20)
        ]
        candles[5]["high"] = float("nan")
        with patch.object(main, "get_chart", new=AsyncMock(return_value={"candles": candles})):
            response = self.client.post("/api/backtest", json={"ticker": "BTC"})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json(), {"detail": "가격 데이터 OHLC 범위가 올바르지 않습니다"})

        candles[5]["high"] = 1
        zero_volume = [dict(candle, volume=0) for candle in candles]
        with patch.object(main, "get_chart", new=AsyncMock(return_value={"candles": zero_volume, "source": "fixture"})):
            response = self.client.post("/api/backtest", json={"ticker": "BTC", "strategy": "bah"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["execution_mode"], "paper")

        negative_volume = [dict(candle, volume=-1) for candle in candles]
        with patch.object(main, "get_chart", new=AsyncMock(return_value={"candles": negative_volume})):
            response = self.client.post("/api/backtest", json={"ticker": "BTC"})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json(), {"detail": "가격 데이터 OHLC 범위가 올바르지 않습니다"})

    def test_backtest_success_contract_returns_all_paper_results(self) -> None:
        candles = []
        for i in range(80):
            close = 100 + i * 0.5
            candles.append(
                {
                    "date": (date(2025, 1, 1) + timedelta(days=i)).isoformat(),
                    "open": close - 0.2,
                    "high": close + 1,
                    "low": close - 1,
                    "close": close,
                    "volume": 1_000,
                }
            )

        with patch.object(
            main,
            "get_chart",
            new=AsyncMock(
                return_value={
                    "candles": candles,
                    "source": "fixture provider",
                    "fetched_at": "2026-08-02T00:00:00+00:00",
                }
            ),
        ):
            response = self.client.post(
                "/api/backtest",
                json={"ticker": "BTC", "period": "1Y", "initial": 1_000_000, "strategy": "all"},
            )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["ticker"], "BTC")
        self.assertEqual(payload["period"], "1Y")
        self.assertEqual(payload["execution_mode"], "paper")
        self.assertFalse(payload["live_allowed"])
        self.assertEqual(payload["source"], "fixture provider")
        self.assertEqual(payload["fetched_at"], "2026-08-02T00:00:00+00:00")
        self.assertEqual(payload["costs"], {"commission_bps": 10.0, "slippage_bps": 5.0, "total_bps": 15.0})
        self.assertEqual(payload["benchmark"]["strategy"], "bah")
        self.assertEqual(payload["validation"]["method"], "chronological_holdout")
        self.assertEqual(payload["validation"]["label"], "시간순 홀드아웃")
        self.assertEqual(payload["validation"]["train_ratio"], 0.7)
        self.assertEqual(payload["validation"]["train_samples"], 56)
        self.assertEqual(payload["validation"]["test_samples"], 24)
        self.assertEqual(payload["validation"]["warning"], "검증 표본이 30개 미만이라 Sharpe 해석에 주의가 필요합니다")
        self.assertFalse(payload["walk_forward"]["available"])
        self.assertEqual(payload["walk_forward"]["folds"], [])
        self.assertEqual(payload["walk_forward"]["summaries"], [])
        self.assertEqual(len(payload["validation"]["results"]), 6)
        self.assertEqual(len(payload["results"]), 6)
        self.assertTrue(all(result["curve"] for result in payload["results"]))
        self.assertTrue(all(result["paper"] for result in payload["results"]))

        long_candles = [
            {
                "date": (date(2025, 1, 1) + timedelta(days=i)).isoformat(),
                "open": 100 + i * 0.1,
                "high": 101 + i * 0.1,
                "low": 99 + i * 0.1,
                "close": 100 + i * 0.1,
                "volume": 1_000,
            }
            for i in range(180)
        ]
        with patch.object(main, "get_chart", new=AsyncMock(return_value={"candles": long_candles, "source": "fixture"})):
            long_response = self.client.post("/api/backtest", json={"ticker": "BTC", "strategy": "bah"})
        self.assertEqual(long_response.status_code, 200)
        self.assertEqual(long_response.json()["validation"]["test_samples"], 55)
        self.assertIsNone(long_response.json()["validation"]["warning"])
        self.assertTrue(long_response.json()["walk_forward"]["available"])
        self.assertEqual(len(long_response.json()["walk_forward"]["folds"]), 3)
        self.assertEqual(long_response.json()["walk_forward"]["folds"][0]["test_samples"], 30)
        self.assertTrue(all(len(fold["results"]) == 1 for fold in long_response.json()["walk_forward"]["folds"]))
        summary = long_response.json()["walk_forward"]["summaries"][0]
        self.assertEqual(summary["strategy"], "bah")
        self.assertEqual(summary["positive_fold_ratio"], 1.0)
        self.assertTrue(summary["consistent"])

    def test_backtest_cost_inputs_change_paper_result_and_are_returned(self) -> None:
        candles = [
            {"date": f"2025-01-{i + 1:02d}", "open": 100 + i, "high": 102 + i, "low": 99 + i, "close": 101 + i, "volume": 1_000}
            for i in range(20)
        ]
        with patch.object(
            main,
            "get_chart",
            new=AsyncMock(return_value={"candles": candles, "source": "fixture", "fetched_at": "2026-08-02T00:00:00+00:00"}),
        ):
            free = self.client.post("/api/backtest", json={"ticker": "BTC", "strategy": "bah", "commission_bps": 0, "slippage_bps": 0})
            costly = self.client.post("/api/backtest", json={"ticker": "BTC", "strategy": "bah", "commission_bps": 100, "slippage_bps": 100})

        self.assertEqual(free.status_code, 200)
        self.assertEqual(costly.status_code, 200)
        self.assertEqual(costly.json()["costs"]["total_bps"], 200.0)
        self.assertEqual(costly.json()["benchmark"]["strategy"], "bah")
        self.assertEqual(costly.json()["validation"]["results"][0]["strategy"], "bah")
        self.assertLess(costly.json()["results"][0]["final"], free.json()["results"][0]["final"])

    def test_backtest_ensemble_strategy_is_paper_only_in_single_strategy_mode(self) -> None:
        candles = []
        for i in range(40):
            close = 100 + (i % 8) * 2 + i * 0.1
            candles.append(
                {
                    "date": (date(2025, 1, 1) + timedelta(days=i)).isoformat(),
                    "open": close - 0.5,
                    "high": close + 1,
                    "low": close - 1,
                    "close": close,
                    "volume": 1_000,
                }
            )

        with patch.object(main, "get_chart", new=AsyncMock(return_value={"candles": candles, "source": "fixture"})):
            response = self.client.post("/api/backtest", json={"ticker": "BTC", "strategy": "ensemble"})

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["execution_mode"], "paper")
        self.assertFalse(payload["live_allowed"])
        self.assertEqual([result["strategy"] for result in payload["results"]], ["ensemble"])
        self.assertEqual(payload["benchmark"]["strategy"], "bah")
        self.assertEqual([result["strategy"] for result in payload["validation"]["results"]], ["ensemble"])
        self.assertTrue(payload["results"][0]["paper"])

    def test_chart_contract_includes_source_and_fetched_at(self) -> None:
        candles = [{"date": "2026-08-01", "open": 1, "high": 2, "low": 1, "close": 2, "volume": 10}]
        with patch.object(main.us, "get_us_chart", new=AsyncMock(return_value=candles)) as provider:
            response = self.client.get("/api/price/AAPL/chart?period=1M")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["source"], "Yahoo Finance")
        self.assertTrue(payload["fetched_at"])
        self.assertEqual(payload["candles"], candles)
        provider.assert_awaited_once_with("AAPL", "1M")

    def test_paper_start_stop_contract_never_uses_live_provider(self) -> None:
        with (
            patch.object(main.bot, "configure") as configure,
            patch.object(main.bot, "start", new=AsyncMock()) as start,
            patch.object(main.bot, "stop", new=AsyncMock()) as stop,
        ):
            started = self.client.post(
                "/api/bot/start",
                json={
                    "mode": "paper",
                    "strategy": "ensemble",
                    "symbols": ["BTC"],
                    "initial_capital": 1_000_000,
                },
            )
            stopped = self.client.post("/api/bot/stop")

        self.assertEqual(started.status_code, 200)
        self.assertEqual(started.json()["execution_mode"], "paper")
        self.assertFalse(started.json()["live_allowed"])
        self.assertEqual(stopped.status_code, 200)
        configure.assert_called_once_with("paper", "ensemble", ["BTC"], 1_000_000)
        start.assert_awaited_once()
        stop.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
