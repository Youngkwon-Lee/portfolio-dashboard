"""
알림 모듈 — 텔레그램 봇 + Discord webhook
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
  - 매수/매도 체결 (SL/TP/DCA 포함)
  - 서킷브레이커 발동
  - 일일 리포트
  - 텔레그램 명령어: /status /stop /report /help
"""

import asyncio
import html
import os
import logging
import re
from typing import Optional, Callable
import httpx

logger = logging.getLogger("notifier")

TELEGRAM_BASE = "https://api.telegram.org"
DISCORD_MAX_MESSAGE = 2000

# 명령어 핸들러 등록 (trading_bot에서 주입)
_cmd_handlers: dict[str, Callable] = {}
_polling_task: Optional[asyncio.Task] = None
_last_update_id: int = 0


def _token()   -> str: return os.getenv("TELEGRAM_BOT_TOKEN", "")
def _chat_id() -> str: return os.getenv("TELEGRAM_CHAT_ID", "")
def _discord_webhook() -> str: return os.getenv("DISCORD_WEBHOOK_URL", "")


def _enabled() -> bool:
    return bool(_token() and _chat_id())


def _discord_enabled() -> bool:
    return bool(_discord_webhook())


def _discord_content(text: str) -> str:
    """Reuse Telegram templates without leaking HTML markup into Discord."""
    return html.unescape(re.sub(r"<[^>]+>", "", text))[:DISCORD_MAX_MESSAGE]


def register_handler(command: str, fn: Callable):
    """명령어 핸들러 등록. command: "/status" 형태."""
    _cmd_handlers[command] = fn


async def send(text: str, parse_mode: str = "HTML") -> bool:
    """Configured notification channels에 best-effort 전송. 실패가 주문을 막지 않는다."""
    delivered = False
    if _enabled():
        try:
            async with httpx.AsyncClient(timeout=8) as client:
                resp = await client.post(
                    f"{TELEGRAM_BASE}/bot{_token()}/sendMessage",
                    json={"chat_id": _chat_id(), "text": text, "parse_mode": parse_mode},
                )
                delivered = resp.status_code == 200 or delivered
        except Exception as e:
            logger.warning("텔레그램 전송 실패: %s", type(e).__name__)

    if _discord_enabled():
        try:
            async with httpx.AsyncClient(timeout=8) as client:
                resp = await client.post(
                    _discord_webhook(),
                    json={"content": _discord_content(text)},
                )
                delivered = resp.status_code in (200, 204) or delivered
        except Exception as e:
            logger.warning("Discord 전송 실패: %s", type(e).__name__)

    if not _enabled() and not _discord_enabled():
        logger.info("[NOTIFY-SKIP] %s", text[:80])
    return delivered


# ── 명령어 폴링 ──────────────────────────────────

async def _poll_commands():
    """백그라운드에서 텔레그램 명령어를 폴링."""
    global _last_update_id
    while True:
        try:
            async with httpx.AsyncClient(timeout=35) as client:
                resp = await client.get(
                    f"{TELEGRAM_BASE}/bot{_token()}/getUpdates",
                    params={"offset": _last_update_id + 1, "timeout": 30, "allowed_updates": ["message"]},
                )
                if resp.status_code != 200:
                    await asyncio.sleep(5)
                    continue
                updates = resp.json().get("result", [])

            for upd in updates:
                _last_update_id = upd["update_id"]
                msg = upd.get("message", {})
                text = msg.get("text", "").strip()
                chat_id = str(msg.get("chat", {}).get("id", ""))

                # 등록된 채팅 ID만 허용
                if chat_id != _chat_id():
                    continue

                # /command 파싱
                cmd = text.split()[0].lower() if text.startswith("/") else ""
                if cmd and cmd in _cmd_handlers:
                    try:
                        result = await _cmd_handlers[cmd]()
                        await send(result)
                    except Exception as e:
                        await send(f"❌ 오류: {e}")
                elif cmd == "/help":
                    await send(
                        "📖 <b>사용 가능한 명령어</b>\n"
                        "/status — 봇 현재 상태\n"
                        "/stop   — 봇 정지\n"
                        "/report — 손익 리포트\n"
                        "/help   — 도움말"
                    )

        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.warning(f"폴링 오류: {e}")
            await asyncio.sleep(10)


def start_polling():
    """명령어 폴링 시작 (백그라운드 태스크)."""
    global _polling_task
    if not _enabled():
        return
    if _polling_task and not _polling_task.done():
        return
    _polling_task = asyncio.create_task(_poll_commands())
    logger.info("텔레그램 명령어 폴링 시작")


def stop_polling():
    global _polling_task
    if _polling_task and not _polling_task.done():
        _polling_task.cancel()
        _polling_task = None


# ── 미리 만든 메시지 템플릿 ───────────────────────

async def notify_bot_start(mode: str, strategy: str, symbols: list[str], capital: float):
    emoji = "📋" if mode == "paper" else "⚡"
    await send(
        f"{emoji} <b>봇 시작</b>\n"
        f"모드: <code>{mode.upper()}</code>\n"
        f"전략: <code>{strategy}</code>\n"
        f"종목: <code>{', '.join(symbols)}</code>\n"
        f"자본: <code>{capital:,.0f}원</code>\n\n"
        f"💬 명령어: /status /stop /report /help"
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
        f"⚠️ 봇이 자동 정지되었습니다."
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
