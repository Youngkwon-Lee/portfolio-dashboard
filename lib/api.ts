/**
 * FastAPI 백엔드 호출 유틸 (v2 — 멀티마켓)
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

async function fetchAPI<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

// ── 마켓 감지 ─────────────────────────────────

export type Market = "KRX" | "US" | "CRYPTO" | "ETF";

const CRYPTO_SET = new Set(["BTC","ETH","BNB","SOL","XRP","ADA","DOGE","DOT","AVAX","MATIC"]);
const ETF_SET    = new Set(["QQQ","SPY","SCHD","IWM","TLT","GLD","VTI","ARKK"]);

export function detectMarket(ticker: string): Market {
  const t = ticker.toUpperCase();
  if (CRYPTO_SET.has(t))           return "CRYPTO";
  if (ETF_SET.has(t))              return "ETF";
  if (/^\d{6}$/.test(t))           return "KRX";
  return "US";
}

// ── 타입 ──────────────────────────────────────

export interface StockPrice {
  ticker: string;
  name: string;
  current_price: number;
  change: number;
  change_pct: number;
  volume: number;
  high?: number;
  low?: number;
  open?: number;
  currency?: string;
  market_cap?: number;
}

export interface Candle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ChartResponse {
  ticker: string;
  market: string;
  period: string;
  candles: Candle[];
}

export interface Holding {
  ticker: string;
  name: string;
  qty: number;
  avg_cost: number;
  current_price: number;
  value: number;
  return_pct: number;
}

export interface Balance {
  holdings: Holding[];
  total_value: number;
  total_cost: number;
  cash: number;
  pnl: number;
  pnl_pct: number;
}

export interface OrderRequest {
  ticker: string;
  side: "buy" | "sell";
  qty: number;
  price?: number;
}

export interface OrderResult {
  order_no: string;
  status: "ok" | "error";
  message: string;
}

export interface IndexPrice {
  name: string;
  value: number;
  change_pct: number;
  error?: string;
}

// ── API 함수 ───────────────────────────────────

/** 통합 현재가 (마켓 자동 판별) */
export async function getPrice(ticker: string, currency = "krw"): Promise<StockPrice> {
  return fetchAPI(`/api/price/${ticker}?currency=${currency}`);
}

/** 복수 현재가 (마켓 혼합 가능) */
export async function getPrices(tickers: string[], currency = "krw"): Promise<StockPrice[]> {
  return fetchAPI(`/api/prices?tickers=${tickers.join(",")}&currency=${currency}`);
}

/** 일봉 차트 (마켓 자동 판별) */
export async function getChart(
  ticker: string,
  period: "1M" | "3M" | "6M" | "1Y" = "1M",
  currency = "krw",
): Promise<ChartResponse> {
  return fetchAPI(`/api/price/${ticker}/chart?period=${period}&currency=${currency}`);
}

/** 계좌 잔고 (KIS) */
export async function getBalance(): Promise<Balance> {
  return fetchAPI("/api/balance");
}

/** 주문 (KIS 국내주식) */
export async function placeOrder(req: OrderRequest): Promise<OrderResult> {
  return fetchAPI("/api/order", { method: "POST", body: JSON.stringify(req) });
}

/** 전체 지수 (국내 + 글로벌 + BTC) */
export async function getIndices(): Promise<IndexPrice[]> {
  return fetchAPI("/api/indices");
}

/** 백엔드 연결 확인 */
export async function checkHealth(): Promise<boolean> {
  try {
    const r = await fetch(`${API_BASE}/health`, {
      signal: AbortSignal.timeout(1500),
      cache: "no-store",
    });
    return r.ok;
  } catch {
    return false;
  }
}
