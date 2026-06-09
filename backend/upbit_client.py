"""
Upbit REST API 클라이언트
────────────────────────────────────────────
공개 API  : 키 불필요 (시세, 차트)
계좌 API  : UPBIT_ACCESS_KEY + UPBIT_SECRET_KEY 필요
  발급: https://upbit.com/mypage/open_api_management

지원 기능
  - KRW 마켓 전체 목록
  - 현재가 (단일/복수)
  - 일봉 차트
  - 계좌 잔고 (인증 필요)
  - 주문 (인증 필요)
"""

import os
import uuid
import hashlib
import hmac
import time
import jwt
from typing import Optional
import httpx

UPBIT_BASE = "https://api.upbit.com/v1"


def _access_key() -> str: return os.getenv("UPBIT_ACCESS_KEY", "")
def _secret_key() -> str: return os.getenv("UPBIT_SECRET_KEY", "")


def _auth_header(query_string: str = "") -> dict:
    """JWT 인증 헤더 생성."""
    payload: dict = {
        "access_key": _access_key(),
        "nonce":      str(uuid.uuid4()),
    }
    if query_string:
        m = hashlib.sha512()
        m.update(query_string.encode())
        payload["query_hash"]         = m.hexdigest()
        payload["query_hash_alg"]     = "SHA512"

    token = jwt.encode(payload, _secret_key(), algorithm="HS256")
    return {"Authorization": f"Bearer {token}"}


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
    """계좌 잔고."""
    if not _access_key():
        raise ValueError("UPBIT_ACCESS_KEY 없음. .env에 설정 필요.")
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            f"{UPBIT_BASE}/accounts",
            headers=_auth_header(),
        )
        resp.raise_for_status()
        raw = resp.json()

    holdings = []
    total_value = 0.0
    krw_balance = 0.0

    for acc in raw:
        currency = acc["currency"]
        balance  = float(acc["balance"])
        locked   = float(acc["locked"])
        avg_buy  = float(acc["avg_buy_price"] or 0)

        if currency == "KRW":
            krw_balance = balance + locked
            continue

        if balance + locked > 0:
            market = f"KRW-{currency}"
            # 현재가 조회
            try:
                ticker_data = await get_ticker([market])
                current_price = ticker_data[0]["current_price"] if ticker_data else avg_buy
            except Exception:
                current_price = avg_buy

            value      = (balance + locked) * current_price
            return_pct = ((current_price - avg_buy) / avg_buy * 100) if avg_buy > 0 else 0
            total_value += value
            holdings.append({
                "ticker":        currency,
                "name":          currency,
                "qty":           balance + locked,
                "avg_cost":      avg_buy,
                "current_price": current_price,
                "value":         value,
                "return_pct":    round(return_pct, 2),
            })

    return {
        "exchange":    "upbit",
        "krw_balance": krw_balance,
        "total_value": total_value + krw_balance,
        "holdings":    holdings,
    }


async def place_order(
    market:     str,
    side:       str,   # "bid"=매수, "ask"=매도
    price:      Optional[float] = None,
    volume:     Optional[float] = None,
    order_type: str = "limit",  # limit | price(시장가 매수) | market(시장가 매도)
) -> dict:
    """주문 실행."""
    if not _access_key():
        raise ValueError("UPBIT_ACCESS_KEY 없음")

    body: dict = {
        "market": market,
        "side":   side,
        "ord_type": order_type,
    }
    if price  is not None: body["price"]  = str(price)
    if volume is not None: body["volume"] = str(volume)

    import urllib.parse
    query_string = urllib.parse.urlencode(body)

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(
            f"{UPBIT_BASE}/orders",
            params=body,
            headers=_auth_header(query_string),
        )
        resp.raise_for_status()
        return resp.json()
