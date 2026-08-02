"""
Upbit REST API 클라이언트
────────────────────────────────────────────
공개 API  : 키 불필요 (시세, 차트)
계좌 API  : paper MVP 정책으로 차단

지원 기능
  - KRW 마켓 전체 목록
  - 현재가 (단일/복수)
  - 일봉 차트
  - 계좌 잔고 (차단)
  - 주문 (차단)
"""

from typing import Optional
import httpx
from trading_safety import LiveTradingBlocked

UPBIT_BASE = "https://api.upbit.com/v1"

# ── 공개 API (키 불필요) ──────────────────────────

async def get_markets() -> list[dict]:
    """KRW 마켓 전체 목록."""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(f"{UPBIT_BASE}/market/all", params={"isDetails": "false"})
        resp.raise_for_status()
        return [m for m in resp.json() if m["market"].startswith("KRW-")]


async def get_ticker(markets: list[str]) -> list[dict]:
    """현재가 (복수 조회)."""
    market_str = ",".join(markets)
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(f"{UPBIT_BASE}/ticker", params={"markets": market_str})
        resp.raise_for_status()
        raw = resp.json()
    result = []
    for t in raw:
        result.append({
            "ticker":        t["market"].replace("KRW-", ""),
            "market":        t["market"],
            "current_price": t["trade_price"],
            "change_pct":    t["signed_change_rate"] * 100,
            "change":        t["signed_change_price"],
            "volume":        t["acc_trade_volume_24h"],
            "high":          t["high_price"],
            "low":           t["low_price"],
            "open":          t["opening_price"],
            "currency":      "KRW",
        })
    return result


async def get_candles(market: str, period: str = "1M") -> list[dict]:
    """일봉 차트."""
    days_map = {"1M": 30, "3M": 90, "6M": 180, "1Y": 365}
    count = days_map.get(period, 30)
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(
            f"{UPBIT_BASE}/candles/days",
            params={"market": market, "count": min(count, 200)},
        )
        resp.raise_for_status()
        raw = resp.json()
    return [
        {
            "date":   c["candle_date_time_kst"][:10],
            "open":   c["opening_price"],
            "high":   c["high_price"],
            "low":    c["low_price"],
            "close":  c["trade_price"],
            "volume": c["candle_acc_trade_volume"],
        }
        for c in reversed(raw)
    ]


# ── 인증 API ──────────────────────────────────────

async def get_balance() -> dict:
    """Authenticated account access is outside the paper MVP boundary."""
    raise LiveTradingBlocked("Upbit 계좌 인증 조회는 paper MVP에서 차단됩니다.")


async def place_order(
    market:     str,
    side:       str,   # "bid"=매수, "ask"=매도
    price:      Optional[float] = None,
    volume:     Optional[float] = None,
    order_type: str = "limit",  # limit | price(시장가 매수) | market(시장가 매도)
) -> dict:
    """All Upbit order submission is hard-blocked in this MVP."""
    raise LiveTradingBlocked("Upbit 주문 제출은 paper MVP에서 차단됩니다.")
