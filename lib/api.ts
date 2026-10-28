/**
 * FastAPI 백엔드 호출 유틸 (v2 — 멀티마켓)
 */

import { API_BASE } from "@/lib/apiBase";

async function fetchAPI<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: "include",
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

export interface ResearchInstrument {
  symbol: string;
  exchange: string;
  name: string;
  currency: string;
}

export interface ResearchStatus {
  mode: "shadow";
  live_verified: boolean;
  fixture_available: boolean;
  public_data_available: boolean;
  secrets_exposed: boolean;
  execution_mode: "paper";
  live_allowed: false;
  tradingview: {
    status: "ready" | "configured_unverified" | "not_configured";
    configured: boolean;
    auth_owner: "backend";
    oauth: string;
    server_url: string;
  };
  jev: {
    status: "ready" | "configured_unverified" | "not_configured";
    configured: boolean;
    auth_owner: "backend";
    api_url: string;
    model: string;
  };
  public_data: {
    status: "available";
    provider: string;
    live_verified: false;
  };
}

export type ResearchStatusValue = "evaluated" | "deferred" | "error";

export interface ResearchRunRequest {
  symbol: string;
  exchange: string;
  interval?: "1D";
  source: "fixture" | "yahoo_public" | "tradingview";
  strategy: string;
  decision_provider: "mock" | "jev";
  request_key: string;
}

export interface ResearchSnapshot {
  snapshot_id: string;
  symbol: string;
  exchange: string;
  currency: string;
  interval: string;
  source: string;
  observed_at: string;
  fetched_at: string;
  bar_closed: boolean;
  latency_ms: number | null;
  bars: Candle[];
  ohlcv: {
    date: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  };
  indicators: {
    return_20d_pct: number | null;
    sma_20: number | null;
    rsi_14: number | null;
  };
  quality: {
    status: string;
    issues: string[];
    provider_mode?: string;
  };
}

export interface ResearchAnswer {
  question_id: string;
  answer: string;
  distribution: Record<string, number>;
  confidence: number;
  reason_code: string;
}

export interface ResearchDecision {
  status: ResearchStatusValue;
  provider: string;
  model_version: string | null;
  question_version: string;
  answers: ResearchAnswer[];
  overall: string;
  confidence: number;
  usage: Record<string, number> | null;
  cost: number | null;
  latency_ms: number;
}

export interface ResearchStrategySignal {
  strategy: string;
  strategy_label: string;
  signal: "BUY" | "SELL" | "HOLD";
  signal_basis: string;
  latest_event: { date: string; side: string; price: number; cost: number } | null;
  bars_used: number;
  backtest_return_pct: number;
}

export interface ResearchRun {
  run_id: string;
  request_key: string | null;
  status: ResearchStatusValue;
  mode: "shadow";
  execution_mode: "paper";
  live_allowed: false;
  live_verified: false;
  symbol: string;
  exchange: string;
  interval: string;
  source: string;
  strategy: string;
  strategy_version: string;
  question_version: string;
  policy_version: string;
  input_hash: string;
  created_at: string;
  latency_ms: number;
  snapshot: ResearchSnapshot | null;
  state: {
    snapshot: ResearchSnapshot;
    strategy_signal: ResearchStrategySignal;
    policy_version: string;
  } | null;
  decision: ResearchDecision | null;
  error: { code: string; message: string } | null;
  replayed: boolean;
}

export interface ResearchRunSummary {
  run_id: string;
  request_key: string | null;
  status: ResearchStatusValue;
  symbol: string;
  exchange: string;
  interval: string;
  source: string;
  strategy: string;
  created_at: string;
  signal: "BUY" | "SELL" | "HOLD" | null;
  overall: string | null;
  error: { code: string; message: string } | null;
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

export async function getResearchStatus(): Promise<ResearchStatus> {
  return fetchAPI("/api/research/status");
}

export async function searchResearchInstruments(
  query = "",
  source: "fixture" | "yahoo_public" | "tradingview" = "fixture",
): Promise<ResearchInstrument[]> {
  const params = new URLSearchParams({ query, source });
  const result = await fetchAPI<{ instruments: ResearchInstrument[] }>(
    `/api/research/instruments?${params.toString()}`,
  );
  return result.instruments;
}

export async function runResearch(request: ResearchRunRequest): Promise<ResearchRun> {
  return fetchAPI("/api/research/runs", {
    method: "POST",
    body: JSON.stringify(request),
  });
}

export async function getResearchRuns(limit = 20): Promise<ResearchRunSummary[]> {
  const result = await fetchAPI<{ runs: ResearchRunSummary[] }>(`/api/research/runs?limit=${limit}`);
  return result.runs;
}

export async function getResearchRun(runId: string): Promise<ResearchRun> {
  return fetchAPI(`/api/research/runs/${encodeURIComponent(runId)}`);
}

/** 백엔드 연결 확인 */
export async function checkHealth(): Promise<boolean> {
  try {
    const r = await fetch(`${API_BASE}/health`, {
      credentials: "include",
      signal: AbortSignal.timeout(1500),
      cache: "no-store",
    });
    return r.ok;
  } catch {
    return false;
  }
}
