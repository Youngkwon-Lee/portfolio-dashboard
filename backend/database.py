"""
SQLite 영속 저장소
────────────────────────────────────────────
테이블
  trades     : 매매 내역 (봇 재시작 후에도 유지)
  bot_state  : 봇 설정 + 자본 상태 스냅샷
  daily_pnl  : 일별 손익 (리포트용)
"""

import os
import json
import aiosqlite
from datetime import datetime, timezone

DB_PATH = os.getenv(
    "PORTFOLIO_DB_PATH",
    os.path.join(os.path.dirname(__file__), "portfolio.db"),
)


async def init_db():
    """앱 시작 시 테이블 생성."""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.executescript("""
            CREATE TABLE IF NOT EXISTS trades (
                id          TEXT PRIMARY KEY,
                symbol      TEXT NOT NULL,
                side        TEXT NOT NULL,
                qty         REAL NOT NULL,
                price       REAL NOT NULL,
                cost        REAL NOT NULL,
                mode        TEXT NOT NULL,
                strategy    TEXT NOT NULL,
                pnl         REAL DEFAULT 0,
                pnl_pct     REAL DEFAULT 0,
                timestamp   TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS bot_state (
                key         TEXT PRIMARY KEY,
                value       TEXT NOT NULL,
                updated_at  TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS daily_pnl (
                date        TEXT PRIMARY KEY,
                pnl         REAL NOT NULL,
                pnl_pct     REAL NOT NULL,
                trade_count INTEGER DEFAULT 0,
                capital     REAL NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_trades_ts ON trades(timestamp DESC);
            CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);
        """)
        await db.commit()


# ── 매매 내역 ─────────────────────────────────────

async def save_trade(trade: dict) -> bool:
    """Persist a paper trade once and report whether a row was inserted.

    The deterministic trade ID is the durable idempotency boundary. A replay
    may fall outside the bounded safety-state cache, but it must never replace
    or re-apply an existing ledger row.
    """
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute("""
            INSERT INTO trades
            (id, symbol, side, qty, price, cost, mode, strategy, pnl, pnl_pct, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO NOTHING
        """, (
            trade["id"], trade["symbol"], trade["side"],
            trade["qty"], trade["price"], trade["cost"],
            trade["mode"], trade["strategy"],
            trade.get("pnl", 0), trade.get("pnl_pct", 0),
            trade["timestamp"],
        ))
        await db.commit()
        return cursor.rowcount == 1


async def load_trades(limit: int = 200, symbol: str = "") -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        if symbol:
            cur = await db.execute(
                "SELECT * FROM trades WHERE symbol=? ORDER BY timestamp DESC LIMIT ?",
                (symbol, limit)
            )
        else:
            cur = await db.execute(
                "SELECT * FROM trades ORDER BY timestamp DESC LIMIT ?", (limit,)
            )
        rows = await cur.fetchall()
        return [dict(r) for r in rows]


async def get_trade_stats() -> dict:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute("""
            SELECT
                COUNT(*) as total,
                SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
                SUM(pnl) as total_pnl,
                SUM(cost) as total_cost,
                AVG(pnl_pct) as avg_pnl_pct
            FROM trades WHERE side='SELL'
        """)
        row = await cur.fetchone()
        return dict(row) if row else {}


# ── 봇 상태 ───────────────────────────────────────

async def save_state(key: str, value: object):
    now = datetime.now(timezone.utc).isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT OR REPLACE INTO bot_state (key, value, updated_at) VALUES (?, ?, ?)",
            (key, json.dumps(value), now)
        )
        await db.commit()


async def load_state(key: str, default=None):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute("SELECT value FROM bot_state WHERE key=?", (key,))
        row = await cur.fetchone()
        if row:
            return json.loads(row["value"])
        return default


# ── 일별 손익 ─────────────────────────────────────

async def upsert_daily_pnl(pnl: float, pnl_pct: float, trade_count: int, capital: float):
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            INSERT OR REPLACE INTO daily_pnl (date, pnl, pnl_pct, trade_count, capital)
            VALUES (?, ?, ?, ?, ?)
        """, (today, pnl, pnl_pct, trade_count, capital))
        await db.commit()


async def load_daily_pnl(days: int = 30) -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            "SELECT * FROM daily_pnl ORDER BY date DESC LIMIT ?", (days,)
        )
        rows = await cur.fetchall()
        return [dict(r) for r in reversed(rows)]
