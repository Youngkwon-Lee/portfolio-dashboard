import type { Balance, Candle, ChartResponse, IndexPrice, StockPrice } from "./api";

export type DataStatus = "loading" | "market" | "backend" | "unavailable" | "demo";
export type DataState<T> = { status: DataStatus; data: T | null };
export const DATA_LABELS: Record<DataStatus, string> = {
  loading: "불러오는 중",
  market: "공개 시장 데이터 · 지연 가능 · 실시간 보장 아님",
  backend: "백엔드 응답 · PAPER ONLY · 실시간 보장 아님",
  unavailable: "백엔드 데이터를 확인할 수 없음 · 이전 값 미표시",
  demo: "DEMO / 샘플 · 실제 계좌·운영 결과 아님",
};
export function loadingState<T>(): DataState<T> {
  return { status: "loading", data: null };
}
export function scopedState<T>(key: string, result: { key: string; state: DataState<T> }): DataState<T> {
  return result.key === key ? result.state : loadingState<T>();
}
/** Health is only a reachability gate, never proof that a resource succeeded. */
export async function loadResource<T>(health: () => Promise<boolean>, read: () => Promise<T>, valid: (value: T) => boolean): Promise<DataState<T>> {
  try {
    if (!await health()) return { status: "unavailable", data: null };
    const data = await read();
    return valid(data) ? { status: "backend", data } : { status: "unavailable", data: null };
  } catch {
    return { status: "unavailable", data: null };
  }
}
const finite = (...values: number[]) => values.every((v) => typeof v === "number" && Number.isFinite(v));
export function validBalance(b: Balance): boolean {
  return !!b && finite(b.total_value, b.total_cost, b.cash, b.pnl, b.pnl_pct) && Array.isArray(b.holdings) && b.holdings.every((h) =>
    !!h && typeof h.ticker === "string" && typeof h.name === "string" && finite(h.qty, h.avg_cost, h.current_price, h.value, h.return_pct));
}
export function validIndices(values: IndexPrice[]): boolean {
  return Array.isArray(values) && values.length > 0 && values.every((v) => !!v && typeof v.name === "string" && (typeof v.error === "string" && v.error.length > 0 || !v.error && finite(v.value, v.change_pct)));
}
export function validPrice(p: StockPrice, ticker: string): boolean {
  return !!p && p.ticker === ticker && finite(p.current_price, p.change, p.change_pct);
}
/** Canonical daily-chart dates without locale, timezone, or Date rollover parsing. */
function normalizeCandleDate(value: string): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(value) ?? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > monthDays[month - 1]) return null;
  return match[1] + "-" + match[2] + "-" + match[3];
}
export function chartCandles(response: ChartResponse, ticker: string, period: string): Candle[] {
  if (!response || response.ticker !== ticker || response.period !== period || !Array.isArray(response.candles)) return [];
  const candles: Candle[] = [];
  for (const c of response.candles) {
    if (!c) return [];
    const date = normalizeCandleDate(c.date);
    if (!date || !finite(c.open, c.high, c.low, c.close, c.volume) ||
      Math.min(c.open, c.high, c.low, c.close) <= 0 || c.low > Math.min(c.open, c.close) ||
      c.high < Math.max(c.open, c.close) || c.volume < 0 ||
      (candles.length > 0 && candles[candles.length - 1].date >= date)) return [];
    candles.push({ ...c, date });
  }
  return candles;
}
