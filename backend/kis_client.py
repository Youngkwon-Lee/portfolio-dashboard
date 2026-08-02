"""
KIS (한국투자증권) Open API 클라이언트
MVP 정책: 모의투자(VTS) 조회만 허용하며 계좌·주문 경로는 차단한다.
"""
import os
import time
import httpx
from dotenv import load_dotenv
from trading_safety import LiveTradingBlocked

load_dotenv()

ENV = "vts"
BASE_URL = "https://openapivts.koreainvestment.com:29443"

APP_KEY = os.getenv("KIS_APP_KEY", "")
APP_SECRET = os.getenv("KIS_APP_SECRET", "")
ACCOUNT_NO = os.getenv("KIS_ACCOUNT_NO", "")
ACCOUNT_PROD = os.getenv("KIS_ACCOUNT_PROD_CODE", "01")

# 토큰 캐시 (프로세스 내 메모리)
_token_cache: dict = {"access_token": "", "expires_at": 0}


async def get_access_token() -> str:
    """OAuth2 Bearer 토큰 발급 (캐시 24h)."""
    if _token_cache["access_token"] and time.time() < _token_cache["expires_at"]:
        return _token_cache["access_token"]

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{BASE_URL}/oauth2/tokenP",
            json={
                "grant_type": "client_credentials",
                "appkey": APP_KEY,
                "appsecret": APP_SECRET,
            },
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()

    _token_cache["access_token"] = data["access_token"]
    _token_cache["expires_at"] = time.time() + 86000  # 만료 1분 전 갱신
    return _token_cache["access_token"]


async def _get(path: str, tr_id: str, params: dict) -> dict:
    """KIS REST GET 요청 공통 헬퍼."""
    token = await get_access_token()
    headers = {
        "authorization": f"Bearer {token}",
        "appkey": APP_KEY,
        "appsecret": APP_SECRET,
        "tr_id": tr_id,
        "content-type": "application/json; charset=utf-8",
    }
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{BASE_URL}{path}", headers=headers, params=params, timeout=10
        )
        resp.raise_for_status()
        return resp.json()


# ──────────────────────────────────────────────
# 국내 주식 API
# ──────────────────────────────────────────────

async def get_stock_price(ticker: str) -> dict:
    """현재가 조회 (국내)."""
    data = await _get(
        "/uapi/domestic-stock/v1/quotations/inquire-price",
        tr_id="FHKST01010100",
        params={"FID_COND_MRKT_DIV_CODE": "J", "FID_INPUT_ISCD": ticker},
    )
    o = data.get("output", {})
    return {
        "ticker": ticker,
        "name": o.get("hts_kor_isnm", ""),
        "current_price": int(o.get("stck_prpr", 0)),
        "change": int(o.get("prdy_vrss", 0)),
        "change_pct": float(o.get("prdy_ctrt", 0)),
        "volume": int(o.get("acml_vol", 0)),
        "high": int(o.get("stck_hgpr", 0)),
        "low": int(o.get("stck_lwpr", 0)),
        "open": int(o.get("stck_oprc", 0)),
    }


async def get_daily_chart(ticker: str, start: str, end: str) -> list[dict]:
    """일봉 데이터 조회 (국내). start/end: YYYYMMDD."""
    data = await _get(
        "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice",
        tr_id="FHKST03010100",
        params={
            "FID_COND_MRKT_DIV_CODE": "J",
            "FID_INPUT_ISCD": ticker,
            "FID_INPUT_DATE_1": start,
            "FID_INPUT_DATE_2": end,
            "FID_PERIOD_DIV_CODE": "D",
            "FID_ORG_ADJ_PRC": "0",
        },
    )
    return [
        {
            "date": r["stck_bsop_date"],
            "open": int(r["stck_oprc"]),
            "high": int(r["stck_hgpr"]),
            "low": int(r["stck_lwpr"]),
            "close": int(r["stck_clpr"]),
            "volume": int(r["acml_vol"]),
        }
        for r in data.get("output2", [])
    ]


# ──────────────────────────────────────────────
# 계좌 API
# ──────────────────────────────────────────────

async def get_balance() -> dict:
    """Authenticated account access is outside the paper MVP boundary."""
    raise LiveTradingBlocked("KIS 계좌 인증 조회는 paper MVP에서 차단됩니다.")


# ──────────────────────────────────────────────
# 주문 API
# ──────────────────────────────────────────────

async def place_order(ticker: str, side: str, qty: int, price: int = 0) -> dict:
    """All KIS order submission is hard-blocked in this MVP."""
    raise LiveTradingBlocked("KIS 주문 제출은 paper MVP에서 차단됩니다.")
