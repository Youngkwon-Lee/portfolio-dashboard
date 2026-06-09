"""
뉴스 감성 분석
────────────────────────────────────────────
뉴스 소스  : CryptoPanic API (무료) + RSS 파싱
감성 분석  : GPT-4o-mini (OpenAI)
출력       : {score: -1~1, label: bearish/neutral/bullish, summary, news}
"""

import os
import json
import asyncio
import logging
from datetime import datetime, timezone
import httpx
from openai import AsyncOpenAI

logger = logging.getLogger("news_sentiment")

CRYPTOPANIC_BASE = "https://cryptopanic.com/api/v1"
# 무료 API — https://cryptopanic.com/developers/api/
# 키 없어도 기본 뉴스는 조회 가능 (제한적)


def _oai():
    return AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY", ""))


async def _fetch_cryptopanic(ticker: str, limit: int = 10) -> list[dict]:
    """CryptoPanic에서 최신 뉴스 가져오기."""
    token = os.getenv("CRYPTOPANIC_TOKEN", "")
    params: dict = {
        "currencies": ticker.upper(),
        "public":     "true",
        "kind":       "news",
        "limit":      limit,
    }
    if token:
        params["auth_token"] = token

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(f"{CRYPTOPANIC_BASE}/posts/", params=params)
            resp.raise_for_status()
            data = resp.json()
            results = data.get("results", [])
            return [
                {
                    "title":      r.get("title", ""),
                    "url":        r.get("url", ""),
                    "source":     r.get("source", {}).get("domain", ""),
                    "published":  r.get("published_at", ""),
                    "votes_pos":  r.get("votes", {}).get("positive", 0),
                    "votes_neg":  r.get("votes", {}).get("negative", 0),
                }
                for r in results
            ]
    except Exception as e:
        logger.warning(f"CryptoPanic 조회 실패: {e}")
        return []


async def _gpt_sentiment(ticker: str, headlines: list[str]) -> dict:
    """GPT로 헤드라인 감성 분석."""
    if not os.getenv("OPENAI_API_KEY", "").startswith("sk-"):
        return {"score": 0, "label": "neutral", "summary": "API 키 없음", "signals": []}

    prompt = f"""다음은 {ticker} 관련 최신 뉴스 헤드라인입니다.

{chr(10).join(f'{i+1}. {h}' for i, h in enumerate(headlines[:10]))}

아래 JSON 형식으로만 응답하세요:
{{
  "score": -1.0 ~ 1.0 사이 숫자 (강한 하락=-1, 중립=0, 강한 상승=1),
  "label": "bearish" | "neutral" | "bullish",
  "summary": "3문장 이내 한국어 요약",
  "signals": ["주목할 키워드 1", "키워드 2", "키워드 3"]
}}"""

    try:
        resp = await _oai().chat.completions.create(
            model="gpt-4o-mini",
            max_tokens=300,
            messages=[
                {"role": "system", "content": "크립토 시장 분석 전문가. JSON만 출력."},
                {"role": "user",   "content": prompt},
            ],
            response_format={"type": "json_object"},
        )
        return json.loads(resp.choices[0].message.content or "{}")
    except Exception as e:
        logger.warning(f"GPT 감성 분석 실패: {e}")
        return {"score": 0, "label": "neutral", "summary": str(e), "signals": []}


async def analyze(ticker: str) -> dict:
    """종목 뉴스 감성 분석 통합."""
    news = await _fetch_cryptopanic(ticker)

    # CryptoPanic 커뮤니티 투표로 기본 점수 계산
    vote_score = 0.0
    if news:
        total_pos = sum(n["votes_pos"] for n in news)
        total_neg = sum(n["votes_neg"] for n in news)
        total_votes = total_pos + total_neg
        if total_votes > 0:
            vote_score = (total_pos - total_neg) / total_votes

    headlines = [n["title"] for n in news if n["title"]]

    if headlines:
        gpt = await _gpt_sentiment(ticker, headlines)
    else:
        # 뉴스 없을 때 기본값
        gpt = {"score": 0, "label": "neutral", "summary": "뉴스 데이터 없음", "signals": []}

    # 최종 점수: GPT 70% + 커뮤니티 투표 30%
    final_score = gpt.get("score", 0) * 0.7 + vote_score * 0.3
    final_score = max(-1.0, min(1.0, final_score))

    label = "bullish" if final_score > 0.2 else "bearish" if final_score < -0.2 else "neutral"

    return {
        "ticker":      ticker.upper(),
        "score":       round(final_score, 3),
        "label":       label,
        "summary":     gpt.get("summary", ""),
        "signals":     gpt.get("signals", []),
        "vote_score":  round(vote_score, 3),
        "news_count":  len(news),
        "news":        news[:5],
        "updated_at":  datetime.now(timezone.utc).isoformat(),
    }


async def analyze_portfolio(tickers: list[str]) -> dict:
    """여러 종목 동시 감성 분석."""
    tasks = [analyze(t) for t in tickers]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    return {
        tickers[i]: r if not isinstance(r, Exception) else {"error": str(r)}
        for i, r in enumerate(results)
    }
