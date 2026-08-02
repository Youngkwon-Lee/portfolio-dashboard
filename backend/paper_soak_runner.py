"""Deterministic wall-clock soak runner for the paper-trading safety boundary.

The runner never fetches market data or submits an external request. It uses a
new runtime directory under the operating-system temporary directory by default
or an explicitly approved durable directory, blocks socket connections at the
Python audit-hook boundary, and writes an atomic JSON checkpoint that can be
monitored by another process.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import math
import os
import signal
import sqlite3
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, patch


BACKEND_DIR = Path(__file__).resolve().parent
REPOSITORY_DIR = BACKEND_DIR.parent
DEFAULT_DURATION_SECONDS = 24 * 60 * 60
DEFAULT_TICK_SECONDS = 60.0
MIN_PRODUCTION_DURATION_SECONDS = DEFAULT_DURATION_SECONDS
DURABLE_RUNTIME_ROOT = (
    Path.home() / "Library" / "Application Support" / "portfolio-dashboard-paper-soak"
)


class SoakInvariantError(RuntimeError):
    """Raised when a wall-clock soak invariant fails."""


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _file_fingerprint(path: Path) -> dict[str, Any]:
    stat = path.stat()
    return {
        "path": str(path),
        "sha256": _sha256(path),
        "size_bytes": stat.st_size,
        "mtime_ns": stat.st_mtime_ns,
    }


def _is_within(path: Path, parent: Path) -> bool:
    return path == parent or parent in path.parents


def _atomic_write_json(path: Path, value: dict[str, Any]) -> None:
    temporary = path.with_suffix(f"{path.suffix}.tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, path)


def _ledger_stats(path: Path) -> dict[str, int]:
    if not path.exists():
        return {"rows": 0, "distinct_ids": 0, "non_paper_rows": 0}
    with sqlite3.connect(path) as connection:
        row = connection.execute(
            """
            SELECT COUNT(*), COUNT(DISTINCT id),
                   SUM(CASE WHEN mode != 'paper' THEN 1 ELSE 0 END)
            FROM trades
            """
        ).fetchone()
        quick_check = connection.execute("PRAGMA quick_check").fetchone()
    if quick_check != ("ok",):
        raise SoakInvariantError(f"temporary ledger quick_check failed: {quick_check!r}")
    return {
        "rows": int(row[0]),
        "distinct_ids": int(row[1]),
        "non_paper_rows": int(row[2] or 0),
    }


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--runtime-dir",
        type=Path,
        help="Empty runtime directory under an OS temp root or approved durable root.",
    )
    parser.add_argument(
        "--evidence-path",
        type=Path,
        help="JSON checkpoint path inside --runtime-dir (default: evidence.json).",
    )
    parser.add_argument(
        "--user-db-path",
        type=Path,
        default=BACKEND_DIR / "portfolio.db",
        help="Read-only user DB whose fingerprint must remain unchanged.",
    )
    parser.add_argument(
        "--duration-seconds",
        type=float,
        default=float(DEFAULT_DURATION_SECONDS),
    )
    parser.add_argument(
        "--tick-seconds",
        type=float,
        default=DEFAULT_TICK_SECONDS,
    )
    parser.add_argument(
        "--reconnect-every-cycles",
        type=int,
        default=60,
    )
    parser.add_argument(
        "--fault-every-cycles",
        type=int,
        default=15,
    )
    parser.add_argument(
        "--kill-every-cycles",
        type=int,
        default=120,
    )
    parser.add_argument(
        "--allow-short-duration",
        action="store_true",
        help="Allow a sub-24-hour run for local smoke verification only.",
    )
    parser.add_argument(
        "--allow-durable-runtime",
        action="store_true",
        help="Allow --runtime-dir under the fixed durable Application Support root.",
    )
    return parser.parse_args()


def _validate_args(args: argparse.Namespace) -> tuple[Path, Path, Path, Path]:
    if not math.isfinite(args.duration_seconds) or args.duration_seconds <= 0:
        raise SystemExit("--duration-seconds must be a positive finite number")
    if (
        args.duration_seconds < MIN_PRODUCTION_DURATION_SECONDS
        and not args.allow_short_duration
    ):
        raise SystemExit(
            "sub-24-hour runs require --allow-short-duration and are smoke tests only"
        )
    if not math.isfinite(args.tick_seconds) or args.tick_seconds <= 0:
        raise SystemExit("--tick-seconds must be a positive finite number")
    for name in (
        "reconnect_every_cycles",
        "fault_every_cycles",
        "kill_every_cycles",
    ):
        if getattr(args, name) <= 0:
            raise SystemExit(f"--{name.replace('_', '-')} must be positive")

    temporary_roots = {
        Path("/tmp").resolve(),
        Path(tempfile.gettempdir()).resolve(),
    }

    def is_dedicated_temp(path: Path) -> bool:
        return not any(path == root for root in temporary_roots) and any(
            _is_within(path, root) for root in temporary_roots
        )

    durable_root = DURABLE_RUNTIME_ROOT.resolve()

    def is_dedicated_durable(path: Path) -> bool:
        return path != durable_root and durable_root in path.parents

    if args.runtime_dir is None:
        runtime = Path(tempfile.mkdtemp(prefix="portfolio-paper-wall-clock.")).resolve()
    else:
        runtime = args.runtime_dir.expanduser().resolve()
        allowed_durable = args.allow_durable_runtime and is_dedicated_durable(runtime)
        if not is_dedicated_temp(runtime) and not allowed_durable:
            raise SystemExit(
                "--runtime-dir must be under an OS temp root or approved durable root"
            )
        runtime.mkdir(parents=True, exist_ok=True)
        if any(runtime.iterdir()):
            raise SystemExit("--runtime-dir must be empty to prevent overwriting evidence")

    if not is_dedicated_temp(runtime) and not (
        args.allow_durable_runtime and is_dedicated_durable(runtime)
    ):
        raise SystemExit("runtime directory is outside an approved runtime root")

    evidence = (args.evidence_path or runtime / "evidence.json").expanduser().resolve()
    if evidence.parent != runtime:
        raise SystemExit("--evidence-path must be directly inside --runtime-dir")

    ledger = (runtime / "paper-soak.db").resolve()
    state = (runtime / "paper-safety.json").resolve()
    user_db = args.user_db_path.expanduser().resolve()
    if not user_db.is_file():
        raise SystemExit(f"read-only user DB does not exist: {user_db}")
    if any(path == user_db for path in (ledger, state, evidence)):
        raise SystemExit("runtime artifacts must never target the user DB")
    if _is_within(runtime, REPOSITORY_DIR.resolve()):
        raise SystemExit("runtime artifacts must be outside the repository")
    return runtime, evidence, ledger, state


def _fresh_status(bot: Any) -> Any:
    return bot.BotStatus(
        mode="paper",
        strategy="dual_mom",
        symbols=["BTC"],
        initial_capital=1_000_000,
        current_capital=1_000_000,
        equity_capital=1_000_000,
        peak_capital=1_000_000,
        daily_start_cap=1_000_000,
    )


def _expect_safety_code(callable_: Any, expected_code: str) -> None:
    try:
        callable_()
    except Exception as exc:
        if getattr(exc, "code", None) != expected_code:
            raise SoakInvariantError(
                f"expected safety code {expected_code!r}, got {getattr(exc, 'code', None)!r}"
            ) from exc
    else:
        raise SoakInvariantError(f"expected safety code {expected_code!r}")


def _risk_preflight(safety_module: Any, runtime: Path) -> dict[str, int]:
    safety_module.SafetyController.assert_paper_mode("paper")
    _expect_safety_code(
        lambda: safety_module.SafetyController.assert_paper_mode("live"),
        "live_trading_blocked",
    )

    daily = safety_module.SafetyController(runtime / "preflight-daily.json")
    daily.start_session("preflight-daily")
    daily.evaluate_capital(97_999, 100_000, 100_000)
    _expect_safety_code(
        safety_module.SafetyController(runtime / "preflight-daily.json").assert_can_trade,
        "daily_loss_halt",
    )

    drawdown = safety_module.SafetyController(runtime / "preflight-drawdown.json")
    drawdown.start_session("preflight-drawdown")
    drawdown.evaluate_capital(89_999, 100_000, 100_000)
    _expect_safety_code(
        safety_module.SafetyController(runtime / "preflight-drawdown.json").assert_can_trade,
        "kill_switch_active",
    )
    return {"live_blocks": 1, "loss_limit_checks": 2}


async def _market_fault_probe(bot: Any, status: Any, fault_index: int) -> None:
    """Exercise one real bot-loop cycle with a disconnected or invalid feed."""
    original_status = bot._status
    reserved_before = list(bot._safety.state.reserved_order_keys)
    rows_before = _ledger_stats(Path(bot.db.DB_PATH))["rows"]
    fault_status = _fresh_status(bot)
    bot._status = fault_status

    async def finish_cycle(delay: float) -> None:
        if delay >= 60:
            fault_status.running = False

    if fault_index % 2 == 0:
        price = AsyncMock(
            side_effect=bot.httpx.ConnectError(
                "simulated market-data disconnect",
                request=bot.httpx.Request("GET", "https://example.invalid/price"),
            )
        )
    else:
        price = AsyncMock(return_value={"current_price": math.nan})

    try:
        with (
            patch.object(bot, "_cached_price", new=price),
            patch.object(
                bot,
                "generate_signal",
                new=AsyncMock(return_value=(bot.Signal.BUY, {})),
            ),
            patch.object(bot.asyncio, "sleep", side_effect=finish_cycle),
            patch.object(bot.notifier, "notify_trade", new=AsyncMock()),
            patch.object(bot.notifier, "send", new=AsyncMock()),
            patch.object(bot.notifier, "notify_circuit_breaker", new=AsyncMock()),
            patch.object(bot.notifier, "notify_daily_report", new=AsyncMock()),
        ):
            await bot._bot_loop()
    finally:
        bot._status = original_status

    if fault_status.trade_count != 0 or fault_status.positions:
        raise SoakInvariantError("market-data fault mutated in-memory paper holdings")
    if fault_status.current_capital != 1_000_000:
        raise SoakInvariantError("market-data fault mutated paper capital")
    if fault_status.last_signal.get("BTC", {}).get("signal") != "ERROR":
        raise SoakInvariantError("market-data fault was not surfaced as an ERROR signal")
    if bot._safety.state.reserved_order_keys != reserved_before:
        raise SoakInvariantError("market-data fault reserved an order key")
    if _ledger_stats(Path(bot.db.DB_PATH))["rows"] != rows_before:
        raise SoakInvariantError("market-data fault wrote a ledger row")


async def _expect_blocked_order(bot: Any, order_key: str, expected_code: str) -> None:
    blocked = _fresh_status(bot)
    try:
        await bot.execute_order("BTC", bot.Signal.BUY, 50_000, blocked, order_key)
    except Exception as exc:
        if getattr(exc, "code", None) != expected_code:
            raise SoakInvariantError(
                f"expected blocked order code {expected_code!r}, got {getattr(exc, 'code', None)!r}"
            ) from exc
    else:
        raise SoakInvariantError(f"order was not blocked by {expected_code}")
    if blocked.trade_count != 0 or blocked.positions or blocked.current_capital != 1_000_000:
        raise SoakInvariantError("blocked order mutated paper state")


async def _run(args: argparse.Namespace) -> int:
    runtime, evidence_path, ledger_path, state_path = _validate_args(args)
    user_db_path = args.user_db_path.expanduser().resolve()
    user_db_baseline = _file_fingerprint(user_db_path)
    source_paths = [
        BACKEND_DIR / "database.py",
        BACKEND_DIR / "paper_soak_runner.py",
        BACKEND_DIR / "trading_bot.py",
        BACKEND_DIR / "trading_safety.py",
    ]
    source_baseline = {path.name: _file_fingerprint(path) for path in source_paths}

    os.environ["PORTFOLIO_DB_PATH"] = str(ledger_path)
    os.environ["TRADING_SAFETY_STATE_PATH"] = str(state_path)
    if str(BACKEND_DIR) not in sys.path:
        sys.path.insert(0, str(BACKEND_DIR))

    import trading_bot as bot
    import trading_safety as safety_module

    bot.db.DB_PATH = str(ledger_path)
    bot._safety = safety_module.SafetyController(state_path)
    bot._status = _fresh_status(bot)
    bot.logger.setLevel("CRITICAL")

    counters = {
        "blocked_attempts": 0,
        "cycles": 0,
        "duplicate_replays": 0,
        "kill_cycles": 0,
        "live_blocks": 0,
        "loss_limit_checks": 0,
        "market_fault_cycles": 0,
        "network_attempts": 0,
        "reconnects": 0,
    }
    preflight = _risk_preflight(safety_module, runtime)
    counters.update(preflight)

    network_guard_active = True

    def block_network(event: str, _event_args: tuple[Any, ...]) -> None:
        if network_guard_active and event in {"socket.connect", "socket.getaddrinfo"}:
            counters["network_attempts"] += 1
            raise SoakInvariantError("outbound network access is forbidden in paper soak")

    sys.addaudithook(block_network)

    await bot.db.init_db()
    session_index = 0
    session_id = f"wall-clock-paper-{session_index}"
    bot._safety.start_session(session_id)
    status = _fresh_status(bot)
    bot._status = status

    async def no_notification(*_args: Any, **_kwargs: Any) -> bool:
        return False

    bot.notifier.notify_trade = no_notification

    started_at = _utc_now()
    started_monotonic = time.monotonic()
    deadline = started_monotonic + args.duration_seconds
    expected_finish = started_at + timedelta(seconds=args.duration_seconds)
    last_cycle_started: float | None = None
    max_observed_gap = 0.0
    max_allowed_gap = max(args.tick_seconds * 3, args.tick_seconds + 5)
    minimum_cycles = max(1, math.floor(args.duration_seconds / args.tick_seconds * 0.9))
    stop_requested = asyncio.Event()
    loop = asyncio.get_running_loop()
    for handled_signal in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(handled_signal, stop_requested.set)
        except NotImplementedError:
            pass

    result_status = "running"
    error: str | None = None

    def snapshot() -> dict[str, Any]:
        nonlocal max_observed_gap
        ledger = _ledger_stats(ledger_path)
        user_db_current = _file_fingerprint(user_db_path)
        source_current = {path.name: _file_fingerprint(path) for path in source_paths}
        elapsed = max(0.0, time.monotonic() - started_monotonic)
        return {
            "schema_version": 1,
            "status": result_status,
            "mode": "paper",
            "live_allowed": False,
            "network_policy": "deny_all_socket_connections",
            "pid": os.getpid(),
            "started_at": started_at.isoformat(),
            "expected_finish_at": expected_finish.isoformat(),
            "last_checkpoint_at": _utc_now().isoformat(),
            "elapsed_seconds": round(elapsed, 3),
            "required_duration_seconds": args.duration_seconds,
            "tick_seconds": args.tick_seconds,
            "minimum_required_cycles": minimum_cycles,
            "max_allowed_gap_seconds": max_allowed_gap,
            "max_observed_gap_seconds": round(max_observed_gap, 3),
            "runtime": {
                "directory": str(runtime),
                "ledger": str(ledger_path),
                "safety_state": str(state_path),
                "evidence": str(evidence_path),
            },
            "counters": dict(counters),
            "ledger": ledger,
            "user_db": {
                "baseline": user_db_baseline,
                "current": user_db_current,
                "unchanged": user_db_current == user_db_baseline,
            },
            "source_files": {
                name: {
                    "baseline_sha256": baseline["sha256"],
                    "current_sha256": source_current[name]["sha256"],
                    "unchanged": source_current[name]["sha256"] == baseline["sha256"],
                }
                for name, baseline in source_baseline.items()
            },
            "invariants": {
                "duration_reached": elapsed >= args.duration_seconds,
                "ledger_ids_unique": ledger["rows"] == ledger["distinct_ids"],
                "ledger_paper_only": ledger["non_paper_rows"] == 0,
                "network_attempts_zero": counters["network_attempts"] == 0,
                "positions_flat": not status.positions,
                "user_db_unchanged": user_db_current == user_db_baseline,
            },
            "error": error,
        }

    def checkpoint() -> dict[str, Any]:
        value = snapshot()
        _atomic_write_json(evidence_path, value)
        return value

    checkpoint()
    print(
        "WALL_CLOCK_SOAK_STARTED "
        f"evidence={evidence_path} expected_finish={expected_finish.isoformat()}",
        flush=True,
    )

    try:
        next_cycle_at = started_monotonic
        while True:
            now = time.monotonic()
            if last_cycle_started is not None:
                gap = now - last_cycle_started
                max_observed_gap = max(max_observed_gap, gap)
                if gap > max_allowed_gap:
                    raise SoakInvariantError(
                        f"runner liveness gap {gap:.3f}s exceeded {max_allowed_gap:.3f}s"
                    )
            if stop_requested.is_set():
                raise InterruptedError("wall-clock soak interrupted by signal")
            if now >= deadline:
                break
            if now < next_cycle_at:
                try:
                    await asyncio.wait_for(
                        stop_requested.wait(), timeout=next_cycle_at - now
                    )
                except asyncio.TimeoutError:
                    pass
                continue

            cycle = counters["cycles"]
            last_cycle_started = time.monotonic()
            buy_key = f"wall-clock:{cycle}:BTC:BUY"
            sell_key = f"wall-clock:{cycle}:BTC:SELL"
            buy_price = 50_000 + cycle % 17
            sell_price = buy_price + 100

            bought = await bot.execute_order(
                "BTC", bot.Signal.BUY, buy_price, status, buy_key
            )
            if bought is None:
                raise SoakInvariantError("unique paper BUY did not commit")

            duplicate_status = _fresh_status(bot)
            duplicate = await bot.execute_order(
                "BTC", bot.Signal.BUY, buy_price, duplicate_status, buy_key
            )
            if duplicate is not None:
                raise SoakInvariantError("duplicate paper BUY committed")
            if duplicate_status.trade_count or duplicate_status.positions:
                raise SoakInvariantError("duplicate paper BUY mutated memory")
            counters["duplicate_replays"] += 1

            sold = await bot.execute_order(
                "BTC", bot.Signal.SELL, sell_price, status, sell_key
            )
            if sold is None or status.positions:
                raise SoakInvariantError("paper SELL did not close the position")

            counters["cycles"] += 1

            if counters["cycles"] % args.fault_every_cycles == 0:
                await _market_fault_probe(bot, status, counters["market_fault_cycles"])
                counters["market_fault_cycles"] += 1

            if counters["cycles"] % args.reconnect_every_cycles == 0:
                session_index += 1
                next_session = f"wall-clock-paper-{session_index}"
                restarted = safety_module.SafetyController(state_path)
                _expect_safety_code(
                    lambda: restarted.start_session(next_session),
                    "reconciliation_required",
                )
                bot._safety = restarted
                await _expect_blocked_order(
                    bot,
                    f"wall-clock:blocked-reconnect:{counters['cycles']}",
                    "reconciliation_required",
                )
                counters["blocked_attempts"] += 1
                restarted.acknowledge_reconciliation("RECONCILE_PAPER_STATE")
                restarted.start_session(next_session)
                session_id = next_session
                counters["reconnects"] += 1

            if counters["cycles"] % args.kill_every_cycles == 0:
                bot._safety.trigger_kill_switch(
                    f"wall-clock paper kill probe {counters['cycles']}"
                )
                restarted = safety_module.SafetyController(state_path)
                bot._safety = restarted
                await _expect_blocked_order(
                    bot,
                    f"wall-clock:blocked-kill:{counters['cycles']}",
                    "kill_switch_active",
                )
                counters["blocked_attempts"] += 1
                restarted.reset_kill_switch("RESET_PAPER_KILL_SWITCH")
                counters["kill_cycles"] += 1

            value = checkpoint()
            if counters["cycles"] == 1 or counters["cycles"] % 60 == 0:
                print(
                    "WALL_CLOCK_SOAK_CHECKPOINT "
                    f"cycles={counters['cycles']} rows={value['ledger']['rows']} "
                    f"elapsed={value['elapsed_seconds']}",
                    flush=True,
                )
            next_cycle_at = last_cycle_started + args.tick_seconds

        if counters["cycles"] < minimum_cycles:
            raise SoakInvariantError(
                f"only {counters['cycles']} cycles completed; required {minimum_cycles}"
            )

        historical = _fresh_status(bot)
        replay = await bot.execute_order(
            "BTC", bot.Signal.BUY, 50_000, historical, "wall-clock:0:BTC:BUY"
        )
        counters["duplicate_replays"] += 1
        if replay is not None or historical.trade_count or historical.positions:
            raise SoakInvariantError("historical replay bypassed durable ledger idempotency")

        ledger = _ledger_stats(ledger_path)
        expected_rows = counters["cycles"] * 2
        if ledger["rows"] != expected_rows:
            raise SoakInvariantError(
                f"ledger row count {ledger['rows']} did not match {expected_rows}"
            )
        if ledger["rows"] != ledger["distinct_ids"] or ledger["non_paper_rows"]:
            raise SoakInvariantError("temporary ledger uniqueness or paper-only invariant failed")
        if status.positions:
            raise SoakInvariantError("paper position remained open at completion")
        if _file_fingerprint(user_db_path) != user_db_baseline:
            raise SoakInvariantError("read-only user DB fingerprint changed during soak")
        for path in source_paths:
            if _sha256(path) != source_baseline[path.name]["sha256"]:
                raise SoakInvariantError(f"source changed during soak: {path.name}")
        if counters["network_attempts"]:
            raise SoakInvariantError("network access was attempted during paper soak")

        bot._safety.end_session(session_id)
        result_status = "passed"
        value = checkpoint()
        print(
            "WALL_CLOCK_SOAK_PASSED "
            f"cycles={counters['cycles']} rows={value['ledger']['rows']} "
            f"elapsed={value['elapsed_seconds']} evidence={evidence_path}",
            flush=True,
        )
        return 0
    except InterruptedError as exc:
        result_status = "interrupted"
        error = str(exc)
        try:
            bot._safety.trigger_kill_switch("wall-clock paper soak interrupted")
        finally:
            checkpoint()
        print(f"WALL_CLOCK_SOAK_INTERRUPTED evidence={evidence_path}", flush=True)
        return 130
    except Exception as exc:
        result_status = "failed"
        error = f"{type(exc).__name__}: {exc}"
        try:
            bot._safety.trigger_kill_switch("wall-clock paper soak invariant failure")
        finally:
            checkpoint()
        print(f"WALL_CLOCK_SOAK_FAILED error={error} evidence={evidence_path}", flush=True)
        return 1
    finally:
        network_guard_active = False


def main() -> int:
    args = _parse_args()
    return asyncio.run(_run(args))


if __name__ == "__main__":
    raise SystemExit(main())
