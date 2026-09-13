"""과적합·선택편향 진단을 위한 paper-only 백테스트 보조 지표.

이 모듈은 주문을 만들거나 전략을 승격하지 않습니다. 고정 규칙 전략의
수익률 곡선을 받아 CSCV 방식의 PBO 근사치와 Deflated Sharpe 확률을
계산해, 단순히 가장 높은 수익률 하나만 고르는 일을 어렵게 하는 것이
목적입니다.
"""

from __future__ import annotations

import itertools
import math
from statistics import NormalDist
from typing import Mapping, Sequence


MIN_SAMPLE_SIZE = 30
DEFAULT_BLOCKS = 4


def _mean(values: Sequence[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def _sample_std(values: Sequence[float]) -> float:
    if len(values) < 2:
        return 0.0
    mean = _mean(values)
    return math.sqrt(sum((value - mean) ** 2 for value in values) / (len(values) - 1))


def _moments(values: Sequence[float]) -> tuple[float, float, float, float]:
    mean = _mean(values)
    std = _sample_std(values)
    if std <= 0:
        return mean, std, 0.0, 0.0
    skew = sum((value - mean) ** 3 for value in values) / len(values) / (std ** 3)
    excess_kurtosis = sum((value - mean) ** 4 for value in values) / len(values) / (std ** 4) - 3.0
    return mean, std, skew, excess_kurtosis


def _compound_return(values: Sequence[float]) -> float:
    compounded = 1.0
    for value in values:
        compounded *= 1.0 + value
    return compounded - 1.0


def _expected_max_sharpe(trials: int) -> float:
    """정규 귀무분포에서 여러 번 시도했을 때의 일별 최대 SR 기대값 근사."""
    if trials <= 1:
        return 0.0
    normal = NormalDist()
    euler_gamma = 0.5772156649015329
    first = normal.inv_cdf(1.0 - 1.0 / trials)
    second = normal.inv_cdf(1.0 - 1.0 / (trials * math.e))
    return (1.0 - euler_gamma) * first + euler_gamma * second


def deflated_sharpe_probability(
    returns: Sequence[float],
    trials: int,
    annualization: int = 252,
) -> dict:
    """관측 Sharpe가 선택편향 보정 기준을 넘을 확률을 계산한다.

    Bailey–López de Prado의 DSR 식을 사용하되, 입력은 일별 수익률이고
    반환하는 Sharpe는 연율화한다. 표본이 너무 짧으면 억지로 숫자를
    만들지 않고 ``available=false``를 반환한다.
    """
    clean = [float(value) for value in returns if math.isfinite(float(value))]
    if len(clean) < MIN_SAMPLE_SIZE:
        return {
            "available": False,
            "reason": f"Deflated Sharpe에는 최소 {MIN_SAMPLE_SIZE}개 일별 수익률이 필요합니다",
            "sample_size": len(clean),
            "trials": trials,
        }

    mean, std, skew, excess_kurtosis = _moments(clean)
    if std <= 0:
        return {
            "available": False,
            "reason": "수익률 변동성이 0이라 Sharpe를 계산할 수 없습니다",
            "sample_size": len(clean),
            "trials": trials,
        }

    daily_sharpe = mean / std
    annualized_sharpe = daily_sharpe * math.sqrt(annualization)
    # The maximum-of-trials term is a standard-normal order statistic scaled
    # by the Sharpe estimator's sampling error (approximately 1/sqrt(T)).
    expected_max_daily = _expected_max_sharpe(max(trials, 1)) / math.sqrt(len(clean))
    expected_max_annualized = expected_max_daily * math.sqrt(annualization)
    denominator = math.sqrt(
        max(
            1e-12,
            1.0
            - skew * daily_sharpe
            + ((excess_kurtosis + 3.0 - 1.0) / 4.0) * daily_sharpe**2,
        )
    )
    z_score = ((daily_sharpe - expected_max_daily) * math.sqrt(len(clean) - 1)) / denominator
    probability = NormalDist().cdf(z_score)
    return {
        "available": True,
        "sample_size": len(clean),
        "trials": trials,
        "observed_sharpe": round(annualized_sharpe, 4),
        "selection_benchmark_sharpe": round(expected_max_annualized, 4),
        "probability": round(probability, 4),
        "skewness": round(skew, 4),
        "excess_kurtosis": round(excess_kurtosis, 4),
    }


def probability_of_backtest_overfitting(
    strategy_returns: Mapping[str, Sequence[float]],
    blocks: int = DEFAULT_BLOCKS,
) -> dict:
    """CSCV 방식으로 PBO를 근사한다.

    각 블록은 시간순 연속 구간이다. 절반의 블록에서 최고 전략을 고른
    뒤 나머지 절반에서 그 전략이 중앙값 아래로 내려가는 비율을 세므로,
    무작위 k-fold보다 시계열 구조를 보존한다. 고정 규칙 전략에는 미래
    라벨 윈도우가 없으므로 별도 purge는 적용하지 않는다.
    """
    names = list(strategy_returns)
    if len(names) < 2:
        return {
            "available": False,
            "reason": "PBO에는 최소 2개 전략의 수익률 곡선이 필요합니다",
            "strategy_count": len(names),
        }
    lengths = {len(strategy_returns[name]) for name in names}
    if len(lengths) != 1:
        return {"available": False, "reason": "전략 수익률 곡선의 길이가 서로 다릅니다"}
    sample_size = lengths.pop()
    if sample_size < MIN_SAMPLE_SIZE or sample_size < blocks * 2:
        return {
            "available": False,
            "reason": f"PBO에는 최소 {MIN_SAMPLE_SIZE}개 시계열 표본이 필요합니다",
            "sample_size": sample_size,
            "strategy_count": len(names),
        }
    if blocks < 2 or blocks % 2:
        return {"available": False, "reason": "블록 수는 2 이상의 짝수여야 합니다"}

    block_size = sample_size // blocks
    block_ranges = [
        range(index * block_size, (index + 1) * block_size)
        for index in range(blocks)
    ]
    half = blocks // 2
    events = 0
    combinations = 0
    for in_sample_blocks in itertools.combinations(range(blocks), half):
        in_sample = set(itertools.chain.from_iterable(block_ranges[index] for index in in_sample_blocks))
        out_sample = [index for index in range(sample_size) if index not in in_sample]
        in_scores = {
            name: _compound_return([strategy_returns[name][index] for index in sorted(in_sample)])
            for name in names
        }
        out_scores = {
            name: _compound_return([strategy_returns[name][index] for index in out_sample])
            for name in names
        }
        selected = max(names, key=lambda name: in_scores[name])
        median = sorted(out_scores.values())[len(out_scores) // 2]
        if out_scores[selected] < median:
            events += 1
        combinations += 1

    return {
        "available": combinations > 0,
        "method": "CSCV_contiguous_blocks",
        "sample_size": sample_size,
        "strategy_count": len(names),
        "blocks": blocks,
        "combinations": combinations,
        "events_below_oos_median": events,
        "pbo": round(events / combinations, 4) if combinations else None,
        "purge_applied": False,
        "embargo_bars": 0,
        "note": "고정 규칙 전략은 미래 라벨 윈도우가 없어 라벨 purge를 적용하지 않았습니다",
    }


def build_robustness_diagnostics(results: Sequence[object]) -> dict:
    """BacktestResult 목록을 API 응답용 paper-only 진단으로 변환한다."""
    strategy_returns: dict[str, list[float]] = {}
    for result in results:
        daily_returns = [float(value) for value in getattr(result, "daily_returns", [])]
        if daily_returns and all(math.isfinite(value) for value in daily_returns):
            strategy_returns[result.strategy] = daily_returns
            continue
        curve = getattr(result, "curve", [])
        values = [float(point["value"]) for point in curve if point.get("value") is not None]
        if len(values) >= 2 and all(math.isfinite(value) and value > 0 for value in values):
            strategy_returns[result.strategy] = [
                values[index] / values[index - 1] - 1.0 for index in range(1, len(values))
            ]

    pbo = probability_of_backtest_overfitting(strategy_returns)
    dsr = {
        name: deflated_sharpe_probability(returns, trials=len(strategy_returns))
        for name, returns in strategy_returns.items()
    }
    return {
        "paper_only": True,
        "method": "CSCV_PBO_and_Deflated_Sharpe",
        "pbo": pbo,
        "deflated_sharpe": dsr,
        "warning": "진단 지표는 전략 승격·실거래를 자동 승인하지 않습니다",
    }
