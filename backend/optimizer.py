"""
포트폴리오 최적화 — Markowitz MPT + 실용 확장
────────────────────────────────────────────────────
이론
  Markowitz (1952) "Portfolio Selection"
  Sharpe (1994) — 샤프지수 최대화 = 효율적 프론티어 접선 포트폴리오
  Black & Litterman (1990) — 시장 균형 + 투자자 견해 결합

구현
  1. 최대 샤프 포트폴리오  (기본)
  2. 최소 분산 포트폴리오  (리스크 최소)
  3. 동일 가중 포트폴리오  (1/N, DeMiguel 2009)
  4. 리스크 패리티          (각 자산이 동일 리스크 기여)

외부 라이브러리 없이 순수 Python으로 구현 (scipy 대신 경사하강법)
"""

from __future__ import annotations
import math
import random
from typing import Literal

RF_ANNUAL    = 0.035
TRADING_DAYS = 252


# ── 수학 헬퍼 ─────────────────────────────────────

def _dot(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b))


def _mat_vec(mat: list[list[float]], vec: list[float]) -> list[float]:
    return [_dot(row, vec) for row in mat]


def _portfolio_stats(
    weights: list[float],
    returns: list[float],     # 연율화 기대 수익률
    cov_matrix: list[list[float]],
) -> tuple[float, float, float]:
    """(기대수익률, 변동성, 샤프지수)"""
    ret = _dot(weights, returns)
    var = _dot(weights, _mat_vec(cov_matrix, weights))
    vol = math.sqrt(max(var, 0))
    sharpe = (ret - RF_ANNUAL) / vol if vol > 0 else 0
    return ret, vol, sharpe


def _covariance_matrix(daily_returns_matrix: list[list[float]]) -> list[list[float]]:
    """n×T 수익률 행렬 → n×n 공분산 행렬 (연율화)."""
    n = len(daily_returns_matrix)
    t = len(daily_returns_matrix[0]) if n > 0 else 0
    means = [sum(r) / t for r in daily_returns_matrix]
    cov = [[0.0] * n for _ in range(n)]
    for i in range(n):
        for j in range(n):
            cov[i][j] = sum(
                (daily_returns_matrix[i][k] - means[i]) *
                (daily_returns_matrix[j][k] - means[j])
                for k in range(t)
            ) / max(t - 1, 1) * TRADING_DAYS
    return cov


def _softmax_project(weights: list[float]) -> list[float]:
    """합=1, 각 가중치 ≥ 0.01 제약."""
    n = len(weights)
    w = [max(x, 0.01) for x in weights]
    total = sum(w)
    return [x / total for x in w]


# ── 최적화 (경사하강법 + 몬테카를로 초기화) ──────────

def _optimize(
    returns: list[float],
    cov_matrix: list[list[float]],
    objective: Literal["sharpe", "min_vol", "risk_parity"],
    n_restarts: int = 30,
    n_steps:    int = 2000,
    lr:         float = 0.01,
) -> list[float]:
    n = len(returns)
    best_w = [1 / n] * n
    best_score = float("-inf")

    for _ in range(n_restarts):
        # 랜덤 초기화
        w = _softmax_project([random.random() for _ in range(n)])

        for step in range(n_steps):
            lr_t = lr * (0.995 ** (step // 100))  # 학습률 감소
            ret, vol, sharpe = _portfolio_stats(w, returns, cov_matrix)

            # 수치 기울기 계산
            eps = 1e-5
            grad = []
            for i in range(n):
                w_plus  = w[:]
                w_minus = w[:]
                w_plus[i]  += eps
                w_minus[i] -= eps
                w_plus  = _softmax_project(w_plus)
                w_minus = _softmax_project(w_minus)

                if objective == "sharpe":
                    _, _, s_plus  = _portfolio_stats(w_plus,  returns, cov_matrix)
                    _, _, s_minus = _portfolio_stats(w_minus, returns, cov_matrix)
                    grad.append((s_plus - s_minus) / (2 * eps))

                elif objective == "min_vol":
                    _, v_plus,  _ = _portfolio_stats(w_plus,  returns, cov_matrix)
                    _, v_minus, _ = _portfolio_stats(w_minus, returns, cov_matrix)
                    grad.append(-(v_plus - v_minus) / (2 * eps))  # 최소화

                elif objective == "risk_parity":
                    # 각 자산의 리스크 기여가 동일해지도록
                    def _risk_contrib(weights_):
                        mv = _mat_vec(cov_matrix, weights_)
                        port_var = _dot(weights_, mv)
                        return [weights_[i] * mv[i] / max(port_var, 1e-12) for i in range(n)]
                    rc_plus  = _risk_contrib(w_plus)
                    rc_minus = _risk_contrib(w_minus)
                    # 목표: 분산 최소화 (동일 기여에 수렴)
                    target = 1 / n
                    score_plus  = -sum((rc - target) ** 2 for rc in rc_plus)
                    score_minus = -sum((rc - target) ** 2 for rc in rc_minus)
                    grad.append((score_plus - score_minus) / (2 * eps))

            # 가중치 업데이트
            w = _softmax_project([w[i] + lr_t * grad[i] for i in range(n)])

        # 최종 점수
        _, vol_f, sharpe_f = _portfolio_stats(w, returns, cov_matrix)
        score = sharpe_f if objective == "sharpe" else (-vol_f if objective == "min_vol" else sharpe_f)
        if score > best_score:
            best_score = score
            best_w = w[:]

    return best_w


# ── 공개 인터페이스 ───────────────────────────────

def optimize(
    tickers:       list[str],
    price_history: dict[str, list[float]],   # ticker → 일별 종가 리스트
) -> dict:
    """
    포트폴리오 최적화 결과 반환.

    Returns:
        {
          "max_sharpe":    {"weights": {...}, "return": x, "vol": x, "sharpe": x},
          "min_vol":       {...},
          "risk_parity":   {...},
          "equal_weight":  {...},
          "efficient_frontier": [{vol, ret, sharpe}, ...],
          "correlation":   [[...], ...],
        }
    """
    n = len(tickers)
    if n < 2:
        raise ValueError("최소 2개 종목 필요")

    # 일별 수익률 행렬 (각 ticker, 날짜 수 맞춤)
    min_len = min(len(price_history[t]) for t in tickers)
    daily_returns: list[list[float]] = []
    for t in tickers:
        prices = price_history[t][-min_len:]
        rets   = [(prices[i] - prices[i-1]) / prices[i-1] for i in range(1, len(prices))]
        daily_returns.append(rets)

    T = len(daily_returns[0])
    if T < 20:
        raise ValueError("데이터 부족 (최소 20일)")

    # 공분산 행렬 + 연율화 기대 수익률
    cov = _covariance_matrix(daily_returns)
    ann_returns = [sum(r) / T * TRADING_DAYS for r in daily_returns]

    # 상관계수 행렬
    vols = [math.sqrt(max(cov[i][i], 0)) for i in range(n)]
    corr = [
        [cov[i][j] / max(vols[i] * vols[j], 1e-12) for j in range(n)]
        for i in range(n)
    ]

    def _result(weights: list[float]) -> dict:
        ret, vol, sharpe = _portfolio_stats(weights, ann_returns, cov)
        return {
            "weights": {tickers[i]: round(weights[i], 4) for i in range(n)},
            "return":  round(ret * 100, 2),
            "vol":     round(vol * 100, 2),
            "sharpe":  round(sharpe, 3),
        }

    # 4가지 포트폴리오
    w_sharpe = _optimize(ann_returns, cov, "sharpe",      n_restarts=20)
    w_minvol = _optimize(ann_returns, cov, "min_vol",     n_restarts=20)
    w_rp     = _optimize(ann_returns, cov, "risk_parity", n_restarts=20)
    w_eq     = [1 / n] * n

    # 효율적 프론티어 (50개 포인트 샘플링)
    frontier = []
    for _ in range(50):
        w = _softmax_project([random.random() for _ in range(n)])
        ret, vol, sharpe = _portfolio_stats(w, ann_returns, cov)
        frontier.append({"vol": round(vol*100,2), "ret": round(ret*100,2), "sharpe": round(sharpe,3)})
    frontier.sort(key=lambda x: x["vol"])

    return {
        "tickers":            tickers,
        "max_sharpe":         _result(w_sharpe),
        "min_vol":            _result(w_minvol),
        "risk_parity":        _result(w_rp),
        "equal_weight":       _result(w_eq),
        "efficient_frontier": frontier,
        "correlation":        [[round(corr[i][j], 3) for j in range(n)] for i in range(n)],
        "annual_returns":     {tickers[i]: round(ann_returns[i]*100, 2) for i in range(n)},
        "volatilities":       {tickers[i]: round(vols[i]*100, 2) for i in range(n)},
    }
