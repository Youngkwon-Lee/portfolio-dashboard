"""
지갑 / 거래소 잔고 조회
- Phantom (Solana)  : Solana RPC — 키 불필요
- MetaMask (ETH)    : Etherscan API — 무료 키 (ETHERSCAN_API_KEY)
- Binance           : 인증 계좌 조회 차단 (paper MVP)
"""
import os
from typing import Optional
import httpx
from trading_safety import LiveTradingBlocked

# ──────────────────────────────────────────────
# Solana / Phantom
# ──────────────────────────────────────────────

SOLANA_RPC = "https://api.mainnet-beta.solana.com"

# 주요 SPL 토큰 민트 주소 → 심볼 매핑
SPL_TOKEN_MAP = {
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": "USDC",
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": "USDT",
    "So11111111111111111111111111111111111111112":   "wSOL",
    "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs": "ETH(SOL)",
    "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263": "BONK",
}


async def get_phantom_balance(address: str) -> dict:
    """Solana 지갑 SOL + 주요 SPL 토큰 잔고."""
    async with httpx.AsyncClient(timeout=15) as client:
        # SOL 잔고
        sol_resp = await client.post(SOLANA_RPC, json={
            "jsonrpc": "2.0", "id": 1, "method": "getBalance",
            "params": [address]
        })
        sol_resp.raise_for_status()
        lamports = sol_resp.json().get("result", {}).get("value", 0)
        sol_balance = lamports / 1e9

        # SPL 토큰 잔고
        token_resp = await client.post(SOLANA_RPC, json={
            "jsonrpc": "2.0", "id": 2,
            "method": "getTokenAccountsByOwner",
            "params": [
                address,
                {"programId": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"},
                {"encoding": "jsonParsed"}
            ]
        })
        token_resp.raise_for_status()
        token_accounts = token_resp.json().get("result", {}).get("value", [])

    tokens = []
    for acc in token_accounts:
        info = acc["account"]["data"]["parsed"]["info"]
        mint = info.get("mint", "")
        amount = float(info["tokenAmount"]["uiAmount"] or 0)
        if amount > 0:
            tokens.append({
                "symbol": SPL_TOKEN_MAP.get(mint, mint[:6] + "..."),
                "mint": mint,
                "balance": amount,
            })

    return {
        "wallet": "phantom",
        "address": address,
        "sol": sol_balance,
        "tokens": tokens,
    }


# ──────────────────────────────────────────────
# Ethereum / MetaMask
# ──────────────────────────────────────────────

ETHERSCAN_BASE = "https://api.etherscan.io/v2/api"

# 주요 ERC-20 컨트랙트
ERC20_TOKENS = {
    "0xdac17f958d2ee523a2206206994597c13d831ec7": "USDT",
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": "USDC",
    "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599": "WBTC",
    "0x7d1afa7b718fb893db30a3abc0cfc608aacfebb0": "MATIC",
    "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984": "UNI",
    "0x514910771af9ca656af840dff83e8264ecf986ca": "LINK",
}


async def get_metamask_balance(address: str, api_key: Optional[str] = None) -> dict:
    """ETH + 주요 ERC-20 잔고."""
    key = api_key or os.getenv("ETHERSCAN_API_KEY", "")
    params_base = {"apikey": key, "chainid": "1"} if key else {"chainid": "1"}

    async with httpx.AsyncClient(timeout=15) as client:
        # ETH 잔고
        eth_resp = await client.get(ETHERSCAN_BASE, params={
            **params_base,
            "module": "account", "action": "balance",
            "address": address, "tag": "latest",
        })
        eth_resp.raise_for_status()
        wei = int(eth_resp.json().get("result", "0") or "0")
        eth_balance = wei / 1e18

        # ERC-20 토큰 잔고 (tokentx 최근 내역으로 보유 토큰 파악)
        tx_resp = await client.get(ETHERSCAN_BASE, params={
            **params_base,
            "module": "account", "action": "tokentx",
            "address": address, "startblock": 0, "endblock": 99999999,
            "sort": "desc", "offset": 100,
        })
        tx_resp.raise_for_status()
        tx_data = tx_resp.json().get("result", [])

    # 토큰별 최신 잔고 집계
    token_balances: dict[str, dict] = {}
    if isinstance(tx_data, list):
        for tx in tx_data:
            contract = tx.get("contractAddress", "").lower()
            symbol = tx.get("tokenSymbol", ERC20_TOKENS.get(contract, contract[:6]))
            decimals = int(tx.get("tokenDecimal", 18) or 18)
            # 잔고는 별도 API로 정확히 조회
            if contract not in token_balances:
                token_balances[contract] = {"symbol": symbol, "decimals": decimals}

    # 각 토큰 실제 잔고 조회 (최대 5개)
    tokens = []
    async with httpx.AsyncClient(timeout=15) as client:
        for contract, meta in list(token_balances.items())[:5]:
            try:
                r = await client.get(ETHERSCAN_BASE, params={
                    **params_base,
                    "module": "account", "action": "tokenbalance",
                    "contractaddress": contract,
                    "address": address, "tag": "latest",
                })
                raw = int(r.json().get("result", "0") or "0")
                amount = raw / (10 ** meta["decimals"])
                if amount > 0.0001:
                    tokens.append({"symbol": meta["symbol"], "balance": round(amount, 6)})
            except Exception:
                pass

    return {
        "wallet": "metamask",
        "address": address,
        "eth": round(eth_balance, 6),
        "tokens": tokens,
    }


# ──────────────────────────────────────────────
# Binance Exchange
# ──────────────────────────────────────────────

async def get_binance_balance(
    api_key: Optional[str] = None,
    api_secret: Optional[str] = None,
) -> dict:
    """Authenticated Binance account access is blocked in the paper MVP."""
    raise LiveTradingBlocked("Binance 계좌 인증 조회는 paper MVP에서 차단됩니다.")
