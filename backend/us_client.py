"""
미국 주식 & 암호화폐 가격 조회
- 미국 주식/ETF: yfinance (Yahoo Finance, 무료·키 불필요)
- 암호화폐: CoinGecko Public API (무료·키 불필요)
"""
import asyncio
from datetime import datetime, timedelta
from functools import lru_cache
import httpx

# ─────────────────────────────────────────────────
# 미국 주식 (yfinance는 동기 라이브러리 → run_in_executor)
# ─────────────────────────────────────────────────

def _yf_price_sync(ticker: str) -> dict:
    import yfinance as yf
    t = yf.Ticker(ticker)
    info = t.fast_info
    prev = info.previous_close or 0
    curr = info.last_price or 0
    change = curr - prev
    change_pct = (change / prev * 100) if prev else 0
    return {
        "ticker": ticker,
        "name": t.info.get("shortName", ticker),
        "current_price": round(curr, 2),
        "change": round(change, 2),
        "change_pct": round(change_pct, 2),
        "volume": info.three_month_average_volume or 0,
        "high": info.day_high or 0,
        "low": info.day_low or 0,
        "open": info.open or 0,
        "market_cap": info.market_cap or 0,
        "currency": info.currency or "USD",
    }


def _yf_chart_sync(ticker: str, period: str) -> list[dict]:
    import yfinance as yf
    period_map = {"1M": "1mo", "3M": "3mo", "6M": "6mo", "1Y": "1y"}
    hist = yf.Ticker(ticker).history(period=period_map.get(period, "1mo"))
    result = []
    for idx, row in hist.iterrows():
        result.append({
            "date": idx.strftime("%Y-%m-%d"),
            "open":   round(float(row["Open"]), 2),
            "high":   round(float(row["High"]), 2),
            "low":    round(float(row["Low"]), 2),
            "close":  round(float(row["Close"]), 2),
            "volume": int(row["Volume"]),
        })
    return result


async def get_us_price(ticker: str) -> dict:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _yf_price_sync, ticker)


async def get_us_chart(ticker: str, period: str = "1M") -> list[dict]:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _yf_chart_sync, ticker, period)


async def get_us_prices_bulk(tickers: list[str]) -> list[dict]:
    """여러 미국 종목 동시 조회."""
    tasks = [get_us_price(t) for t in tickers]
    return await asyncio.gather(*tasks, return_exceptions=True)


# ─────────────────────────────────────────────────
# 암호화폐 (CoinGecko Public API)
# ─────────────────────────────────────────────────

COINGECKO_BASE = "https://api.coingecko.com/api/v3"

# 티커 → CoinGecko ID 매핑
COIN_ID_MAP = {
    "BTC": "bitcoin",
    "ETH": "ethereum",
    "BNB": "binancecoin",
    "SOL": "solana",
    "XRP": "ripple",
    "ADA": "cardano",
    "DOGE": "dogecoin",
    "DOT": "polkadot",
    "AVAX": "avalanche-2",
    "MATIC": "matic-network",
}


async def get_crypto_price(ticker: str, vs_currency: str = "krw") -> dict:
    """암호화폐 현재가 (KRW 기본)."""
    coin_id = COIN_ID_MAP.get(ticker.upper(), ticker.lower())
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            f"{COINGECKO_BASE}/simple/price",
            params={
                "ids": coin_id,
                "vs_currencies": vs_currency,
                "include_24hr_change": "true",
                "include_24hr_vol": "true",
            },
        )
        resp.raise_for_status()
        data = resp.json().get(coin_id, {})

    curr = data.get(vs_currency, 0)
    change_pct = data.get(f"{vs_currency}_24h_change", 0)
    prev = curr / (1 + change_pct / 100) if change_pct != -100 else curr
    return {
        "ticker": ticker.upper(),
        "name": coin_id.capitalize(),
        "current_price": curr,
        "change": round(curr - prev, 2),
        "change_pct": round(change_pct, 2),
        "volume": data.get(f"{vs_currency}_24h_vol", 0),
        "currency": vs_currency.upper(),
    }


async def get_crypto_chart(ticker: str, period: str = "1M", vs_currency: str = "krw") -> list[dict]:
    """암호화폐 일봉 차트 (CoinGecko market_chart)."""
    coin_id = COIN_ID_MAP.get(ticker.upper(), ticker.lower())
    days_map = {"1M": 30, "3M": 90, "6M": 180, "1Y": 365}
    days = days_map.get(period, 30)

    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(
            f"{COINGECKO_BASE}/coins/{coin_id}/market_chart",
            params={"vs_currency": vs_currency, "days": days, "interval": "daily"},
        )
        resp.raise_for_status()
        data = resp.json()

    prices = data.get("prices", [])
    volumes = {int(v[0]): v[1] for v in data.get("total_volumes", [])}

    candles = []
    for ts, price in prices:
        dt = datetime.fromtimestamp(ts / 1000)
        candles.append({
            "date": dt.strftime("%Y-%m-%d"),
            "open": price,
            "high": price,
            "low": price,
            "close": price,
            "volume": volumes.get(ts, 0),
        })
    return candles


# ─────────────────────────────────────────────────
# 글로벌 지수 (Yahoo Finance)
# ─────────────────────────────────────────────────

GLOBAL_INDEX_TICKERS = {
    "S&P 500": "^GSPC",
    "NASDAQ":  "^IXIC",
    "DOW":     "^DJI",
    "VIX":     "^VIX",
}


async def get_global_indices() -> list[dict]:
    """미국 주요 지수 현재가."""
    results = []
    for name, symbol in GLOBAL_INDEX_TICKERS.items():
        try:
            data = await get_us_price(symbol)
            results.append({
                "name": name,
                "value": data["current_price"],
                "change_pct": data["change_pct"],
            })
        except Exception as e:
            results.append({"name": name, "error": str(e)})
    return results
