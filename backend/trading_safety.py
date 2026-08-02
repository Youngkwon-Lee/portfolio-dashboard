"""Fail-closed safety policy for the paper-trading MVP.

This module deliberately contains no broker or exchange integration.  It owns the
small, durable safety state that must survive a process restart: duplicate-order
keys, reconciliation requirements, the daily loss halt, and the kill switch.
"""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable


LIVE_BLOCK_REASON = (
    "실거래는 법무·보안 검토와 별도 승인 전까지 서버 정책으로 차단됩니다."
)
MAX_RESERVED_ORDER_KEYS = 1_000


class SafetyViolation(RuntimeError):
    """Raised when a requested action violates the paper-only safety policy."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class LiveTradingBlocked(SafetyViolation):
    def __init__(self, message: str = LIVE_BLOCK_REASON):
        super().__init__("live_trading_blocked", message)


@dataclass
class SafetyState:
    version: int = 1
    kill_switch: bool = False
    daily_halt: bool = False
    daily_halt_day: str = ""
    reconciliation_required: bool = False
    active_session_id: str = ""
    halt_reason: str = ""
    reserved_order_keys: list[str] = field(default_factory=list)
    updated_at: str = ""


class SafetyController:
    """Persist and enforce paper-trading safety state.

    The state path is intentionally separate from ``portfolio.db``. Tests and
    operators can override it with ``TRADING_SAFETY_STATE_PATH``.
    """

    def __init__(
        self,
        path: str | os.PathLike[str] | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        default_path = Path(__file__).with_name("paper_trading_safety.json")
        self.path = Path(path or os.getenv("TRADING_SAFETY_STATE_PATH", default_path))
        self._now = now or (lambda: datetime.now(timezone.utc))
        self.state = self._load()

    def _load(self) -> SafetyState:
        if not self.path.exists():
            return SafetyState()
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
            allowed = SafetyState.__dataclass_fields__.keys()
            values = {key: raw[key] for key in allowed if key in raw}
            state = SafetyState(**values)
            if not isinstance(state.reserved_order_keys, list):
                raise ValueError("reserved_order_keys must be a list")
            return state
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            # Corrupt or unreadable state is never treated as a clean start.
            return SafetyState(
                kill_switch=True,
                reconciliation_required=True,
                halt_reason="안전 상태 파일을 읽을 수 없어 fail-closed로 차단했습니다.",
            )

    def _persist(self) -> None:
        self.state.updated_at = self._now().isoformat()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(f"{self.path.suffix}.tmp")
        temporary.write_text(
            json.dumps(asdict(self.state), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        os.replace(temporary, self.path)

    @staticmethod
    def assert_paper_mode(mode: object) -> None:
        value = getattr(mode, "value", mode)
        if value != "paper":
            raise LiveTradingBlocked()

    def rollover_day(self) -> None:
        today = self._now().date().isoformat()
        if self.state.daily_halt and self.state.daily_halt_day != today:
            self.state.daily_halt = False
            self.state.daily_halt_day = ""
            if not self.state.kill_switch and not self.state.reconciliation_required:
                self.state.halt_reason = ""
            self._persist()

    def assert_can_trade(self, mode: object = "paper") -> None:
        self.assert_paper_mode(mode)
        self.rollover_day()
        if self.state.kill_switch:
            raise SafetyViolation(
                "kill_switch_active",
                self.state.halt_reason or "kill switch가 활성화되어 있습니다.",
            )
        if self.state.reconciliation_required:
            raise SafetyViolation(
                "reconciliation_required",
                self.state.halt_reason or "재시작 상태 대사가 필요합니다.",
            )
        if self.state.daily_halt:
            raise SafetyViolation(
                "daily_loss_halt",
                self.state.halt_reason or "일일 손실 한도로 오늘 거래가 중단되었습니다.",
            )

    def start_session(self, session_id: str, mode: object = "paper") -> None:
        self.assert_can_trade(mode)
        if not session_id:
            raise SafetyViolation("invalid_session", "session_id가 필요합니다.")
        active = self.state.active_session_id
        if active and active != session_id:
            self.state.reconciliation_required = True
            self.state.halt_reason = "이전 실행 세션이 남아 있어 상태 대사가 필요합니다."
            self._persist()
            raise SafetyViolation("reconciliation_required", self.state.halt_reason)
        self.state.active_session_id = session_id
        self._persist()

    def end_session(self, session_id: str) -> None:
        if self.state.active_session_id == session_id:
            self.state.active_session_id = ""
            self._persist()

    def reserve_order(self, order_key: str, mode: object = "paper") -> bool:
        """Reserve an idempotency key before mutating simulated holdings.

        Returns ``False`` for a duplicate. The reservation is persisted before
        the caller performs the simulated order mutation.
        """
        self.assert_can_trade(mode)
        if not order_key:
            raise SafetyViolation("missing_order_key", "주문 idempotency key가 필요합니다.")
        if not self.state.active_session_id:
            raise SafetyViolation("session_required", "활성 paper 세션 없이 주문할 수 없습니다.")
        if order_key in self.state.reserved_order_keys:
            return False
        self.state.reserved_order_keys.append(order_key)
        self.state.reserved_order_keys = self.state.reserved_order_keys[-MAX_RESERVED_ORDER_KEYS:]
        self._persist()
        return True

    def evaluate_capital(
        self,
        current_capital: float,
        daily_start_capital: float,
        peak_capital: float,
        *,
        daily_loss_limit: float = 0.02,
        max_drawdown_limit: float = 0.10,
    ) -> None:
        """Persist a halt once an equity-based risk limit is breached."""
        if min(current_capital, daily_start_capital, peak_capital) < 0:
            raise SafetyViolation("invalid_capital", "자본 값은 음수일 수 없습니다.")

        drawdown = (
            (peak_capital - current_capital) / peak_capital if peak_capital else 0.0
        )
        if drawdown >= max_drawdown_limit:
            self.state.kill_switch = True
            self.state.halt_reason = (
                f"최대 낙폭 {drawdown * 100:.2f}%가 "
                f"한도 {max_drawdown_limit * 100:.2f}%에 도달했습니다."
            )
            self._persist()
            return

        daily_loss = (
            (daily_start_capital - current_capital) / daily_start_capital
            if daily_start_capital
            else 0.0
        )
        if daily_loss >= daily_loss_limit:
            self.state.daily_halt = True
            self.state.daily_halt_day = self._now().date().isoformat()
            self.state.halt_reason = (
                f"일일 손실 {daily_loss * 100:.2f}%가 "
                f"한도 {daily_loss_limit * 100:.2f}%에 도달했습니다."
            )
            self._persist()

    def trigger_kill_switch(self, reason: str = "사용자가 kill switch를 실행했습니다.") -> None:
        self.state.kill_switch = True
        self.state.halt_reason = reason
        self._persist()

    def require_reconciliation(self, reason: str) -> None:
        """Fail closed when the durable paper ledger outcome is uncertain."""
        self.state.reconciliation_required = True
        self.state.halt_reason = reason or "paper 상태 대사가 필요합니다."
        self._persist()

    def acknowledge_reconciliation(self, confirmation: str) -> None:
        if confirmation != "RECONCILE_PAPER_STATE":
            raise SafetyViolation("confirmation_required", "상태 대사 확인 문구가 일치하지 않습니다.")
        self.state.active_session_id = ""
        self.state.reconciliation_required = False
        if not self.state.kill_switch and not self.state.daily_halt:
            self.state.halt_reason = ""
        self._persist()

    def reset_kill_switch(self, confirmation: str) -> None:
        if confirmation != "RESET_PAPER_KILL_SWITCH":
            raise SafetyViolation("confirmation_required", "kill switch 확인 문구가 일치하지 않습니다.")
        self.state.kill_switch = False
        if not self.state.daily_halt and not self.state.reconciliation_required:
            self.state.halt_reason = ""
        self._persist()

    def contract(self) -> dict:
        self.rollover_day()
        return {
            "execution_mode": "paper",
            "live_allowed": False,
            "credential_input_allowed": False,
            "live_block_reason": LIVE_BLOCK_REASON,
            "limits": {
                "max_position_pct": 20,
                "daily_loss_pct": 2,
                "max_drawdown_pct": 10,
            },
            "state": asdict(self.state),
        }
