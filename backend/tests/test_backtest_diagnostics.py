from __future__ import annotations

import sys
import unittest
from pathlib import Path


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import backtest_diagnostics as diagnostics  # noqa: E402


class BacktestDiagnosticsTests(unittest.TestCase):
    def test_deflated_sharpe_requires_meaningful_sample(self) -> None:
        result = diagnostics.deflated_sharpe_probability([0.01, -0.01] * 10, trials=6)
        self.assertFalse(result["available"])
        self.assertEqual(result["sample_size"], 20)

    def test_deflated_sharpe_returns_selection_adjusted_probability(self) -> None:
        returns = [0.001] * 20 + [-0.0005] * 20
        result = diagnostics.deflated_sharpe_probability(returns, trials=6)
        self.assertTrue(result["available"])
        self.assertEqual(result["sample_size"], 40)
        self.assertEqual(result["trials"], 6)
        self.assertGreaterEqual(result["probability"], 0.0)
        self.assertLessEqual(result["probability"], 1.0)
        self.assertGreater(result["selection_benchmark_sharpe"], 0.0)

    def test_pbo_preserves_contiguous_time_blocks(self) -> None:
        stable = [0.002] * 40
        alternating = [0.004] * 20 + [-0.004] * 20
        result = diagnostics.probability_of_backtest_overfitting(
            {"stable": stable, "alternating": alternating},
            blocks=4,
        )
        self.assertTrue(result["available"])
        self.assertEqual(result["method"], "CSCV_contiguous_blocks")
        self.assertEqual(result["combinations"], 6)
        self.assertEqual(result["purge_applied"], False)
        self.assertGreaterEqual(result["pbo"], 0.0)
        self.assertLessEqual(result["pbo"], 1.0)

    def test_robustness_diagnostics_are_paper_only(self) -> None:
        class Result:
            def __init__(self, strategy: str) -> None:
                self.strategy = strategy
                self.curve = [{"value": 100.0 * (1.001 ** index)} for index in range(41)]

        result = diagnostics.build_robustness_diagnostics([Result("sma_cross"), Result("rsi")])
        self.assertTrue(result["paper_only"])
        self.assertEqual(result["method"], "CSCV_PBO_and_Deflated_Sharpe")
        self.assertTrue(result["pbo"]["available"])
        self.assertIn("sma_cross", result["deflated_sharpe"])
        self.assertIn("rsi", result["deflated_sharpe"])
        self.assertIn("자동 승인하지 않습니다", result["warning"])


if __name__ == "__main__":
    unittest.main()
