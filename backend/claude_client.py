"""
AI 분석 클라이언트 (OpenAI GPT)
- 포트폴리오 리스크 분석
- 개별 종목 분석
- 전략 추천 (JSON)
- 자유 채팅
모두 스트리밍 응답 지원
"""
import os
import json
from typing import AsyncGenerator
from openai import AsyncOpenAI

MODEL = "gpt-4o-mini"   # 빠르고 저렴; gpt-4o로 변경하면 품질 향상

def _client() -> AsyncOpenAI:
    """API 키를 실제 호출 시점에 읽어서 클라이언트 생성 (지연 초기화)."""
    return AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY", ""))

SYSTEM_PROMPT = (
    "당신은 개인 투자자를 위한 포트폴리오 분석 AI입니다. "
    "간결하고 핵심적인 한국어로 답변합니다. "
    "수치 근거를 들어 설명하며, 투자 권유가 아닌 분석/참고용임을 전제합니다. "
    "마크다운 없이 plain text로 작성합니다. "
    "각 항목은 2-3문장 이내로 요약합니다."
)


# ── 공통 스트리밍 헬퍼 ─────────────────────────

async def _stream(messages: list[dict], max_tokens: int = 600) -> AsyncGenerator[str, None]:
    stream = await _client().chat.completions.create(
        model=MODEL,
        max_tokens=max_tokens,
        messages=messages,
        stream=True,
    )
    async for chunk in stream:
        delta = chunk.choices[0].delta.content
        if delta:
            yield delta


# ──────────────────────────────────────────────
# 포트폴리오 종합 분석 (스트리밍)
# ──────────────────────────────────────────────

async def stream_portfolio_analysis(portfolio: dict) -> AsyncGenerator[str, None]:
    holdings_text = "\n".join(
        f"  - {h['ticker']} ({h.get('name','')}) | 평가금액: {h['value']:,}원 | 수익률: {h['return_pct']:+.2f}%"
        for h in portfolio.get("holdings", [])
    )
    total = portfolio.get("total_value", 0)
    pnl   = portfolio.get("pnl_pct", 0)

    prompt = f"""다음 포트폴리오를 분석해주세요.

총 자산: {total:,}원 | 총 수익률: {pnl:+.2f}%

보유 종목:
{holdings_text}

다음 3가지를 각각 분석해주세요:
1. [리스크 점수] 0-100 숫자만 먼저 출력 후, 주요 리스크 요인 1-2가지
2. [집중도 분석] 섹터/자산 쏠림 여부
3. [개선 제안] 다각화 또는 비중 조정 관점에서 구체적 제안 1가지"""

    async for chunk in _stream([
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user",   "content": prompt},
    ], max_tokens=600):
        yield chunk


# ──────────────────────────────────────────────
# 개별 종목 분석 (스트리밍)
# ──────────────────────────────────────────────

async def stream_stock_analysis(ticker: str, price_data: dict) -> AsyncGenerator[str, None]:
    prompt = f"""종목 {ticker} ({price_data.get('name','')})을 분석해주세요.

현재가: {price_data.get('current_price', 0):,} | 당일 등락: {price_data.get('change_pct', 0):+.2f}%
고가: {price_data.get('high', 0):,} | 저가: {price_data.get('low', 0):,}
거래량: {price_data.get('volume', 0):,}

다음을 간략히 분석해주세요:
1. 당일 가격 움직임 해석
2. 단기 주목 포인트 1가지
3. 투자자 주의사항 1가지"""

    async for chunk in _stream([
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user",   "content": prompt},
    ], max_tokens=300):
        yield chunk


# ──────────────────────────────────────────────
# 전략 추천 (JSON 구조화 응답)
# ──────────────────────────────────────────────

async def get_strategy_recommendations(portfolio: dict, risk_appetite: str = "balanced") -> dict:
    holdings_tickers = [h["ticker"] for h in portfolio.get("holdings", [])]

    prompt = f"""현재 보유 종목: {', '.join(holdings_tickers)}
총 자산: {portfolio.get('total_value', 0):,}원
투자 성향: {risk_appetite}

위 포트폴리오를 기반으로 3가지 전략을 JSON으로 추천해주세요.
반드시 아래 형식만 출력하고 다른 텍스트는 없어야 합니다:

{{
  "strategies": [
    {{
      "name": "전략명 (한국어)",
      "tag": "High|Mid|Low",
      "description": "전략 설명 1문장",
      "allocations": [
        {{"ticker": "티커", "pct": 숫자, "reason": "이유 10자 이내"}}
      ],
      "expected_return": "예상 수익률 범위 (예: +15~25%)",
      "risk_level": "높음|보통|낮음"
    }}
  ]
}}"""

    response = await _client().chat.completions.create(
        model=MODEL,
        max_tokens=800,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT + " 항상 유효한 JSON만 출력하세요."},
            {"role": "user",   "content": prompt},
        ],
        response_format={"type": "json_object"},
    )

    text = response.choices[0].message.content or "{}"
    try:
        return json.loads(text)
    except Exception:
        return {
            "strategies": [{
                "name": "균형 포트폴리오",
                "tag": "Mid",
                "description": "현재 보유 종목을 균등 배분하는 안정적 전략",
                "allocations": [{"ticker": t, "pct": round(100 / max(len(holdings_tickers), 1)), "reason": "균등 배분"} for t in holdings_tickers[:3]],
                "expected_return": "+8~15%",
                "risk_level": "보통",
            }]
        }


# ──────────────────────────────────────────────
# 자유 채팅 (스트리밍)
# ──────────────────────────────────────────────

async def stream_chat(
    question: str,
    portfolio_context: dict | None = None,
) -> AsyncGenerator[str, None]:
    context = ""
    if portfolio_context:
        tickers = [h["ticker"] for h in portfolio_context.get("holdings", [])]
        context = f"\n\n[현재 포트폴리오] 보유: {', '.join(tickers)} | 총 자산: {portfolio_context.get('total_value', 0):,}원"

    async for chunk in _stream([
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user",   "content": question + context},
    ], max_tokens=500):
        yield chunk
