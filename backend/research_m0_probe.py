"""Run the bounded M0 read-only provider probe.

The probe never prints credentials. It exits with code 2 when the backend
runtime is missing either provider credential, so missing access is explicit
instead of being mistaken for a provider failure.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from typing import Any

import research_workflow as research


def _summary_error(error: Exception) -> dict[str, str]:
    if isinstance(error, research.ResearchProviderError):
        return {"code": error.code, "message": str(error)}
    return {"code": "unexpected_error", "message": "provider probe failed"}


async def probe(query: str) -> tuple[int, dict[str, Any]]:
    report: dict[str, Any] = {
        "mode": "m0_read_only_probe",
        "live_verified": False,
        "credentials_present": {
            "tradingview": bool(research._configured_tradingview_token()),
            "jev": bool(research._configured_jev_key()),
        },
        "tradingview": None,
        "jev": None,
    }
    if not report["credentials_present"]["tradingview"]:
        report["tradingview"] = {"status": "blocked", "error": {"code": "missing_credential", "message": "TRADINGVIEW_MCP_ACCESS_TOKEN is not set"}}
    if not report["credentials_present"]["jev"]:
        report["jev"] = {"status": "blocked", "error": {"code": "missing_credential", "message": "TYPESAFE_API_KEY is not set"}}
    if not all(report["credentials_present"].values()):
        return 2, report

    try:
        tradingview = research.TradingViewMcpProvider()
        instruments = await tradingview.search(query)
        if not instruments:
            raise research.ResearchProviderError("instrument_not_found", "TradingView returned no matching symbols")
        instrument = instruments[0]
        snapshot = await tradingview.snapshot(instrument["symbol"], instrument["exchange"], "1D")
        quality_issues = research.validate_snapshot(snapshot)
        report["tradingview"] = {
            "status": "verified" if not quality_issues else "deferred",
            "instrument": instrument,
            "snapshot": {
                "source": snapshot.source,
                "symbol": snapshot.symbol,
                "exchange": snapshot.exchange,
                "bars": len(snapshot.bars),
                "bar_closed": snapshot.bar_closed,
                "observed_at": snapshot.observed_at,
                "fetched_at": snapshot.fetched_at,
                "quality_issues": quality_issues,
            },
        }
        if quality_issues:
            report["jev"] = {"status": "skipped", "reason": "snapshot_quality_failed"}
            return 1, report

        signal = research.build_strategy_signal(snapshot, research.DEFAULT_STRATEGY)
        decision = research.TypeSafeJevDecisionProvider()
        result = await decision.evaluate(
            {
                "snapshot": snapshot.to_dict(),
                "strategy_signal": signal,
                "policy_version": research.RESEARCH_POLICY_VERSION,
            },
            [],
        )
        report["jev"] = {
            "status": "verified" if result.get("status") == "evaluated" else "deferred",
            "provider": result.get("provider"),
            "model_version": result.get("model_version"),
            "question_version": result.get("question_version"),
            "answer_count": len(result.get("answers", [])),
            "confidence": result.get("confidence"),
            "usage": result.get("usage"),
        }
    except Exception as error:  # noqa: BLE001 - CLI must return a sanitized report
        if report["tradingview"] is None or report["tradingview"].get("status") != "verified":
            report["tradingview"] = {"status": "error", "error": _summary_error(error)}
        else:
            report["jev"] = {"status": "error", "error": _summary_error(error)}
        return 1, report

    report["live_verified"] = True
    return 0, report


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the PortfolioAI M0 TradingView + Jev read-only probe.")
    parser.add_argument("--query", default="AAPL", help="TradingView symbol/company query")
    args = parser.parse_args()
    status, report = asyncio.run(probe(args.query))
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return status


if __name__ == "__main__":
    sys.exit(main())
