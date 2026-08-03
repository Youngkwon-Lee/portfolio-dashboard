from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import health_watch  # noqa: E402


class HealthWatchTests(unittest.TestCase):
    def test_first_healthy_check_is_silent(self) -> None:
        with tempfile.TemporaryDirectory() as directory, patch.dict(
            os.environ,
            {"PAPER_HEALTH_STATE_PATH": str(Path(directory) / "state.json")},
            clear=True,
        ), patch.object(health_watch, "_read_health", return_value=(True, "paper-only")), patch.object(
            health_watch.notifier, "send", new=AsyncMock()
        ) as send:
            health_watch.main()
            send.assert_not_awaited()

    def test_state_transition_notifies_once(self) -> None:
        with tempfile.TemporaryDirectory() as directory, patch.dict(
            os.environ,
            {"PAPER_HEALTH_STATE_PATH": str(Path(directory) / "state.json")},
            clear=True,
        ), patch.object(health_watch, "_read_health", side_effect=[(True, "paper-only"), (False, "URLError")]), patch.object(
            health_watch.notifier, "send", new=AsyncMock()
        ) as send:
            health_watch.main()
            health_watch.main()
            send.assert_awaited_once()
            saved = json.loads((Path(directory) / "state.json").read_text())
            self.assertFalse(saved["healthy"])


if __name__ == "__main__":
    unittest.main()
