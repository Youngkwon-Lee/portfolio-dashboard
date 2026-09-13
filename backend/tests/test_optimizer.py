from __future__ import annotations

import math
import sys
import unittest
from pathlib import Path


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import optimizer  # noqa: E402


class OptimizerContractTests(unittest.TestCase):
    def _history(self) -> dict[str, list[float]]:
        return {
            "AAA": [100 + i * 0.7 + math.sin(i / 3) for i in range(60)],
            "BBB": [120 + i * 0.4 + math.cos(i / 4) for i in range(60)],
        }

    def test_same_input_is_reproducible(self) -> None:
        first = optimizer.optimize(["AAA", "BBB"], self._history())
        second = optimizer.optimize(["AAA", "BBB"], self._history())

        self.assertEqual(first, second)
        self.assertTrue(first["methodology"]["reproducible"])
        self.assertTrue(first["methodology"]["paper_only"])
        self.assertEqual(first["execution_mode"], "paper")
        self.assertFalse(first["live_allowed"])

    def test_seed_changes_sampling_but_preserves_constraints(self) -> None:
        result = optimizer.optimize(["AAA", "BBB"], self._history(), seed=7)
        weights = result["max_sharpe"]["weights"]

        self.assertAlmostEqual(sum(weights.values()), 1.0, places=3)
        self.assertTrue(all(weight >= 0.01 for weight in weights.values()))
        self.assertEqual(result["methodology"]["seed"], 7)


if __name__ == "__main__":
    unittest.main()
