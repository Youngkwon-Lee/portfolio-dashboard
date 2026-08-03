"""Notify Discord only when the local paper API changes health state."""

from __future__ import annotations

import asyncio
import json
import os
import urllib.request
from pathlib import Path

from dotenv import load_dotenv

import notifier


DEFAULT_URL = "http://127.0.0.1:8000/health"
DEFAULT_STATE = Path("runtime/health-watch.json")


def _read_health(url: str) -> tuple[bool, str]:
    try:
        with urllib.request.urlopen(url, timeout=5) as response:
            payload = json.loads(response.read())
        healthy = (
            response.status == 200
            and payload.get("execution_mode") == "paper"
            and payload.get("live_allowed") is False
        )
        return healthy, "paper-only" if healthy else "계약 불일치"
    except Exception as exc:
        return False, type(exc).__name__


def main() -> int:
    load_dotenv()
    state_path = Path(os.getenv("PAPER_HEALTH_STATE_PATH", str(DEFAULT_STATE))).expanduser()
    state_path.parent.mkdir(parents=True, exist_ok=True)
    healthy, detail = _read_health(os.getenv("PAPER_HEALTH_URL", DEFAULT_URL))
    current = {"healthy": healthy, "detail": detail}
    previous = None
    if state_path.is_file():
        try:
            previous = json.loads(state_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            previous = None

    if previous is not None and previous.get("healthy") != healthy:
        status = "복구" if healthy else "장애"
        asyncio.run(notifier.send(
            f"🩺 <b>Paper 서버 {status}</b>\n"
            f"상태: {detail}\n실거래 주문 없음 · live_allowed=false"
        ))
    state_path.write_text(json.dumps(current, ensure_ascii=False) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
