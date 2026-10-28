"""One-time TradingView OAuth 2.1 bootstrap for local M0 verification.

This command opens no public listener: the callback binds to 127.0.0.1 only.
Tokens are written to the macOS Keychain and never printed.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import http.server
import json
import os
import secrets
import subprocess
import sys
import threading
import time
from getpass import getuser
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse

import httpx

import research_workflow as research


REDIRECT_URI = "http://127.0.0.1:8765/callback"
AUTHORIZATION_ENDPOINT = "https://www.tradingview.com/mcp/oauth/authorize"
TOKEN_ENDPOINT = "https://www.tradingview.com/mcp/oauth/token"
RESOURCE = "https://mcp.tradingview.com/mcp"
KEYCHAIN_SERVICE = "portfolio-dashboard.tradingview.mcp.oauth"


class CallbackState:
    def __init__(self, expected_state: str):
        self.expected_state = expected_state
        self.code: str | None = None
        self.error: str | None = None
        self.done = threading.Event()


def _keychain_write(tokens: dict[str, Any]) -> None:
    expires_in = tokens.get("expires_in")
    tokens = {
        **tokens,
        "stored_at": time.time(),
        "expires_at": time.time() + float(expires_in) if expires_in else None,
    }
    payload = json.dumps(tokens, ensure_ascii=False, separators=(",", ":"))
    subprocess.run(
        [
            "security",
            "add-generic-password",
            "-a",
            getuser(),
            "-s",
            KEYCHAIN_SERVICE,
            "-w",
            payload,
            "-U",
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


class CallbackHandler(http.server.BaseHTTPRequestHandler):
    callback_state: CallbackState

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler contract
        parsed = urlparse(self.path)
        if parsed.path != "/callback":
            self.send_error(404)
            return
        query = parse_qs(parsed.query)
        state = query.get("state", [""])[0]
        if state != self.callback_state.expected_state:
            self.callback_state.error = "oauth_state_mismatch"
        elif query.get("error"):
            self.callback_state.error = query.get("error", ["oauth_denied"])[0]
        else:
            self.callback_state.code = query.get("code", [""])[0]
            if not self.callback_state.code:
                self.callback_state.error = "oauth_code_missing"
        self.send_response(200 if self.callback_state.code else 400)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        message = (
            "Authorization complete. You can return to Codex."
            if self.callback_state.code
            else "Authorization failed. You can return to Codex."
        )
        self.wfile.write(f"<html><body><h1>{message}</h1></body></html>".encode("utf-8"))
        self.callback_state.done.set()

    def log_message(self, format: str, *args: object) -> None:
        return None


def _authorization_url(client_id: str, state: str, verifier: str) -> str:
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return AUTHORIZATION_ENDPOINT + "?" + urlencode(
        {
            "response_type": "code",
            "client_id": client_id,
            "redirect_uri": REDIRECT_URI,
            "scope": "mcp:read mcp:tools",
            "state": state,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "resource": RESOURCE,
        }
    )


def _exchange_code(client_id: str, code: str, verifier: str) -> dict[str, Any]:
    response = httpx.post(
        TOKEN_ENDPOINT,
        data={
            "grant_type": "authorization_code",
            "client_id": client_id,
            "code": code,
            "redirect_uri": REDIRECT_URI,
            "code_verifier": verifier,
            "resource": RESOURCE,
        },
        timeout=30,
    )
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict) or not payload.get("access_token"):
        raise RuntimeError("TradingView OAuth token response did not contain an access token")
    return payload


async def _verify(access_token: str, query: str) -> dict[str, Any]:
    provider = research.TradingViewMcpProvider(access_token=access_token)
    instruments = await provider.search(query)
    if not instruments:
        raise research.ResearchProviderError("instrument_not_found", "TradingView returned no matching symbols")
    instrument = instruments[0]
    snapshot = await provider.snapshot(instrument["symbol"], instrument["exchange"], "1D")
    issues = research.validate_snapshot(snapshot)
    return {
        "instrument": instrument,
        "snapshot": {
            "source": snapshot.source,
            "symbol": snapshot.symbol,
            "exchange": snapshot.exchange,
            "bars": len(snapshot.bars),
            "bar_closed": snapshot.bar_closed,
            "observed_at": snapshot.observed_at,
            "quality_issues": issues,
        },
        "status": "verified" if not issues else "deferred",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Bootstrap TradingView OAuth for local PortfolioAI M0.")
    parser.add_argument("--client-id", default=os.getenv("TRADINGVIEW_OAUTH_CLIENT_ID", ""))
    parser.add_argument("--query", default="AAPL")
    args = parser.parse_args()
    if not args.client_id:
        print("TRADINGVIEW_OAUTH_CLIENT_ID is required", file=sys.stderr)
        return 2

    state = secrets.token_urlsafe(32)
    verifier = secrets.token_urlsafe(64)
    callback_state = CallbackState(state)
    CallbackHandler.callback_state = callback_state
    server = http.server.HTTPServer(("127.0.0.1", 8765), CallbackHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    print(_authorization_url(args.client_id, state, verifier), flush=True)
    callback_state.done.wait(timeout=300)
    server.shutdown()
    server.server_close()
    if callback_state.error or not callback_state.code:
        print(json.dumps({"status": "oauth_failed", "error": callback_state.error or "callback_timeout"}))
        return 1

    try:
        tokens = _exchange_code(args.client_id, callback_state.code, verifier)
        _keychain_write(tokens)
        verification = __import__("asyncio").run(_verify(tokens["access_token"], args.query))
    except Exception:
        print(json.dumps({"status": "oauth_or_verification_failed", "token_stored": False}))
        return 1

    print(
        json.dumps(
            {
                "status": "oauth_complete",
                "token_stored": True,
                "keychain_service": KEYCHAIN_SERVICE,
                "verification": verification,
                "refresh_verified": False,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
