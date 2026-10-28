from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

TEST_RUNTIME = tempfile.TemporaryDirectory()
os.environ["PORTFOLIO_DB_PATH"] = str(Path(TEST_RUNTIME.name) / "portfolio.db")
os.environ["TRADING_SAFETY_STATE_PATH"] = str(Path(TEST_RUNTIME.name) / "safety.json")

from fastapi.testclient import TestClient  # noqa: E402
import main  # noqa: E402
import database  # noqa: E402
from research_workflow import ResearchStore  # noqa: E402


class ResearchApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.original_store = main.research_store
        cls.original_db_path = database.DB_PATH
        database.DB_PATH = str(Path(TEST_RUNTIME.name) / "portfolio.db")
        main.research_store = ResearchStore(str(Path(TEST_RUNTIME.name) / "research.db"))
        cls.client_context = TestClient(main.app)
        cls.client = cls.client_context.__enter__()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.client_context.__exit__(None, None, None)
        main.research_store = cls.original_store
        database.DB_PATH = cls.original_db_path
        TEST_RUNTIME.cleanup()

    def test_status_is_shadow_and_does_not_expose_credentials(self) -> None:
        response = self.client.get("/api/research/status")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["mode"], "shadow")
        self.assertFalse(payload["live_verified"])
        self.assertFalse(payload["secrets_exposed"])
        self.assertNotIn("token", json_keys(payload))

    def test_fixture_run_is_readable_after_refresh_and_idempotent(self) -> None:
        instruments = self.client.get("/api/research/instruments?query=삼성")
        self.assertEqual(instruments.status_code, 200)
        self.assertEqual(instruments.json()["instruments"][0]["symbol"], "005930")

        request = {
            "symbol": "005930",
            "exchange": "KRX",
            "interval": "1D",
            "source": "fixture",
            "strategy": "sma_cross",
            "decision_provider": "mock",
            "request_key": "api-test:005930:one",
        }
        first = self.client.post("/api/research/runs", json=request)
        self.assertEqual(first.status_code, 200)
        first_payload = first.json()
        self.assertEqual(first_payload["status"], "evaluated")
        self.assertEqual(first_payload["execution_mode"], "paper")
        self.assertEqual(first_payload["snapshot"]["source"], "fixture")

        replay = self.client.post("/api/research/runs", json=request)
        self.assertEqual(replay.status_code, 200)
        self.assertTrue(replay.json()["replayed"])
        self.assertEqual(replay.json()["run_id"], first_payload["run_id"])

        listed = self.client.get("/api/research/runs")
        self.assertEqual(listed.status_code, 200)
        self.assertEqual(listed.json()["runs"][0]["run_id"], first_payload["run_id"])

        detail = self.client.get(f"/api/research/runs/{first_payload['run_id']}")
        self.assertEqual(detail.status_code, 200)
        self.assertEqual(detail.json()["input_hash"], first_payload["input_hash"])

    def test_live_request_is_deferred_without_external_call(self) -> None:
        response = self.client.post(
            "/api/research/runs",
            json={
                "symbol": "005930",
                "exchange": "KRX",
                "source": "tradingview",
                "decision_provider": "jev",
                "request_key": "api-test:tradingview:not-configured",
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "deferred")
        self.assertEqual(response.json()["error"]["code"], "tradingview_not_configured")


def json_keys(value: object) -> set[str]:
    if isinstance(value, dict):
        keys = set(value)
        for nested in value.values():
            keys.update(json_keys(nested))
        return keys
    if isinstance(value, list):
        keys: set[str] = set()
        for nested in value:
            keys.update(json_keys(nested))
        return keys
    return set()


if __name__ == "__main__":
    unittest.main()
