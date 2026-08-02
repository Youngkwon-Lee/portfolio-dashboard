from __future__ import annotations

import os
import sys
import tempfile
import unittest
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

    def test_backtest_success_contract_returns_all_paper_results(self) -> None:
        candles = []
        for i in range(80):
            close = 100 + i * 0.5
            candles.append(
                {
                    "date": f"2025-01-{(i % 28) + 1:02d}",
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
        self.assertEqual(payload["source"], "fixture provider")
        self.assertEqual(payload["fetched_at"], "2026-08-02T00:00:00+00:00")
        self.assertEqual(len(payload["results"]), 6)
        self.assertTrue(all(result["curve"] for result in payload["results"]))
        self.assertTrue(all(result["paper"] for result in payload["results"]))


if __name__ == "__main__":
    unittest.main()
