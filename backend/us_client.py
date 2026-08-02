"""
미국 주식 & 암호화폐 가격 조회
- 미국 주식/ETF: yfinance (Yahoo Finance, 무료·키 불필요)
- 암호화폐 현재가: CoinGecko Public API (fallback)
- 암호화폐 차트:  Binance Klines API (무료·키 불필요·레이트리밋 없음)
"""
import asyncio
import time
from datetime import datetime, timedelta
import httpx

_CHART_CACHE_TTL_SECONDS = 60.0
_chart_cache: dict[tuple[str, str], tuple[float, list[dict]]] = {}

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
    cache_key = (ticker.upper(), period)
    now = time.monotonic()
    cached = _chart_cache.get(cache_key)
    if cached and now - cached[0] < _CHART_CACHE_TTL_SECONDS:
        return [c.copy() for c in cached[1]]

    loop = asyncio.get_event_loop()
    candles = await loop.run_in_executor(None, _yf_chart_sync, ticker, period)
    _chart_cache[cache_key] = (time.monotonic(), candles)
    return [c.copy() for c in candles]


async def get_us_prices_bulk(tickers: list[str]) -> list[dict]:
    tasks = [get_us_price(t) for t in tickers]
    return await asyncio.gather(*tasks, return_exceptions=True)


# ─────────────────────────────────────────────────
# 암호화폐 — Binance Klines (차트, 기본 소스)
# ─────────────────────────────────────────────────

BINANCE_BASE = "https://api.binance.com"

# 티커 → Binance 심볼 매핑
BINANCE_SYMBOL_MAP = {
    "BTC":   "BTCUSDT",
    "ETH":   "ETHUSDT",
    "BNB":   "BNBUSDT",
    "SOL":   "SOLUSDT",
    "XRP":   "XRPUSDT",
    "ADA":   "ADAUSDT",
    "DOGE":  "DOGEUSDT",
    "DOT":   "DOTUSDT",
    "AVAX":  "AVAXUSDT",
    "MATIC": "MATICUSDT",
    "LINK":  "LINKUSDT",
    "UNI":   "UNIUSDT",
    "ATOM":  "ATOMUSDT",
    "LTC":   "LTCUSDT",
}

PERIOD_TO_LIMIT = {
    "1M":  30,
    "3M":  90,
    "6M": 180,
    "1Y": 365,
}


async def get_crypto_chart_binance(ticker: str, period: str = "1M") -> list[dict]:
    """Binance Klines로 암호화폐 일봉 OHLCV 조회 (무제한·키 불필요)."""
    symbol = BINANCE_SYMBOL_MAP.get(ticker.upper(), f"{ticker.upper()}USDT")
    limit  = PERIOD_TO_LIMIT.get(period, 30)

    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(
            f"{BINANCE_BASE}/api/v3/klines",
            params={"symbol": symbol, "interval": "1d", "limit": limit},
        )
        resp.raise_for_status()
        raw = resp.json()

    candles = []
    for k in raw:
        ts   = int(k[0])
        dt   = datetime.fromtimestamp(ts / 1000)
        candles.append({
            "date":   dt.strftime("%Y-%m-%d"),
            "open":   float(k[1]),
            "high":   float(k[2]),
            "low":    float(k[3]),
            "close":  float(k[4]),
            "volume": float(k[5]),
        })
    return candles


async def get_crypto_price_binance(ticker: str) -> dict:
    """Binance 현재가 (24h ticker)."""
    symbol = BINANCE_SYMBOL_MAP.get(ticker.upper(), f"{ticker.upper()}USDT")

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            f"{BINANCE_BASE}/api/v3/ticker/24hr",
            params={"symbol": symbol},
        )
        resp.raise_for_status()
        d = resp.json()

    curr       = float(d["lastPrice"])
    change_pct = float(d["priceChangePercent"])
    prev       = float(d["openPrice"])
    return {
        "ticker":        ticker.upper(),
        "name":          ticker.upper(),
        "current_price": curr,
        "change":        round(curr - prev, 6),
        "change_pct":    round(change_pct, 2),
        "volume":        float(d["quoteVolume"]),
        "high":          float(d["highPrice"]),
        "low":           float(d["lowPrice"]),
        "currency":      "USD",
    }


# ─────────────────────────────────────────────────
# 암호화폐 — CoinGecko (fallback / KRW 환산용)
# ─────────────────────────────────────────────────

COINGECKO_BASE = "https://api.coingecko.com/api/v3"

COIN_ID_MAP = {
    "BTC":   "bitcoin",
    "ETH":   "ethereum",
    "BNB":   "binancecoin",
    "SOL":   "solana",
    "XRP":   "ripple",
    "ADA":   "cardano",
    "DOGE":  "dogecoin",
    "DOT":   "polkadot",
    "AVAX":  "avalanche-2",
    "MATIC": "matic-network",
}


async def get_crypto_price_coingecko(ticker: str, vs_currency: str = "krw") -> dict:
    """CoinGecko 현재가 (KRW 기본, fallback)."""
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

    curr       = data.get(vs_currency, 0)
    change_pct = data.get(f"{vs_currency}_24h_change", 0)
    prev       = curr / (1 + change_pct / 100) if change_pct != -100 else curr
    return {
        "ticker":        ticker.upper(),
        "name":          coin_id.capitalize(),
        "current_price": curr,
        "change":        round(curr - prev, 2),
        "change_pct":    round(change_pct, 2),
        "volume":        data.get(f"{vs_currency}_24h_vol", 0),
        "currency":      vs_currency.upper(),
    }


# ─────────────────────────────────────────────────
# 공개 API (Binance 우선, CoinGecko fallback)
# ─────────────────────────────────────────────────

async def get_crypto_price(ticker: str, vs_currency: str = "usd") -> dict:
    """현재가: Binance 우선, 실패 시 CoinGecko fallback."""
    try:
        return await get_crypto_price_binance(ticker)
    except Exception:
        return await get_crypto_price_coingecko(ticker, vs_currency)


async def get_crypto_chart(ticker: str, period: str = "1M", vs_currency: str = "usd") -> list[dict]:
    """차트: Binance Klines 우선, 실패 시 CoinGecko fallback."""
    try:
        return await get_crypto_chart_binance(ticker, period)
    except Exception:
        return await _get_crypto_chart_coingecko(ticker, period, vs_currency)


async def _get_crypto_chart_coingecko(ticker: str, period: str, vs_currency: str) -> list[dict]:
    coin_id  = COIN_ID_MAP.get(ticker.upper(), ticker.lower())
    days_map = {"1M": 30, "3M": 90, "6M": 180, "1Y": 365}
    days     = days_map.get(period, 30)

    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(
            f"{COINGECKO_BASE}/coins/{coin_id}/market_chart",
            params={"vs_currency": vs_currency, "days": days, "interval": "daily"},
        )
        resp.raise_for_status()
        data = resp.json()

    prices  = data.get("prices", [])
    volumes = {int(v[0]): v[1] for v in data.get("total_volumes", [])}
    candles = []
    for ts, price in prices:
        dt = datetime.fromtimestamp(ts / 1000)
        candles.append({
            "date":   dt.strftime("%Y-%m-%d"),
            "open":   price, "high": price,
            "low":    price, "close": price,
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
    results = []
    for name, symbol in GLOBAL_INDEX_TICKERS.items():
        try:
            data = await get_us_price(symbol)
            results.append({
                "name":       name,
                "value":      data["current_price"],
                "change_pct": data["change_pct"],
            })
        except Exception as e:
            results.append({"name": name, "error": str(e)})
    return results
