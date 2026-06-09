"""
자동매매 봇 엔진
────────────────────────────────────────────────────
실행 모드
  PAPER  : 가상 실행 (기본값, 실제 주문 없음)
  LIVE   : Binance 실주문 (명시적 활성화 필요)

리스크 관리
  - Kelly Criterion  : 최적 포지션 크기 계산
  - 반 켈리 (f/2)    : 실전 과적합 방지 (Thorp 1997)
  - 일일 손실 한도   : 총 자산의 -2% 초과 시 당일 거래 중단
  - 최대 낙폭 차단   : 누적 -10% 초과 시 봇 자동 정지
  - 단일 종목 한도   : 포트폴리오의 최대 20%

전략
  BacktestEngine의 전략을 그대로 실시간 신호로 변환
  신호 기준: 최근 N일 가격으로 전략 재계산 → 포지션 결정
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from enum import Enum
from typing import Optional

import httpx

import backtest_engine as bt
import database as db
import notifier
from us_client import get_crypto_chart, get_crypto_price

logger = logging.getLogger("trading_bot")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")


# ── 상수 ─────────────────────────────────────────

MAX_POSITION_PCT   = 0.20   # 단일 포지션 최대 20%
DAILY_LOSS_LIMIT   = 0.02   # 일일 손실 한도 2%
MAX_DRAWDOWN_STOP  = 0.10   # 최대 낙폭 10% → 봇 정지
KELLY_FRACTION     = 0.5    # 반 켈리 (Thorp 1997)
COMMISSION         = 0.0010 # Binance 현물 0.10% (BNB 할인 미적용)

BINANCE_BASE = "https://api.binance.com"

# ── 캐시 (CoinGecko 429 방지) ─────────────────────
# 차트: 30분 TTL (신호는 1시간 단위라 충분)
# 가격: 60초 TTL
_chart_cache: dict[str, tuple[float, list]] = {}   # symbol → (ts, data)
_price_cache: dict[str, tuple[float, dict]]  = {}  # symbol → (ts, data)
CHART_TTL = 1800   # 30분
PRICE_TTL = 60     # 60초


# ── 타입 ─────────────────────────────────────────

class BotMode(str, Enum):
    PAPER = "paper"
    LIVE  = "live"


class Signal(str, Enum):
    BUY  = "BUY"
    SELL = "SELL"
    HOLD = "HOLD"


@dataclass
class Position:
    symbol:     str
    qty:        float
    avg_price:  float
    entry_time: str
    side:       str = "LONG"

    @property
    def value(self) -> float:
        return self.qty * self.avg_price


@dataclass
class Trade:
    id:         str
    symbol:     str
    side:       str
    qty:        float
    price:      float
    cost:       float
    mode:       str
    strategy:   str
    timestamp:  str
    pnl:        float = 0.0
    pnl_pct:    float = 0.0


@dataclass
class BotStatus:
    running:          bool       = False
    mode:             str        = BotMode.PAPER
    strategy:         str        = "dual_mom"
    symbols:          list[str]  = field(default_factory=lambda: ["BTC", "ETH"])
    initial_capital:  float      = 1_000_000
    current_capital:  float      = 1_000_000
    peak_capital:     float      = 1_000_000
    daily_start_cap:  float      = 1_000_000
    positions:        dict       = field(default_factory=dict)
    total_pnl:        float      = 0.0
    total_pnl_pct:    float      = 0.0
    drawdown_pct:     float      = 0.0
    daily_pnl_pct:    float      = 0.0
    trade_count:      int        = 0
    win_count:        int        = 0
    last_signal:      dict       = field(default_factory=dict)
    last_run:         str        = ""
    error:            str        = ""
    circuit_breaker:  bool       = False   # True = 거래 중단
    trades:           list       = field(default_factory=list)


# ── 전역 상태 (싱글톤) ────────────────────────────

_status = BotStatus()
_task: Optional[asyncio.Task] = None


def get_status() -> dict:
    return asdict(_status)


# ── Binance 주문 ──────────────────────────────────

async def _binance_order(symbol: str, side: str, qty: float, api_key: str, api_secret: str) -> dict:
    """Binance 현물 시장가 주문."""
    import hmac, hashlib
    ts = int(time.time() * 1000)
    params = f"symbol={symbol}USDT&side={side}&type=MARKET&quantity={qty:.6f}&timestamp={ts}"
    sig = hmac.new(api_secret.encode(), params.encode(), hashlib.sha256).hexdigest()
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(
            f"{BINANCE_BASE}/api/v3/order",
            params=params + f"&signature={sig}",
            headers={"X-MBX-APIKEY": api_key},
        )
        resp.raise_for_status()
        return resp.json()


async def _binance_price(symbol: str) -> float:
    """Binance 현재가 조회."""
    async with httpx.AsyncClient(timeout=5) as client:
        resp = await client.get(f"{BINANCE_BASE}/api/v3/ticker/price", params={"symbol": f"{symbol}USDT"})
        resp.raise_for_status()
        return float(resp.json()["price"])


# ── 리스크 관리 ───────────────────────────────────

def kelly_position_size(
    win_rate: float,       # 0~1
    avg_win: float,        # 평균 수익률
    avg_loss: float,       # 평균 손실률 (양수)
    capital: float,
    max_pct: float = MAX_POSITION_PCT,
) -> float:
    """
    Kelly Criterion (Thorp 1997 반 켈리 적용)
    f* = (p·b - q) / b  where b = avg_win/avg_loss
    실전에선 f*/2 사용 (변동성 감소, 파산 위험 최소화)
    """
    if avg_loss <= 0:
        return 0.0
    b = avg_win / avg_loss
    q = 1 - win_rate
    kelly = (win_rate * b - q) / b
    half_kelly = max(0, kelly * KELLY_FRACTION)
    capped = min(half_kelly, max_pct)
    return capital * capped


def check_risk(status: BotStatus) -> tuple[bool, str]:
    """리스크 체크. (통과여부, 사유)"""
    # 서킷 브레이커 (최대 낙폭)
    if status.peak_capital > 0:
        dd = (status.peak_capital - status.current_capital) / status.peak_capital
        status.drawdown_pct = dd * 100
        if dd >= MAX_DRAWDOWN_STOP:
            status.circuit_breaker = True
            return False, f"최대 낙폭 {dd*100:.1f}% 초과 → 봇 자동 정지"

    # 일일 손실 한도
    if status.daily_start_cap > 0:
        daily_loss = (status.daily_start_cap - status.current_capital) / status.daily_start_cap
        status.daily_pnl_pct = -daily_loss * 100
        if daily_loss >= DAILY_LOSS_LIMIT:
            return False, f"일일 손실 {daily_loss*100:.1f}% 한도 초과 → 오늘 거래 중단"

    return True, ""


# ── 캐시 래퍼 ────────────────────────────────────

async def _cached_chart(symbol: str) -> list:
    now = time.time()
    if symbol in _chart_cache:
        ts, data = _chart_cache[symbol]
        if now - ts < CHART_TTL:
            logger.info(f"[cache] chart hit: {symbol}")
            return data
    try:
        data = await get_crypto_chart(symbol, "1Y", "usd")
    except Exception:
        data = await get_crypto_chart(symbol, "6M", "usd")
    _chart_cache[symbol] = (now, data)
    return data


async def _cached_price(symbol: str) -> dict:
    now = time.time()
    if symbol in _price_cache:
        ts, data = _price_cache[symbol]
        if now - ts < PRICE_TTL:
            logger.info(f"[cache] price hit: {symbol}")
            return data
    data = await get_crypto_price(symbol, "usd")
    _price_cache[symbol] = (now, data)
    return data


# ── 신호 생성 ─────────────────────────────────────

async def generate_signal(symbol: str, strategy: str) -> tuple[Signal, dict]:
    """
    최근 가격 데이터로 전략 신호 생성.
    백테스트 엔진을 1원짜리 자산으로 실행해 마지막 신호 추출.
    """
    chart = await _cached_chart(symbol)

    if len(chart) < 10:
        return Signal.HOLD, {"reason": "데이터 부족"}

    bars = [bt.Bar(date=c["date"], open=c["open"], high=c["high"],
                   low=c["low"], close=c["close"], volume=c.get("volume", 0))
            for c in chart]

    closes = [b.close for b in bars]
    n = len(closes)
    info: dict = {"strategy": strategy, "bars": n, "last_close": closes[-1]}

    if strategy == "dual_mom":
        lookback = min(252, n // 2)
        if n <= lookback:
            return Signal.HOLD, {**info, "reason": "lookback 부족"}
        ret = (closes[-1] - closes[-lookback]) / closes[-lookback]
        rf_annual = 0.035
        sig = Signal.BUY if ret > rf_annual else Signal.SELL
        info.update({"momentum_12m": round(ret * 100, 2), "threshold": rf_annual * 100})

    elif strategy == "sma_cross":
        if n < 30:
            return Signal.HOLD, {**info, "reason": "SMA30 부족"}
        sma10 = sum(closes[-10:]) / 10
        sma30 = sum(closes[-30:]) / 30
        sig = Signal.BUY if sma10 > sma30 else Signal.SELL
        info.update({"sma10": round(sma10, 2), "sma30": round(sma30, 2)})

    elif strategy == "bollinger":
        if n < 20:
            return Signal.HOLD, {**info, "reason": "볼린저 부족"}
        window = closes[-20:]
        mid = sum(window) / 20
        std = bt._std(window)
        upper, lower = mid + 2 * std, mid - 2 * std
        price = closes[-1]
        if price < lower:
            sig = Signal.BUY
        elif price > upper:
            sig = Signal.SELL
        else:
            sig = Signal.HOLD
        info.update({"upper": round(upper, 2), "mid": round(mid, 2), "lower": round(lower, 2), "price": round(price, 2)})

    elif strategy == "rsi":
        rsi_val = bt._rsi(closes, 14, n - 1)
        if rsi_val is None:
            return Signal.HOLD, {**info, "reason": "RSI 부족"}
        if rsi_val < 30:
            sig = Signal.BUY
        elif rsi_val > 70:
            sig = Signal.SELL
        else:
            sig = Signal.HOLD
        info["rsi"] = round(rsi_val, 2)

    elif strategy == "ensemble":
        # ── 멀티 전략 앙상블 (다수결 투표) ──────────────
        # 5개 전략 각각 신호 계산 후 BUY/SELL/HOLD 투표
        votes: list[str] = []
        vote_details: dict[str, str] = {}

        # dual_mom
        lookback = min(252, n // 2)
        if n > lookback:
            ret = (closes[-1] - closes[-lookback]) / closes[-lookback]
            v = "BUY" if ret > 0.035 else "SELL"
            votes.append(v); vote_details["dual_mom"] = v

        # sma_cross
        if n >= 30:
            s10 = sum(closes[-10:]) / 10
            s30 = sum(closes[-30:]) / 30
            v = "BUY" if s10 > s30 else "SELL"
            votes.append(v); vote_details["sma_cross"] = v

        # bollinger
        if n >= 20:
            window = closes[-20:]
            mid_ = sum(window) / 20
            std_ = bt._std(window)
            p = closes[-1]
            if   p < mid_ - 2 * std_: v = "BUY"
            elif p > mid_ + 2 * std_: v = "SELL"
            else:                      v = "HOLD"
            votes.append(v); vote_details["bollinger"] = v

        # rsi
        rsi_val = bt._rsi(closes, 14, n - 1)
        if rsi_val is not None:
            if   rsi_val < 30: v = "BUY"
            elif rsi_val > 70: v = "SELL"
            else:              v = "HOLD"
            votes.append(v); vote_details["rsi"] = v

        # bah (항상 BUY)
        votes.append("BUY"); vote_details["bah"] = "BUY"

        buy_votes  = votes.count("BUY")
        sell_votes = votes.count("SELL")
        total_votes = len(votes)
        # 60% 이상 동의할 때만 신호 발생
        threshold = 0.6
        if   buy_votes  / total_votes >= threshold: sig = Signal.BUY
        elif sell_votes / total_votes >= threshold: sig = Signal.SELL
        else:                                        sig = Signal.HOLD

        info.update({
            "votes": vote_details,
            "buy_votes": buy_votes,
            "sell_votes": sell_votes,
            "total_votes": total_votes,
            "threshold_pct": threshold * 100,
        })

    else:  # bah
        sig = Signal.BUY
        info["reason"] = "Always Long"

    return sig, info


# ── 주문 실행 ─────────────────────────────────────

async def execute_order(
    symbol:     str,
    signal:     Signal,
    price:      float,
    status:     BotStatus,
    api_key:    str = "",
    api_secret: str = "",
) -> Optional[Trade]:
    """신호에 따라 포지션 진입/청산."""
    ts = datetime.now(timezone.utc).isoformat()
    pos = status.positions.get(symbol)

    if signal == Signal.HOLD:
        return None

    # ── 매수 ──
    if signal == Signal.BUY and pos is None:
        # 포지션 크기: Kelly 기반 (기본 10% 사용, 과거 기록 없을 때)
        win_rate = status.win_count / max(status.trade_count, 1) if status.trade_count else 0.55
        invest = kelly_position_size(win_rate, 0.08, 0.05, status.current_capital)
        invest = max(invest, status.current_capital * 0.05)  # 최소 5%
        invest = min(invest, status.current_capital * MAX_POSITION_PCT)

        if invest < 1:
            return None

        if status.mode == BotMode.LIVE and api_key and api_secret:
            qty = invest / price
            try:
                await _binance_order(symbol, "BUY", qty, api_key, api_secret)
            except Exception as e:
                logger.error(f"Binance 주문 실패: {e}")
                return None

        qty = invest / price
        cost = invest * COMMISSION
        status.current_capital -= (invest + cost)
        status.positions[symbol] = {
            "symbol": symbol, "qty": qty, "avg_price": price,
            "entry_time": ts, "invest": invest,
        }

        trade = Trade(
            id=f"{symbol}-{int(time.time())}", symbol=symbol, side="BUY",
            qty=qty, price=price, cost=cost, mode=status.mode,
            strategy=status.strategy, timestamp=ts,
        )
        status.trades.insert(0, asdict(trade))
        if len(status.trades) > 200:
            status.trades = status.trades[:200]
        status.trade_count += 1
        logger.info(f"[{status.mode}] BUY {symbol} @ {price:,.2f}  qty={qty:.6f}  invest={invest:,.0f}")
        # DB 저장 + 텔레그램 알림
        await db.save_trade(asdict(trade))
        await notifier.notify_trade("BUY", symbol, price, qty, invest, status.mode)
        return trade

    # ── 매도 ──
    elif signal == Signal.SELL and pos is not None:
        qty   = pos["qty"]
        proceeds = qty * price
        cost  = proceeds * COMMISSION
        pnl   = proceeds - pos["invest"] - cost
        pnl_pct = pnl / pos["invest"] * 100

        if status.mode == BotMode.LIVE and api_key and api_secret:
            try:
                await _binance_order(symbol, "SELL", qty, api_key, api_secret)
            except Exception as e:
                logger.error(f"Binance 주문 실패: {e}")
                return None

        status.current_capital += proceeds - cost
        del status.positions[symbol]
        if pnl > 0:
            status.win_count += 1

        trade = Trade(
            id=f"{symbol}-{int(time.time())}", symbol=symbol, side="SELL",
            qty=qty, price=price, cost=cost, mode=status.mode,
            strategy=status.strategy, timestamp=ts,
            pnl=pnl, pnl_pct=pnl_pct,
        )
        status.trades.insert(0, asdict(trade))
        if len(status.trades) > 200:
            status.trades = status.trades[:200]
        status.trade_count += 1
        logger.info(f"[{status.mode}] SELL {symbol} @ {price:,.2f}  PnL={pnl:+,.0f} ({pnl_pct:+.2f}%)")
        # DB 저장 + 텔레그램 알림
        await db.save_trade(asdict(trade))
        await notifier.notify_trade("SELL", symbol, price, qty, pos["invest"], status.mode, pnl, pnl_pct)
        return trade

    return None


# ── 봇 메인 루프 ──────────────────────────────────

async def _bot_loop(api_key: str = "", api_secret: str = ""):
    global _status
    _status.running = True
    _status.error   = ""
    _status.daily_start_cap = _status.current_capital
    logger.info(f"봇 시작 | mode={_status.mode} strategy={_status.strategy} symbols={_status.symbols}")

    while _status.running:
        try:
            now = datetime.now(timezone.utc)
            _status.last_run = now.isoformat()

            # 날짜 변경 시 일일 자본 리셋
            if now.hour == 0 and now.minute < 5:
                _status.daily_start_cap = _status.current_capital

            # 리스크 체크
            ok, reason = check_risk(_status)
            if not ok:
                logger.warning(f"리스크 차단: {reason}")
                _status.error = reason
                if _status.circuit_breaker:
                    await notifier.notify_circuit_breaker(reason, _status.total_pnl_pct)
                    _status.running = False
                    break
                await asyncio.sleep(300)  # 5분 대기 후 재시도
                continue

            signals: dict = {}

            for sym in _status.symbols:
                try:
                    # 현재가 (캐시 사용)
                    price_data = await _cached_price(sym)
                    price = price_data["current_price"]

                    # 신호 생성
                    signal, info = await generate_signal(sym, _status.strategy)
                    signals[sym] = {"signal": signal, "price": price, **info}

                    # 주문 실행
                    await execute_order(sym, signal, price, _status, api_key, api_secret)

                except Exception as e:
                    logger.error(f"{sym} 처리 오류: {e}")
                    signals[sym] = {"signal": "ERROR", "error": str(e)}

                await asyncio.sleep(2)   # CoinGecko 레이트 리밋 방지

            _status.last_signal = signals

            # 포지션 PnL 갱신
            total_pos_value = 0.0
            for sym, pos in _status.positions.items():
                try:
                    p = await _cached_price(sym)
                    pos["current_price"] = p["current_price"]
                    pos["unrealized_pnl"] = (p["current_price"] - pos["avg_price"]) * pos["qty"]
                    pos["unrealized_pnl_pct"] = (p["current_price"] - pos["avg_price"]) / pos["avg_price"] * 100
                    total_pos_value += p["current_price"] * pos["qty"]
                except Exception:
                    total_pos_value += pos["avg_price"] * pos["qty"]

            total_value = _status.current_capital + total_pos_value
            _status.total_pnl     = total_value - _status.initial_capital
            _status.total_pnl_pct = _status.total_pnl / _status.initial_capital * 100
            if total_value > _status.peak_capital:
                _status.peak_capital = total_value

            logger.info(
                f"루프 완료 | 자산={total_value:,.0f} PnL={_status.total_pnl:+,.0f} ({_status.total_pnl_pct:+.2f}%) "
                f"포지션={list(_status.positions.keys())}"
            )
            # DB 상태 스냅샷 저장
            await db.save_state("bot_capital", _status.current_capital)
            await db.save_state("bot_positions", _status.positions)
            await db.upsert_daily_pnl(
                _status.total_pnl, _status.total_pnl_pct,
                _status.trade_count, total_value,
            )
            # 자정에 일일 리포트
            if now.hour == 0 and now.minute < 2:
                win_rate = _status.win_count / max(_status.trade_count, 1) * 100
                await notifier.notify_daily_report(
                    _status.total_pnl, _status.total_pnl_pct,
                    _status.daily_pnl_pct, _status.drawdown_pct,
                    _status.trade_count, win_rate,
                    list(_status.positions.keys()),
                )

        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error(f"봇 루프 오류: {e}")
            _status.error = str(e)

        # 대기 (페이퍼: 60초, 실거래: 1시간)
        interval = 60 if _status.mode == BotMode.PAPER else 3600
        await asyncio.sleep(interval)

    _status.running = False
    logger.info("봇 종료")


# ── 공개 인터페이스 ───────────────────────────────

def configure(
    mode:            str,
    strategy:        str,
    symbols:         list[str],
    initial_capital: float,
):
    global _status
    _status = BotStatus(
        mode=mode,
        strategy=strategy,
        symbols=symbols,
        initial_capital=initial_capital,
        current_capital=initial_capital,
        peak_capital=initial_capital,
        daily_start_cap=initial_capital,
    )


async def start(api_key: str = "", api_secret: str = ""):
    global _task, _status
    if _status.running:
        return
    # DB에서 이전 상태 복원
    saved_capital = await db.load_state("bot_capital")
    if saved_capital and saved_capital > 0:
        _status.current_capital = saved_capital
        logger.info(f"이전 자본 복원: {saved_capital:,.0f}원")
    saved_positions = await db.load_state("bot_positions")
    if saved_positions:
        _status.positions = saved_positions
        logger.info(f"이전 포지션 복원: {list(saved_positions.keys())}")
    # DB 매매 내역 로드
    saved_trades = await db.load_trades(200)
    if saved_trades:
        _status.trades = saved_trades
        _status.trade_count = len([t for t in saved_trades if True])
        _status.win_count   = len([t for t in saved_trades if t.get("pnl", 0) > 0 and t["side"] == "SELL"])
    await notifier.notify_bot_start(_status.mode, _status.strategy, _status.symbols, _status.current_capital)
    _task = asyncio.create_task(_bot_loop(api_key, api_secret))


async def stop():
    global _task, _status
    _status.running = False
    if _task and not _task.done():
        _task.cancel()
        try:
            await _task
        except asyncio.CancelledError:
            pass
    await notifier.notify_bot_stop(_status.total_pnl, _status.total_pnl_pct, _status.trade_count)
