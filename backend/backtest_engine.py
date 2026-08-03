"""
포트폴리오 백테스트 엔진 — 논문 기반 구현
────────────────────────────────────────────
핵심 원칙
  1. Look-ahead bias 제거  : N일 종가 신호 → N+1일 시가 체결
  2. 거래비용              : 슬리피지 0.05% + 수수료 0.10% = 편도 0.15% (기본값)
  3. 무위험 수익률         : 한국 국고채 3.5% (연)
  4. 연율화                : CAGR, Sharpe, Sortino, Calmar 모두 일별 → 연율

전략 출처
  BUY_HOLD   : 기준선 (Fama 1970 Efficient Market Hypothesis)
  DUAL_MOM   : Antonacci (2012) "Risk Premia Harvesting Through Dual Momentum"
  SMA_CROSS  : Faber (2007) "A Quantitative Approach to Tactical Asset Allocation"
  BOLLINGER  : Bollinger (2001) / Lo et al. (2000) "Foundations of Technical Analysis"
  RSI_MOM    : Wilder (1978), 검증: Jegadeesh & Titman (1993) momentum literature
"""

from __future__ import annotations
import math
from dataclasses import dataclass, field
from typing import Literal

COMMISSION   = 0.001    # 편도 수수료 0.10% (기본값)
SLIPPAGE     = 0.0005   # 편도 슬리피지 0.05% (기본값)
RF_ANNUAL    = 0.035    # 무위험 수익률 연 3.5%
RF_DAILY     = (1 + RF_ANNUAL) ** (1 / 252) - 1
TRADING_DAYS = 252


# ── 데이터 타입 ─────────────────────────────────

@dataclass
class Bar:
    date:   str
    open:   float
    high:   float
    low:    float
    close:  float
    volume: float = 0.0


@dataclass
class TradeLog:
    date:   str
    side:   Literal["BUY", "SELL"]
    price:  float
    shares: float
    cost:   float        # 거래비용 금액


@dataclass
class BacktestResult:
    strategy:         str
    strategy_label:   str
    initial:          float
    final:            float
    total_return_pct: float
    cagr:             float
    sharpe:           float
    sortino:          float
    calmar:           float
    mdd:              float
    win_rate:         float
    profit_factor:    float
    total_trades:     int
    total_cost:       float
    curve:            list[dict]   # {date, value, drawdown_pct}
    monthly_returns:  list[dict]   # {year, month, pct}
    trades:           list[dict]
    description:      str
    paper:            str


# ── 지표 계산 ───────────────────────────────────

def _sma(prices: list[float], n: int, i: int) -> float | None:
    if i < n - 1:
        return None
    return sum(prices[i - n + 1 : i + 1]) / n


def _rsi(prices: list[float], n: int, i: int) -> float | None:
    if i < n:
        return None
    deltas = [prices[j] - prices[j - 1] for j in range(i - n + 1, i + 1)]
    gains  = [d for d in deltas if d > 0]
    losses = [-d for d in deltas if d < 0]
    avg_gain = sum(gains) / n if gains else 0
    avg_loss = sum(losses) / n if losses else 0
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100 - (100 / (1 + rs))


def _std(values: list[float]) -> float:
    if len(values) < 2:
        return 0.0
    mean = sum(values) / len(values)
    return math.sqrt(sum((v - mean) ** 2 for v in values) / (len(values) - 1))


# ── 성과 지표 계산 ──────────────────────────────

def _compute_metrics(
    curve_values: list[float],
    curve_dates:  list[str],
    initial:      float,
    trades:       list[TradeLog],
) -> dict:
    n = len(curve_values)
    if n < 2:
        return {}

    final = curve_values[-1]
    total_return = (final - initial) / initial

    # CAGR
    years = n / TRADING_DAYS
    cagr  = (final / initial) ** (1 / max(years, 0.001)) - 1

    # 일별 수익률
    daily_ret = [(curve_values[i] - curve_values[i - 1]) / curve_values[i - 1]
                 for i in range(1, n)]

    # Sharpe (Sharpe 1994)
    excess   = [r - RF_DAILY for r in daily_ret]
    avg_exc  = sum(excess) / len(excess)
    std_exc  = _std(excess)
    sharpe   = (avg_exc / std_exc) * math.sqrt(TRADING_DAYS) if std_exc > 0 else 0

    # Sortino (Sortino & Price 1994) — 하방 편차만 사용
    downside = [min(r - RF_DAILY, 0) for r in daily_ret]
    downside_std = math.sqrt(sum(d ** 2 for d in downside) / max(len(downside), 1))
    sortino  = (avg_exc / downside_std) * math.sqrt(TRADING_DAYS) if downside_std > 0 else 0

    # MDD (Magdon-Ismail et al. 2004)
    peak = curve_values[0]
    mdd  = 0.0
    dd_series = []
    for v in curve_values:
        if v > peak:
            peak = v
        dd = (peak - v) / peak
        dd_series.append(-dd * 100)
        if dd > mdd:
            mdd = dd

    # Calmar (Young 1991)
    calmar = min(cagr / mdd, 999.0) if mdd > 0 else 999.0

    # 승률 / Profit Factor
    pos = [r for r in daily_ret if r > 0]
    neg = [r for r in daily_ret if r < 0]
    win_rate = len(pos) / max(len(daily_ret), 1) * 100
    profit_factor = (sum(pos) / abs(sum(neg))) if neg else float("inf")

    # curve with drawdown
    curve = [
        {"date": d, "value": round(v, 0), "dd": round(dd, 2)}
        for d, v, dd in zip(curve_dates, curve_values, dd_series)
    ]

    # 월별 수익률 히트맵
    monthly: dict[tuple[str, str], list[float]] = {}
    for i in range(1, n):
        y, m = curve_dates[i][:4], curve_dates[i][5:7]
        monthly.setdefault((y, m), []).append(daily_ret[i - 1])
    monthly_returns = []
    for (y, m), rets in sorted(monthly.items()):
        compound = 1.0
        for r in rets:
            compound *= (1 + r)
        monthly_returns.append({"year": y, "month": m, "pct": round((compound - 1) * 100, 2)})

    total_cost = sum(t.cost for t in trades)

    return {
        "final":            round(final, 0),
        "total_return_pct": round(total_return * 100, 2),
        "cagr":           round(cagr * 100, 2),
        "sharpe":         round(sharpe, 3),
        "sortino":        round(sortino, 3),
        "calmar":         round(calmar, 3),
        "mdd":            round(mdd * 100, 2),
        "win_rate":       round(win_rate, 2),
        "profit_factor":  round(min(profit_factor, 999.0), 3),
        "total_trades":   len([t for t in trades]),
        "total_cost":     round(total_cost, 0),
        "curve":          curve,
        "monthly_returns": monthly_returns,
        "trades":         [{"date": t.date, "side": t.side, "price": t.price, "cost": round(t.cost, 0)} for t in trades[:50]],
    }


# ── 전략 실행기 ─────────────────────────────────

def _execute(
    bars:     list[Bar],
    initial:  float,
    signals:  list[int],   # +1=매수, -1=매도, 0=홀드  (N일 신호)
    cost_rate: float = COMMISSION + SLIPPAGE,
) -> tuple[list[float], list[str], list[TradeLog]]:
    """
    signals[i] = bars[i] 종가 기준 신호
    체결       = bars[i+1] 시가 (look-ahead bias 제거)
    """
    cash   = initial
    shares = 0.0
    trades: list[TradeLog] = []
    curve_values: list[float] = []
    curve_dates:  list[str]   = []

    for i, bar in enumerate(bars):
        portfolio = cash + shares * bar.close

        # 전일 신호로 오늘 시가 체결
        if i > 0 and signals[i - 1] != 0:
            exec_price = bar.open
            if signals[i - 1] == 1 and shares == 0 and cash > 0:
                cost    = cash * cost_rate
                shares  = (cash - cost) / exec_price
                trades.append(TradeLog(bar.date, "BUY",  exec_price, shares, cost))
                cash    = 0.0
            elif signals[i - 1] == -1 and shares > 0:
                proceeds = shares * exec_price
                cost     = proceeds * cost_rate
                cash     = proceeds - cost
                trades.append(TradeLog(bar.date, "SELL", exec_price, shares, cost))
                shares   = 0.0

        portfolio = cash + shares * bar.close
        curve_values.append(portfolio)
        curve_dates.append(bar.date)

    return curve_values, curve_dates, trades


# ═══════════════════════════════════════════════
# 전략 1: Buy & Hold
# ═══════════════════════════════════════════════

def run_buy_hold(bars: list[Bar], initial: float, cost_rate: float = COMMISSION + SLIPPAGE) -> BacktestResult:
    signals = [1] + [0] * (len(bars) - 1)
    cv, cd, tr = _execute(bars, initial, signals, cost_rate)
    m = _compute_metrics(cv, cd, initial, tr)
    return BacktestResult(
        strategy="bah", strategy_label="Buy & Hold",
        initial=initial, **m,
        description="단순 매수 후 보유. 모든 전략의 기준선.",
        paper="Fama (1970) Efficient Capital Markets",
    )


# ═══════════════════════════════════════════════
# 전략 2: Dual Momentum (Antonacci 2012)
# ═══════════════════════════════════════════════
# 절대 모멘텀: 12개월 수익률 > 0이면 자산 보유, < 0이면 현금
# 검증: 1974~2013 전 자산군에서 Buy&Hold 대비 MDD 50% 감소

def run_dual_momentum(bars: list[Bar], initial: float, cost_rate: float = COMMISSION + SLIPPAGE) -> BacktestResult:
    closes  = [b.close for b in bars]
    n       = len(bars)
    LOOKBACK = min(252, n // 2)   # 12개월(252일) 모멘텀
    signals  = [0] * n

    for i in range(LOOKBACK, n):
        ret_12m = (closes[i] - closes[i - LOOKBACK]) / closes[i - LOOKBACK]
        if ret_12m > RF_ANNUAL:        # 절대 모멘텀: 무위험 수익률 초과
            signals[i] = 1
        else:
            signals[i] = -1

    cv, cd, tr = _execute(bars, initial, signals, cost_rate)
    m = _compute_metrics(cv, cd, initial, tr)
    return BacktestResult(
        strategy="dual_mom", strategy_label="Dual Momentum",
        initial=initial, **m,
        description=f"12개월 절대 모멘텀 ({LOOKBACK}일). 수익률 > 무위험(3.5%) → 보유, 미달 → 현금.",
        paper="Antonacci (2012) Risk Premia Harvesting Through Dual Momentum",
    )


# ═══════════════════════════════════════════════
# 전략 3: SMA 10/30 Crossover (Faber 2007)
# ═══════════════════════════════════════════════
# 10개월 SMA > 10개월 전 10개월 SMA (단기 > 장기) → 매수
# 검증: 1900~2006 S&P500 CAGR +10.5% vs B&H +9.3%, MDD -50% 감소

def run_sma_cross(bars: list[Bar], initial: float, cost_rate: float = COMMISSION + SLIPPAGE) -> BacktestResult:
    closes  = [b.close for b in bars]
    n       = len(bars)
    S, L    = 10, 30              # Faber 원논문 10/30주 → 여기선 10/30일 (일봉 데이터)
    signals = [0] * n
    prev_signal = 0

    for i in range(L - 1, n):
        s = _sma(closes, S, i)
        l = _sma(closes, L, i)
        if s is None or l is None:
            continue
        if s > l and prev_signal != 1:
            signals[i] = 1
            prev_signal = 1
        elif s < l and prev_signal != -1:
            signals[i] = -1
            prev_signal = -1

    cv, cd, tr = _execute(bars, initial, signals, cost_rate)
    m = _compute_metrics(cv, cd, initial, tr)
    return BacktestResult(
        strategy="sma_cross", strategy_label=f"SMA {S}/{L} 크로스",
        initial=initial, **m,
        description=f"단기 SMA{S} > 장기 SMA{L} 돌파 시 매수, 이탈 시 매도. 거래비용 0.15% 반영.",
        paper="Faber (2007) A Quantitative Approach to Tactical Asset Allocation",
    )


# ═══════════════════════════════════════════════
# 전략 4: Bollinger Band Mean Reversion (2σ)
# ═══════════════════════════════════════════════
# 하단 밴드 이탈 → 매수, 상단 밴드 돌파 → 청산
# 검증: Lo, Mamaysky & Wang (2000) "Foundations of Technical Analysis"

def run_bollinger(bars: list[Bar], initial: float, cost_rate: float = COMMISSION + SLIPPAGE) -> BacktestResult:
    closes  = [b.close for b in bars]
    n       = len(bars)
    WINDOW  = 20
    MULT    = 2.0
    signals = [0] * n
    prev_signal = -1   # 초기: 비보유

    for i in range(WINDOW - 1, n):
        window_prices = closes[i - WINDOW + 1 : i + 1]
        mid  = sum(window_prices) / WINDOW
        std  = _std(window_prices)
        upper = mid + MULT * std
        lower = mid - MULT * std
        price = closes[i]

        if price < lower and prev_signal != 1:
            signals[i]  = 1
            prev_signal = 1
        elif price > upper and prev_signal == 1:
            signals[i]  = -1
            prev_signal = -1

    cv, cd, tr = _execute(bars, initial, signals, cost_rate)
    m = _compute_metrics(cv, cd, initial, tr)
    return BacktestResult(
        strategy="bollinger", strategy_label="Bollinger Band (2σ)",
        initial=initial, **m,
        description="20일 볼린저 밴드. 하단 2σ 이탈 → 매수, 상단 2σ 돌파 → 청산. 평균회귀 전략.",
        paper="Lo, Mamaysky & Wang (2000) Foundations of Technical Analysis",
    )


# ═══════════════════════════════════════════════
# 전략 5: RSI(14) Momentum
# ═══════════════════════════════════════════════
# RSI < 30 과매도 → 매수, RSI > 70 과매수 → 청산
# 검증: Wilder (1978), Pruitt & White (1988) 수익성 확인

def run_rsi(bars: list[Bar], initial: float, cost_rate: float = COMMISSION + SLIPPAGE) -> BacktestResult:
    closes  = [b.close for b in bars]
    n       = len(bars)
    PERIOD  = 14
    BUY_LVL = 30
    SELL_LVL = 70
    signals = [0] * n
    prev_signal = -1

    for i in range(PERIOD, n):
        rsi = _rsi(closes, PERIOD, i)
        if rsi is None:
            continue
        if rsi < BUY_LVL and prev_signal != 1:
            signals[i]  = 1
            prev_signal = 1
        elif rsi > SELL_LVL and prev_signal == 1:
            signals[i]  = -1
            prev_signal = -1

    cv, cd, tr = _execute(bars, initial, signals, cost_rate)
    m = _compute_metrics(cv, cd, initial, tr)
    return BacktestResult(
        strategy="rsi", strategy_label="RSI(14) 역추세",
        initial=initial, **m,
        description=f"RSI14 < {BUY_LVL} 과매도 → 매수, > {SELL_LVL} 과매수 → 청산.",
        paper="Wilder (1978) New Concepts in Technical Trading Systems",
    )


# ═══════════════════════════════════════════════
# 전략 6: 앙상블 (다수결 투표)
# ═══════════════════════════════════════════════
# 5개 전략 중 60% 이상 동의 시 신호 발생
# 논문: Dietterich (2000) "Ensemble Methods in Machine Learning"

def run_ensemble(bars: list[Bar], initial: float, cost_rate: float = COMMISSION + SLIPPAGE) -> BacktestResult:
    closes  = [b.close for b in bars]
    n       = len(bars)
    signals = [0] * n
    THRESHOLD = 0.6

    for i in range(30, n):    # 충분한 데이터가 쌓인 후 시작
        votes: list[int] = []  # +1=BUY, -1=SELL

        # dual_mom
        lb = min(252, i // 2)
        if i > lb:
            ret = (closes[i] - closes[i - lb]) / closes[i - lb]
            votes.append(1 if ret > RF_ANNUAL else -1)

        # sma_cross
        if i >= 30:
            s10 = sum(closes[i-10:i]) / 10
            s30 = sum(closes[i-30:i]) / 30
            votes.append(1 if s10 > s30 else -1)

        # bollinger
        if i >= 20:
            w = closes[i-20:i]
            mid = sum(w) / 20
            std = _std(w)
            p = closes[i]
            if   p < mid - 2 * std: votes.append(1)
            elif p > mid + 2 * std: votes.append(-1)
            else:                   votes.append(0)

        # rsi
        rsi_val = _rsi(closes, 14, i)
        if rsi_val is not None:
            if   rsi_val < 30: votes.append(1)
            elif rsi_val > 70: votes.append(-1)
            else:              votes.append(0)

        # bah
        votes.append(1)

        if not votes:
            continue
        buy_ratio  = sum(1 for v in votes if v == 1) / len(votes)
        sell_ratio = sum(1 for v in votes if v == -1) / len(votes)
        if   buy_ratio  >= THRESHOLD: signals[i] = 1
        elif sell_ratio >= THRESHOLD: signals[i] = -1

    cv, cd, tr = _execute(bars, initial, signals, cost_rate)
    m = _compute_metrics(cv, cd, initial, tr)
    return BacktestResult(
        strategy="ensemble", strategy_label="앙상블 (다수결)",
        initial=initial, **m,
        description="5개 전략 투표 — 60% 이상 동의 시 매매. 단일 전략보다 안정적.",
        paper="Dietterich (2000) Ensemble Methods in Machine Learning",
    )


# ── 전략 디스패처 ────────────────────────────────

STRATEGIES = {
    "bah":       run_buy_hold,
    "dual_mom":  run_dual_momentum,
    "sma_cross": run_sma_cross,
    "bollinger": run_bollinger,
    "rsi":       run_rsi,
    "ensemble":  run_ensemble,
}


def run(
    bars: list[Bar],
    initial: float,
    strategy: str,
    commission_rate: float = COMMISSION,
    slippage_rate: float = SLIPPAGE,
) -> BacktestResult:
    fn = STRATEGIES.get(strategy)
    if fn is None:
        raise ValueError(f"Unknown strategy: {strategy}")
    return fn(bars, initial, commission_rate + slippage_rate)


def run_all(
    bars: list[Bar],
    initial: float,
    commission_rate: float = COMMISSION,
    slippage_rate: float = SLIPPAGE,
) -> list[BacktestResult]:
    cost_rate = commission_rate + slippage_rate
    return [fn(bars, initial, cost_rate) for fn in STRATEGIES.values()]
