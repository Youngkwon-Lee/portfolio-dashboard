"""
포트폴리오 대시보드 FastAPI 백엔드
실행: uvicorn main:app --reload --port 8000
"""
import os
import math
from datetime import datetime, timedelta, timezone
from typing import Literal
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from dotenv import load_dotenv

import kis_client as kis
import us_client as us
import wallet_client as wallet
import backtest_engine as bt
import trading_bot as bot
import database as db
import optimizer as opt
import news_sentiment as news
import upbit_client as upbit
from trading_safety import LIVE_BLOCK_REASON, SafetyViolation
from contextlib import asynccontextmanager

load_dotenv()

@asynccontextmanager
async def lifespan(application):
    await db.init_db()
    yield

app = FastAPI(title="Portfolio Dashboard API", version="2.1.0-paper", lifespan=lifespan)


@app.exception_handler(RequestValidationError)
async def sanitized_validation_error(_: Request, exc: RequestValidationError):
    """Return validation metadata without echoing potentially sensitive input."""
    errors = [
        {key: value for key, value in error.items() if key not in {"input", "ctx"}}
        for error in exc.errors()
    ]
    return JSONResponse(status_code=422, content={"detail": errors})

app.add_middleware(
    CORSMiddleware,
    allow_origins=[os.getenv("ALLOWED_ORIGIN", "http://localhost:3000")],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── 티커 마켓 판별 헬퍼 ──────────────────────────

CRYPTO_TICKERS = {"BTC","ETH","BNB","SOL","XRP","ADA","DOGE","DOT","AVAX","MATIC"}

def detect_market(ticker: str) -> str:
    t = ticker.upper()
    if t in CRYPTO_TICKERS:         return "CRYPTO"
    if t.isdigit() and len(t) == 6: return "KRX"
    return "US"


def market_data_source(market: str) -> str:
    return {
        "KRX": "KIS VTS market data",
        "CRYPTO": "Binance public candles",
        "US": "Yahoo Finance",
    }.get(market, "Unknown provider")


# ──────────────────────────────────────────────
# Health
# ──────────────────────────────────────────────

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "version": "2.1.0-paper",
        "execution_mode": "paper",
        "live_allowed": False,
        "kis_environment": "vts",
    }


@app.get("/ping")
async def ping():
    """Render 슬립 방지용 핑 엔드포인트."""
    return "pong"


# ──────────────────────────────────────────────
# 통합 현재가 (마켓 자동 감지)
# ──────────────────────────────────────────────

@app.get("/api/price/{ticker}")
async def get_price(ticker: str, currency: str = "krw"):
    """국내/미국/크립토 현재가 — 티커로 마켓 자동 판별."""
    market = detect_market(ticker)
    try:
        if market == "KRX":
            return await kis.get_stock_price(ticker)
        elif market == "CRYPTO":
            return await us.get_crypto_price(ticker, currency)
        else:
            return await us.get_us_price(ticker)
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.get("/api/price/{ticker}/chart")
async def get_chart(
    ticker: str,
    period: str = Query("1M", pattern="^(1M|3M|6M|1Y)$"),
    currency: str = "krw",
):
    """일봉 차트 — 마켓 자동 판별."""
    market = detect_market(ticker)
    try:
        if market == "KRX":
            end = datetime.today()
            days_map = {"1M": 30, "3M": 90, "6M": 180, "1Y": 365}
            start = end - timedelta(days=days_map[period])
            candles = await kis.get_daily_chart(
                ticker, start.strftime("%Y%m%d"), end.strftime("%Y%m%d")
            )
        elif market == "CRYPTO":
            candles = await us.get_crypto_chart(ticker, period, currency)
        else:
            candles = await us.get_us_chart(ticker, period)
        return {
            "ticker": ticker,
            "market": market,
            "period": period,
            "candles": candles,
            "source": market_data_source(market),
            "fetched_at": datetime.now(timezone.utc).isoformat(),
        }
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.get("/api/prices")
async def get_multiple_prices(
    tickers: str = Query(..., description="쉼표 구분 티커 ex) 005930,AAPL,BTC"),
    currency: str = "krw",
):
    """여러 종목 현재가 일괄 (마켓 혼합 가능)."""
    ticker_list = [t.strip() for t in tickers.split(",") if t.strip()]
    results = []
    for t in ticker_list:
        market = detect_market(t)
        try:
            if market == "KRX":
                results.append(await kis.get_stock_price(t))
            elif market == "CRYPTO":
                results.append(await us.get_crypto_price(t, currency))
            else:
                results.append(await us.get_us_price(t))
        except Exception as e:
            results.append({"ticker": t, "market": market, "error": str(e)})
    return results


# ──────────────────────────────────────────────
# 계좌 / 잔고 (KIS)
# ──────────────────────────────────────────────

@app.get("/api/balance")
async def get_balance():
    raise HTTPException(
        status_code=403,
        detail="KIS 계좌 인증 조회는 paper MVP에서 차단됩니다.",
    )


# ──────────────────────────────────────────────
# 주문 (KIS 국내주식만)
# ──────────────────────────────────────────────

class OrderRequest(BaseModel):
    ticker: str
    side: str        # 'buy' | 'sell'
    qty: int
    price: int = 0   # 0 = 시장가


@app.post("/api/order")
async def place_order(req: OrderRequest):
    raise HTTPException(status_code=403, detail=LIVE_BLOCK_REASON)


# ──────────────────────────────────────────────
# 지수 (KIS 국내 + Yahoo 글로벌 + CoinGecko BTC)
# ──────────────────────────────────────────────

@app.get("/api/indices")
async def get_all_indices():
    """KOSPI/KOSDAQ + 미국 주요 지수 + BTC."""
    results = []

    # 국내 지수 (KIS)
    for name, code in [("KOSPI", "0001"), ("KOSDAQ", "1001")]:
        try:
            data = await kis._get(
                "/uapi/domestic-stock/v1/quotations/inquire-index-price",
                tr_id="FHPUP02100000",
                params={"FID_COND_MRKT_DIV_CODE": "U", "FID_INPUT_ISCD": code},
            )
            o = data.get("output", {})
            results.append({
                "name": name,
                "value": float(o.get("bstp_nmix_prpr", 0)),
                "change_pct": float(o.get("bstp_nmix_prdy_ctrt", 0)),
            })
        except Exception as e:
            results.append({"name": name, "error": str(e)})

    # 미국 지수 (Yahoo)
    global_indices = await us.get_global_indices()
    results.extend(global_indices)

    # BTC (CoinGecko)
    try:
        btc = await us.get_crypto_price("BTC", "krw")
        results.append({"name": "BTC/KRW", "value": btc["current_price"], "change_pct": btc["change_pct"]})
    except Exception as e:
        results.append({"name": "BTC/KRW", "error": str(e)})

    return results


# ──────────────────────────────────────────────
# 암호화폐 전용 엔드포인트
# ──────────────────────────────────────────────

@app.get("/api/crypto/{ticker}")
async def get_crypto(ticker: str, currency: str = "krw"):
    try:
        return await us.get_crypto_price(ticker, currency)
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.get("/api/crypto/{ticker}/chart")
async def get_crypto_chart(
    ticker: str,
    period: str = Query("1M", pattern="^(1M|3M|6M|1Y)$"),
    currency: str = "krw",
):
    try:
        candles = await us.get_crypto_chart(ticker, period, currency)
        return {"ticker": ticker, "period": period, "candles": candles}
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


# ──────────────────────────────────────────────
# AI 분석 (Claude API)
# ──────────────────────────────────────────────

from fastapi.responses import StreamingResponse
import claude_client as ai


# ──────────────────────────────────────────────
# 자동매매 봇
# ──────────────────────────────────────────────

class BotConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mode:            str   = "paper"
    strategy:        str   = "dual_mom"
    symbols:         list[str] = Field(default_factory=lambda: ["BTC", "ETH"])
    initial_capital: float = 1_000_000


class SafetyConfirmation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    confirmation: str


@app.get("/api/bot/daily-pnl")
async def bot_daily_pnl():
    return await db.load_daily_pnl(30)


# ──────────────────────────────────────────────
# 포트폴리오 최적화 (Markowitz MPT)
# ──────────────────────────────────────────────

class OptimizeRequest(BaseModel):
    tickers: list[str]
    period:  str = "1Y"


# ──────────────────────────────────────────────
# 뉴스 감성 분석
# ──────────────────────────────────────────────

@app.get("/api/news/{ticker}")
async def get_news_sentiment(ticker: str):
    return await news.analyze(ticker)


@app.get("/api/news")
async def get_portfolio_sentiment(tickers: str = Query(..., description="쉼표 구분 ex) BTC,ETH")):
    ticker_list = [t.strip() for t in tickers.split(",") if t.strip()]
    return await news.analyze_portfolio(ticker_list)


# ──────────────────────────────────────────────
# Upbit
# ──────────────────────────────────────────────

@app.get("/api/upbit/markets")
async def upbit_markets():
    return await upbit.get_markets()


@app.get("/api/upbit/ticker")
async def upbit_ticker(markets: str = Query(..., description="ex) KRW-BTC,KRW-ETH")):
    market_list = [m.strip() for m in markets.split(",") if m.strip()]
    return await upbit.get_ticker(market_list)


@app.get("/api/upbit/chart/{market}")
async def upbit_chart(market: str, period: str = Query("1M", pattern="^(1M|3M|6M|1Y)$")):
    return await upbit.get_candles(market, period)


@app.get("/api/upbit/balance")
async def upbit_balance():
    raise HTTPException(
        status_code=403,
        detail="Upbit 계좌 인증 조회는 paper MVP에서 차단됩니다.",
    )


# ──────────────────────────────────────────────
# 백테스트 vs 실거래 비교
# ──────────────────────────────────────────────

@app.get("/api/compare/{ticker}")
async def compare_backtest_to_paper(
    ticker:   str,
    strategy: str  = Query("dual_mom"),
    period:   str  = Query("1M", pattern="^(1M|3M|6M|1Y)$"),
    initial:  float = Query(1_000_000),
):
    """백테스트 이론 성과 vs paper 봇 시뮬레이션 내역 비교."""
    # 백테스트
    bars: list[bt.Bar] = []
    bt_result = None
    try:
        chart = await get_chart(ticker, period)
        candles = chart.get("candles", []) if isinstance(chart, dict) else []
        bars = [
            bt.Bar(date=c["date"], open=c["open"], high=c["high"],
                   low=c["low"], close=c["close"], volume=c.get("volume", 0))
            for c in candles
        ]
        bt_result = bt.run(bars, initial, strategy)
        bt_curve  = bt_result.curve[:50]  # 샘플링
    except Exception as e:
        bt_curve = []

    # paper 시뮬레이션 내역
    paper_trades = await db.load_trades(100, ticker)
    daily_pnl   = await db.load_daily_pnl(30)

    # paper 누적 PnL 곡선
    paper_curve = []
    cumulative = 0.0
    for t in reversed(paper_trades):
        cumulative += t.get("pnl", 0)
        paper_curve.append({"date": t["timestamp"][:10], "cumPnl": round(cumulative, 0)})

    return {
        "ticker":       ticker.upper(),
        "strategy":     strategy,
        "bt_curve":     bt_curve,
        "bt_return":    bt_result.total_return_pct if bt_result else 0,
        "bt_sharpe":    bt_result.sharpe if bt_result else 0,
        "execution_mode": "paper",
        "live_allowed": False,
        "paper_trades": paper_trades[:20],
        "paper_curve":  paper_curve,
        "daily_pnl":    daily_pnl,
        "paper_stats":  await db.get_trade_stats(),
    }


@app.post("/api/optimize")
async def optimize_portfolio(req: OptimizeRequest):
    if len(req.tickers) < 2:
        raise HTTPException(status_code=400, detail="최소 2개 종목 필요")
    if len(req.tickers) > 8:
        raise HTTPException(status_code=400, detail="최대 8개 종목까지 지원")

    price_history: dict[str, list[float]] = {}
    for ticker in req.tickers:
        try:
            res = await get_chart(ticker, req.period)
            candles = res.get("candles", []) if isinstance(res, dict) else []
            if len(candles) < 20:
                raise HTTPException(status_code=400, detail=f"{ticker} 데이터 부족")
            price_history[ticker] = [c["close"] for c in candles]
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"{ticker} 조회 실패: {e}")

    try:
        result = opt.optimize(req.tickers, price_history)
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/bot/start")
async def bot_start(cfg: BotConfig):
    if cfg.mode != "paper":
        raise HTTPException(status_code=403, detail=LIVE_BLOCK_REASON)
    if not cfg.symbols:
        raise HTTPException(status_code=400, detail="최소 한 개 종목이 필요합니다.")
    if cfg.initial_capital <= 0:
        raise HTTPException(status_code=400, detail="초기 자본은 0보다 커야 합니다.")
    try:
        bot.configure("paper", cfg.strategy, cfg.symbols, cfg.initial_capital)
        await bot.start()
    except SafetyViolation as exc:
        raise HTTPException(
            status_code=409,
            detail={"code": exc.code, "message": str(exc)},
        ) from exc
    return {
        "ok": True,
        "execution_mode": "paper",
        "live_allowed": False,
        "strategy": cfg.strategy,
    }


@app.post("/api/bot/stop")
async def bot_stop():
    await bot.stop()
    return {"ok": True}


@app.get("/api/bot/status")
async def bot_status():
    return bot.get_status()


@app.get("/api/bot/trades")
async def bot_trades():
    s = bot.get_status()
    return {"trades": s.get("trades", [])}


@app.get("/api/trading/safety")
async def trading_safety():
    return bot.get_safety_contract()


@app.post("/api/bot/kill-switch")
async def bot_kill_switch():
    await bot.activate_kill_switch()
    return {"ok": True, "safety": bot.get_safety_contract()}


@app.post("/api/bot/reconcile")
async def bot_reconcile(payload: SafetyConfirmation):
    try:
        bot.acknowledge_reconciliation(payload.confirmation)
    except SafetyViolation as exc:
        raise HTTPException(
            status_code=409,
            detail={"code": exc.code, "message": str(exc)},
        ) from exc
    return {"ok": True, "safety": bot.get_safety_contract()}


@app.post("/api/bot/safety-reset")
async def bot_safety_reset(payload: SafetyConfirmation):
    try:
        bot.reset_kill_switch(payload.confirmation)
    except SafetyViolation as exc:
        raise HTTPException(
            status_code=409,
            detail={"code": exc.code, "message": str(exc)},
        ) from exc
    return {"ok": True, "safety": bot.get_safety_contract()}


# ──────────────────────────────────────────────
# 백테스트 (논문 기반 엔진)
# ──────────────────────────────────────────────

class BacktestRequest(BaseModel):
    ticker: str = Field(
        ...,
        min_length=1,
        max_length=20,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$",
        description="Exchange ticker symbol; whitespace and control characters are rejected.",
    )
    period: Literal["1M", "3M", "6M", "1Y"] = "1Y"
    initial: float = Field(10_000_000, gt=0, le=1_000_000_000_000)
    strategy: Literal["all", "ensemble", "bah", "dual_mom", "sma_cross", "bollinger", "rsi"] = "all"
    commission_bps: float = Field(10.0, ge=0, le=500, description="편도 수수료 (basis points)")
    slippage_bps: float = Field(5.0, ge=0, le=500, description="편도 슬리피지 (basis points)")


@app.post("/api/backtest")
async def run_backtest(req: BacktestRequest):
    """논문 기반 백테스트 — look-ahead bias 제거, 수수료·슬리피지 반영."""
    try:
        chart = await get_chart(req.ticker, req.period)
    except Exception:
        raise HTTPException(status_code=502, detail="가격 데이터 조회 실패")

    candles = chart.get("candles", []) if isinstance(chart, dict) else []
    if len(candles) < 10:
        raise HTTPException(status_code=400, detail="데이터 부족 (최소 10개 캔들 필요)")
    if len(candles) < 20:
        raise HTTPException(status_code=400, detail="데이터 부족 (기간 분할 검증에 최소 20개 캔들 필요)")

    try:
        parsed_dates = [datetime.fromisoformat(str(c.get("date"))) for c in candles]
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="가격 데이터 날짜 형식이 올바르지 않습니다")
    try:
        dates_out_of_order = any(current <= previous for previous, current in zip(parsed_dates, parsed_dates[1:]))
    except TypeError:
        # naive date와 timezone-aware datetime을 섞으면 Python 비교가 실패하므로
        # 내부 500 대신 입력 오류로 닫는다.
        raise HTTPException(status_code=400, detail="가격 데이터 날짜 형식이 일관되지 않습니다")
    if dates_out_of_order:
        raise HTTPException(status_code=400, detail="가격 데이터 날짜 순서가 올바르지 않습니다")

    for candle in candles:
        try:
            open_price = float(candle["open"])
            high_price = float(candle["high"])
            low_price = float(candle["low"])
            close_price = float(candle["close"])
            volume = float(candle.get("volume", 0))
        except (KeyError, TypeError, ValueError):
            raise HTTPException(status_code=400, detail="가격 데이터 수치 형식이 올바르지 않습니다")
        if (
            not all(math.isfinite(value) for value in (open_price, high_price, low_price, close_price, volume))
            or min(open_price, high_price, low_price, close_price) <= 0
            or volume < 0
            or high_price < max(open_price, close_price)
            or low_price > min(open_price, close_price)
        ):
            raise HTTPException(status_code=400, detail="가격 데이터 OHLC 범위가 올바르지 않습니다")

    bars = [
        bt.Bar(
            date=c["date"], open=c["open"], high=c["high"],
            low=c["low"],   close=c["close"], volume=c.get("volume", 0),
        )
        for c in candles
    ]

    try:
        commission_rate = req.commission_bps / 10_000
        slippage_rate = req.slippage_bps / 10_000
        if req.strategy == "all":
            results = bt.run_all(bars, req.initial, commission_rate, slippage_rate)
        else:
            results = [bt.run(bars, req.initial, req.strategy, commission_rate, slippage_rate)]
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    split_index = int(len(bars) * 0.7)
    train_bars, test_bars = bars[:split_index], bars[split_index:]
    if req.strategy == "all":
        train_results = bt.run_all(train_bars, req.initial, commission_rate, slippage_rate)
        test_results = bt.run_all(test_bars, req.initial, commission_rate, slippage_rate)
    else:
        train_results = [bt.run(train_bars, req.initial, req.strategy, commission_rate, slippage_rate)]
        test_results = [bt.run(test_bars, req.initial, req.strategy, commission_rate, slippage_rate)]

    def serialize(r: bt.BacktestResult) -> dict:
        return {
            "strategy":         r.strategy,
            "strategy_label":   r.strategy_label,
            "initial":          r.initial,
            "final":            r.final,
            "total_return_pct": r.total_return_pct,
            "cagr":             r.cagr,
            "sharpe":           r.sharpe,
            "sortino":          r.sortino,
            "calmar":           r.calmar,
            "mdd":              r.mdd,
            "win_rate":         r.win_rate,
            "profit_factor":    r.profit_factor,
            "total_trades":     r.total_trades,
            "total_cost":       r.total_cost,
            "curve":            r.curve,
            "monthly_returns":  r.monthly_returns,
            "trades":           r.trades,
            "description":      r.description,
            "paper":            r.paper,
        }

    walk_forward = {
        "method": "expanding_window",
        "available": False,
        "folds": [],
        "summaries": [],
        "reason": "워크포워드 검증에는 최소 180개 캔들이 필요합니다",
    }
    if len(bars) >= 180:
        fold_count = 3
        test_window = max(30, len(bars) // 10)
        initial_train_end = len(bars) - fold_count * test_window
        folds = []
        for fold_index in range(fold_count):
            train_end = initial_train_end + fold_index * test_window
            test_end = train_end + test_window
            fold_bars = bars[train_end:test_end]
            fold_results = (
                bt.run_all(fold_bars, req.initial, commission_rate, slippage_rate)
                if req.strategy == "all"
                else [bt.run(fold_bars, req.initial, req.strategy, commission_rate, slippage_rate)]
            )
            folds.append({
                "fold": fold_index + 1,
                "train_end": bars[train_end - 1].date,
                "test_start": bars[train_end].date,
                "test_end": bars[test_end - 1].date,
                "test_samples": len(fold_bars),
                "results": [serialize(result) for result in fold_results],
            })
        summaries = []
        strategy_names = [result["strategy"] for result in folds[0]["results"]]
        for strategy in strategy_names:
            returns = [
                next(result["total_return_pct"] for result in fold["results"] if result["strategy"] == strategy)
                for fold in folds
            ]
            average_return = sum(returns) / len(returns)
            volatility = math.sqrt(sum((value - average_return) ** 2 for value in returns) / len(returns))
            positive_folds = sum(value > 0 for value in returns)
            summaries.append({
                "strategy": strategy,
                "average_return_pct": average_return,
                "return_volatility_pct": volatility,
                "positive_fold_ratio": positive_folds / len(returns),
                "return_range_pct": max(returns) - min(returns),
                "consistent": positive_folds >= 2,
                "promotion_eligible": (
                    positive_folds >= 2
                    and average_return > 0
                    and all(fold["test_samples"] >= 30 for fold in folds)
                ),
            })
        walk_forward = {
            "method": "expanding_window",
            "available": True,
            "folds": folds,
            "summaries": summaries,
            "reason": None,
        }

    # 단일 전략 조회에서도 동일 비용 가정의 Buy & Hold 기준선을 함께 제공한다.
    # `all` 모드에서는 이미 결과에 포함된 기준선을 재사용해 중복 계산을 피한다.
    benchmark_result = next((r for r in results if r.strategy == "bah"), None)
    if benchmark_result is None and req.strategy != "bah":
        benchmark_result = bt.run_buy_hold(
            bars,
            req.initial,
            commission_rate + slippage_rate,
        )

    train_by_strategy = {r.strategy: r for r in train_results}
    test_by_strategy = {r.strategy: r for r in test_results}
    validation = []
    for strategy, train_result in train_by_strategy.items():
        test_result = test_by_strategy[strategy]
        validation.append({
            "strategy": strategy,
            "strategy_label": test_result.strategy_label,
            "train_return_pct": train_result.total_return_pct,
            "test_return_pct": test_result.total_return_pct,
            "test_mdd": test_result.mdd,
            "test_sharpe": test_result.sharpe,
        })

    eligible_strategies = [
        summary["strategy"]
        for summary in walk_forward["summaries"]
        if summary.get("promotion_eligible")
    ]

    return {
        "ticker":  req.ticker.upper(),
        "period":  req.period,
        "execution_mode": "paper",
        "live_allowed": False,
        "costs": {
            "commission_bps": req.commission_bps,
            "slippage_bps": req.slippage_bps,
            "total_bps": req.commission_bps + req.slippage_bps,
        },
        "source": chart.get("source", "Unknown provider"),
        "fetched_at": chart.get("fetched_at"),
        "benchmark": (
            {
                "strategy": benchmark_result.strategy,
                "strategy_label": benchmark_result.strategy_label,
                "final": benchmark_result.final,
                "total_return_pct": benchmark_result.total_return_pct,
                "mdd": benchmark_result.mdd,
            }
            if benchmark_result is not None
            else None
        ),
        "validation": {
            "method": "chronological_holdout",
            "label": "시간순 홀드아웃",
            "train_ratio": 0.7,
            "train_samples": len(train_bars),
            "test_samples": len(test_bars),
            "warning": (
                "검증 표본이 30개 미만이라 Sharpe 해석에 주의가 필요합니다"
                if len(test_bars) < 30
                else None
            ),
            "train_end": train_bars[-1].date,
            "test_start": test_bars[0].date,
            "results": validation,
        },
        "walk_forward": walk_forward,
        "promotion_gate": {
            "paper_only": True,
            "minimum_positive_folds": 2,
            "minimum_test_samples_per_fold": 30,
            "requires_positive_average_return": True,
            "eligible_strategies": eligible_strategies,
            "warning": (
                "승격 조건을 만족하는 전략이 없어 HOLD 권고"
                if not eligible_strategies
                else None
            ),
        },
        "results": [serialize(r) for r in results],
    }


# ──────────────────────────────────────────────
# 지갑 / 거래소 잔고
# ──────────────────────────────────────────────

@app.get("/api/wallet/phantom/{address}")
async def get_phantom(address: str):
    """Phantom (Solana) 지갑 잔고."""
    try:
        return await wallet.get_phantom_balance(address)
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.get("/api/wallet/metamask/{address}")
async def get_metamask(address: str):
    """MetaMask (Ethereum) 지갑 잔고."""
    try:
        return await wallet.get_metamask_balance(address)
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/api/wallet/binance")
async def get_binance():
    raise HTTPException(
        status_code=403,
        detail="Binance 자격 증명 입력과 계좌 조회는 paper MVP에서 차단됩니다.",
    )


@app.get("/api/wallet/binance")
async def get_binance_env():
    raise HTTPException(
        status_code=403,
        detail="Binance 인증 계좌 조회는 paper MVP에서 차단됩니다.",
    )

class PortfolioPayload(BaseModel):
    holdings: list[dict]
    total_value: int = 0
    pnl_pct: float = 0.0


class StockAnalysisPayload(BaseModel):
    ticker: str
    price_data: dict


class ChatPayload(BaseModel):
    question: str
    portfolio: dict | None = None


class StrategyPayload(BaseModel):
    holdings: list[dict]
    total_value: int = 0
    risk_appetite: str = "balanced"  # aggressive | balanced | conservative


def _check_api_key():
    if not os.getenv("OPENAI_API_KEY", "").startswith("sk-"):
        raise HTTPException(
            status_code=503,
            detail="OPENAI_API_KEY가 설정되지 않았습니다. .env 파일에 추가해주세요."
        )


@app.post("/api/analyze/portfolio")
async def analyze_portfolio(payload: PortfolioPayload):
    """포트폴리오 종합 분석 (스트리밍 SSE)."""
    _check_api_key()

    async def generate():
        async for chunk in ai.stream_portfolio_analysis(payload.dict()):
            yield f"data: {chunk}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")


@app.post("/api/analyze/stock")
async def analyze_stock(payload: StockAnalysisPayload):
    """개별 종목 분석 (스트리밍 SSE)."""
    _check_api_key()

    async def generate():
        async for chunk in ai.stream_stock_analysis(payload.ticker, payload.price_data):
            yield f"data: {chunk}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")


@app.post("/api/analyze/strategies")
async def get_strategies(payload: StrategyPayload):
    """전략 추천 (JSON 응답)."""
    _check_api_key()
    result = await ai.get_strategy_recommendations(
        {"holdings": payload.holdings, "total_value": payload.total_value},
        payload.risk_appetite,
    )
    return result


@app.post("/api/chat")
async def chat(payload: ChatPayload):
    """자유 질의 채팅 (스트리밍 SSE)."""
    _check_api_key()

    async def generate():
        async for chunk in ai.stream_chat(payload.question, payload.portfolio):
            yield f"data: {chunk}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")
