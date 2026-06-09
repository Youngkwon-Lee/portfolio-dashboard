/**
 * AI 분석 API 유틸 (SSE 스트리밍 지원)
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

// ── SSE 스트리밍 헬퍼 ─────────────────────────

export async function streamPost(
  path: string,
  body: object,
  onChunk: (text: string) => void,
  onDone?: () => void,
): Promise<void> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "API 오류");
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("스트림 없음");

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6);
      if (data === "[DONE]") { onDone?.(); return; }
      onChunk(data);
    }
  }
  onDone?.();
}

// ── 포트폴리오 분석 ───────────────────────────

export async function streamPortfolioAnalysis(
  portfolio: { holdings: object[]; total_value: number; pnl_pct: number },
  onChunk: (text: string) => void,
  onDone?: () => void,
) {
  return streamPost("/api/analyze/portfolio", portfolio, onChunk, onDone);
}

// ── 개별 종목 분석 ────────────────────────────

export async function streamStockAnalysis(
  ticker: string,
  priceData: object,
  onChunk: (text: string) => void,
  onDone?: () => void,
) {
  return streamPost("/api/analyze/stock", { ticker, price_data: priceData }, onChunk, onDone);
}

// ── 전략 추천 ─────────────────────────────────

export interface StrategyAllocation { ticker: string; pct: number; reason: string }
export interface Strategy {
  name: string;
  tag: "High" | "Mid" | "Low";
  description: string;
  allocations: StrategyAllocation[];
  expected_return: string;
  risk_level: string;
}

export async function getAIStrategies(
  holdings: object[],
  totalValue: number,
  riskAppetite: "aggressive" | "balanced" | "conservative" = "balanced",
): Promise<Strategy[]> {
  const res = await fetch(`${API_BASE}/api/analyze/strategies`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ holdings, total_value: totalValue, risk_appetite: riskAppetite }),
  });
  if (!res.ok) throw new Error(`전략 조회 실패: ${res.status}`);
  const data = await res.json();
  return data.strategies ?? [];
}

// ── 채팅 ──────────────────────────────────────

export async function streamChat(
  question: string,
  portfolio: object | null,
  onChunk: (text: string) => void,
  onDone?: () => void,
) {
  return streamPost("/api/chat", { question, portfolio }, onChunk, onDone);
}
