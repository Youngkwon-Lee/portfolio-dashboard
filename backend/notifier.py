"""
알림 모듈 — 텔레그램 봇
────────────────────────────────────────────
설정 방법:
  1. @BotFather 에서 /newbot → TELEGRAM_BOT_TOKEN 발급
  2. 봇에게 메시지 1개 보내기
  3. https://api.telegram.org/bot<TOKEN>/getUpdates 로 chat_id 확인
  4. .env 에 추가:
       TELEGRAM_BOT_TOKEN=1234567890:AAF...
       TELEGRAM_CHAT_ID=987654321

알림 종류:
  - 봇 시작/정지
  - 매수/매도 체결
  - 서킷브레이커 발동
  - 일일 리포트 (손익 요약)
"""

import os
import logging
from typing import Optional
import httpx

logger = logging.getLogger("notifier")

TELEGRAM_BASE = "https://api.telegram.org"


def _token()   -> str: return os.getenv("TELEGRAM_BOT_TOKEN", "")
def _chat_id() -> str: return os.getenv("TELEGRAM_CHAT_ID", "")


def _enabled() -> bool:
    return bool(_token() and _chat_id())


async def send(text: str, parse_mode: str = "HTML") -> bool:
    """텔레그램 메시지 전송. 키 없으면 로그만 남기고 조용히 패스."""
    if not _enabled():
        logger.info(f"[NOTIFY-SKIP] {text[:80]}")
        return False
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            resp = await client.post(
                f"{TELEGRAM_BASE}/bot{_token()}/sendMessage",
                json={"chat_id": _chat_id(), "text": text, "parse_mode": parse_mode},
            )
            return resp.status_code == 200
    except Exception as e:
        logger.warning(f"텔레그램 전송 실패: {e}")
        return False


# ── 미리 만든 메시지 템플릿 ───────────────────────

async def notify_bot_start(mode: str, strategy: str, symbols: list[str], capital: float):
    emoji = "📋" if mode == "paper" else "⚡"
    await send(
        f"{emoji} <b>봇 시작</b>\n"
        f"모드: <code>{mode.upper()}</code>\n"
        f"전략: <code>{strategy}</code>\n"
        f"종목: <code>{', '.join(symbols)}</code>\n"
        f"자본: <code>{capital:,.0f}원</code>"
    )


async def notify_bot_stop(total_pnl: float, total_pnl_pct: float, trade_count: int):
    emoji = "🟢" if total_pnl >= 0 else "🔴"
    await send(
        f"⏹ <b>봇 정지</b>\n"
        f"총 손익: {emoji} <code>{total_pnl:+,.0f}원 ({total_pnl_pct:+.2f}%)</code>\n"
        f"총 매매: <code>{trade_count}건</code>"
    )


async def notify_trade(side: str, symbol: str, price: float,
                       qty: float, invest: float, mode: str,
                       pnl: Optional[float] = None, pnl_pct: Optional[float] = None):
    emoji = "🟢 매수" if side == "BUY" else "🔴 매도"
    mode_tag = "📋 페이퍼" if mode == "paper" else "⚡ 실거래"
    msg = (
        f"{emoji} <b>{symbol}</b>  [{mode_tag}]\n"
        f"가격: <code>${price:,.2f}</code>\n"
        f"수량: <code>{qty:.6f}</code>\n"
        f"투자금: <code>{invest:,.0f}원</code>"
    )
    if pnl is not None:
        p_emoji = "✅" if pnl >= 0 else "❌"
        msg += f"\n손익: {p_emoji} <code>{pnl:+,.0f}원 ({pnl_pct:+.2f}%)</code>"
    await send(msg)


async def notify_signal(symbol: str, signal: str, strategy: str, detail: str):
    emoji = {"BUY": "📈", "SELL": "📉", "HOLD": "⏸"}.get(signal, "❓")
    await send(
        f"{emoji} <b>신호 발생</b>  {symbol}\n"
        f"신호: <code>{signal}</code>  전략: <code>{strategy}</code>\n"
        f"<i>{detail}</i>"
    )


async def notify_circuit_breaker(reason: str, total_pnl_pct: float):
    await send(
        f"🛑 <b>서킷브레이커 발동!</b>\n"
        f"사유: {reason}\n"
        f"누적 손익: <code>{total_pnl_pct:+.2f}%</code>\n"
        f"⚠️ 봇이 자동 정지되었습니다. 확인이 필요합니다."
    )


async def notify_daily_report(
    total_pnl: float, total_pnl_pct: float,
    daily_pnl_pct: float, drawdown_pct: float,
    trade_count: int, win_rate: float,
    positions: list[str],
):
    d_emoji = "📈" if daily_pnl_pct >= 0 else "📉"
    t_emoji = "🟢" if total_pnl >= 0 else "🔴"
    await send(
        f"📊 <b>일일 리포트</b>\n"
        f"━━━━━━━━━━━━━━\n"
        f"당일 손익: {d_emoji} <code>{daily_pnl_pct:+.2f}%</code>\n"
        f"누적 손익: {t_emoji} <code>{total_pnl:+,.0f}원 ({total_pnl_pct:+.2f}%)</code>\n"
        f"최대 낙폭: <code>-{drawdown_pct:.2f}%</code>\n"
        f"총 매매: <code>{trade_count}건</code>  승률: <code>{win_rate:.0f}%</code>\n"
        f"보유 중: <code>{', '.join(positions) if positions else '없음'}</code>"
    )
