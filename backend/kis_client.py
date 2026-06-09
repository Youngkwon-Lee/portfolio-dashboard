"""
KIS (한국투자증권) Open API 클라이언트
모의투자: https://openapivts.koreainvestment.com:29443
실투자:   https://openapi.koreainvestment.com:9443
"""
import os
import time
import httpx
from dotenv import load_dotenv

load_dotenv()

ENV = os.getenv("KIS_ENV", "vts")
BASE_URL = (
    "https://openapivts.koreainvestment.com:29443"
    if ENV == "vts"
    else "https://openapi.koreainvestment.com:9443"
)

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


async def _post(path: str, tr_id: str, body: dict) -> dict:
    """KIS REST POST 요청 공통 헬퍼."""
    token = await get_access_token()
    headers = {
        "authorization": f"Bearer {token}",
        "appkey": APP_KEY,
        "appsecret": APP_SECRET,
        "tr_id": tr_id,
        "content-type": "application/json; charset=utf-8",
    }
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{BASE_URL}{path}", headers=headers, json=body, timeout=10
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
    """잔고 조회 (모의투자)."""
    tr_id = "VTTC8434R" if ENV == "vts" else "TTTC8434R"
    data = await _get(
        "/uapi/domestic-stock/v1/trading/inquire-balance",
        tr_id=tr_id,
        params={
            "CANO": ACCOUNT_NO,
            "ACNT_PRDT_CD": ACCOUNT_PROD,
            "AFHR_FLPR_YN": "N",
            "OFL_YN": "",
            "INQR_DVSN": "02",
            "UNPR_DVSN": "01",
            "FUND_STTL_ICLD_YN": "N",
            "FNCG_AMT_AUTO_RDPT_YN": "N",
            "PRCS_DVSN": "01",
            "CTX_AREA_FK100": "",
            "CTX_AREA_NK100": "",
        },
    )
    holdings = [
        {
            "ticker": h["pdno"],
            "name": h["prdt_name"],
            "qty": int(h["hldg_qty"]),
            "avg_cost": float(h["pchs_avg_pric"]),
            "current_price": int(h["prpr"]),
            "value": int(h["evlu_amt"]),
            "return_pct": float(h["evlu_pfls_rt"]),
        }
        for h in data.get("output1", [])
        if int(h.get("hldg_qty", 0)) > 0
    ]
    summary = data.get("output2", [{}])[0]
    return {
        "holdings": holdings,
        "total_value": int(summary.get("tot_evlu_amt", 0)),
        "total_cost": int(summary.get("pchs_amt_smtl_amt", 0)),
        "cash": int(summary.get("dnca_tot_amt", 0)),
        "pnl": int(summary.get("evlu_pfls_smtl_amt", 0)),
        "pnl_pct": float(summary.get("evlu_pfls_smtl_rt", 0)),
    }


# ──────────────────────────────────────────────
# 주문 API
# ──────────────────────────────────────────────

async def place_order(ticker: str, side: str, qty: int, price: int = 0) -> dict:
    """
    주문 실행.
    side: 'buy' | 'sell'
    price=0 → 시장가
    """
    if ENV == "vts":
        tr_id = "VTTC0802U" if side == "buy" else "VTTC0801U"
    else:
        tr_id = "TTTC0802U" if side == "buy" else "TTTC0801U"

    order_dvsn = "01" if price == 0 else "00"  # 01=시장가, 00=지정가

    data = await _post(
        "/uapi/domestic-stock/v1/trading/order-cash",
        tr_id=tr_id,
        body={
            "CANO": ACCOUNT_NO,
            "ACNT_PRDT_CD": ACCOUNT_PROD,
            "PDNO": ticker,
            "ORD_DVSN": order_dvsn,
            "ORD_QTY": str(qty),
            "ORD_UNPR": str(price),
        },
    )
    return {
        "order_no": data.get("output", {}).get("ODNO", ""),
        "status": "ok" if data.get("rt_cd") == "0" else "error",
        "message": data.get("msg1", ""),
    }
