import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DATA_LABELS, loadingState, scopedState, loadResource, validBalance, validIndices, validPrice, chartCandles } from "../lib/dataProvenance";
import type { Balance, ChartResponse, StockPrice } from "../lib/api";

const balance: Balance = { holdings: [], total_value: 0, total_cost: 0, cash: 0, pnl: 0, pnl_pct: 0 };
const chart: ChartResponse = { ticker: "AAPL", period: "1M", market: "US", candles: [{ date: "2026-11-10", open: 10, high: 12, low: 9, close: 11, volume: 10 }] };
const price: StockPrice = { ticker: "AAPL", name: "Apple", current_price: 11, change: 1, change_pct: 10, volume: 10 };

test("initial loading contains no sample financial values", () => {
  assert.deepEqual(loadingState(), { status: "loading", data: null });
});
test("unreachable health does not request the resource or fabricate samples", async () => {
  let reads = 0;
  const result = await loadResource(async () => false, async () => { reads++; return balance; }, validBalance);
  assert.deepEqual(result, { status: "unavailable", data: null });
  assert.equal(reads, 0);
});
test("health success plus balance rejection is unavailable, not live or a sample", async () => {
  const result = await loadResource(async () => true, async () => { throw new Error("403"); }, validBalance);
  assert.deepEqual(result, { status: "unavailable", data: null });
});
test("successful zero balance is backend response, not missing", async () => {
  assert.deepEqual(await loadResource(async () => true, async () => balance, validBalance), { status: "backend", data: balance });
});
test("failed refresh replaces previously successful values", async () => {
  let state = await loadResource(async () => true, async () => balance, validBalance);
  assert.equal(state.status, "backend");
  state = await loadResource(async () => true, async () => { throw new Error("network"); }, validBalance);
  assert.equal(state.data, null);
  assert.equal(state.status, "unavailable");
});
test("malformed balance and non-finite numbers are not displayed", async () => {
  assert.equal(validBalance({ ...balance, cash: NaN }), false);
  assert.equal(validBalance({ ...balance, holdings: [{}] } as Balance), false);
  assert.equal((await loadResource(async () => true, async () => null as unknown as Balance, validBalance)).status, "unavailable");
});
test("ticker and period changes hide old chart results before effect runs", () => {
  const prior = { key: '["AAPL","1M"]', state: { status: "backend" as const, data: chart.candles } };
  assert.equal(scopedState('["AAPL","1M"]', prior).data, chart.candles);
  assert.deepEqual(scopedState('["BTC","1M"]', prior), loadingState());
  assert.deepEqual(scopedState('["AAPL","1Y"]', prior), loadingState());
});
test("chart failure and empty response never return unrelated candles", async () => {
  assert.deepEqual(chartCandles(chart, "BTC", "1M"), []);
  assert.deepEqual(chartCandles(chart, "AAPL", "1Y"), []);
  const state = await loadResource(async () => true, async () => [], (values) => values.length > 0);
  assert.deepEqual(state, { status: "unavailable", data: null });
});
test("chart accepts requested historical candles and rejects invalid ordering/OHLC", () => {
  assert.deepEqual(chartCandles(chart, "AAPL", "1M"), chart.candles);
  assert.deepEqual(chartCandles({ ...chart, candles: [...chart.candles, ...chart.candles] }, "AAPL", "1M"), []);
  assert.deepEqual(chartCandles({ ...chart, candles: [{ ...chart.candles[0], high: 5 }] }, "AAPL", "1M"), []);
});
test("quotes are scoped to the requested ticker and fail closed", () => {
  assert.equal(validPrice(price, "AAPL"), true);
  assert.equal(validPrice(price, "BTC"), false);
  assert.equal(validPrice({ ...price, current_price: Infinity }, "AAPL"), false);
});
test("indices preserve explicit partial failures without using a mock fallback", () => {
  assert.equal(validIndices([]), false);
  assert.equal(validIndices([{ name: "KOSPI", value: 1, change_pct: 0 }]), true);
  assert.equal(validIndices([{ name: "KOSPI", value: 1, change_pct: 0, error: "failed" }]), true);
});
test("labels distinguish fixture, response and unavailable without asserting market status", () => {
  assert.match(DATA_LABELS.demo, /DEMO.*샘플/);
  assert.match(DATA_LABELS.backend, /백엔드 응답.*PAPER ONLY.*실시간 보장 아님/);
  assert.match(DATA_LABELS.unavailable, /확인할 수 없음/);
  assert.doesNotMatch(DATA_LABELS.unavailable, /미연결|서버 중단/);
});
test("UI wiring clears series, labels fixtures and removes false market/live assertions", () => {
  const hooks = readFileSync("hooks/usePortfolio.ts", "utf8");
  assert.doesNotMatch(hooks, /mockData|samsungPriceData|getMockBalance/);
  assert.match(hooks, /if \(!active\) return;\s*setResult\(\{ key, state \}\)/);
  const candle = readFileSync("components/CandlestickChart.tsx", "utf8");
  assert.doesNotMatch(candle, /if \(!candles.length\) return|candleRef.current.update\(/);
  assert.match(candle, /candleRef.current.setData\(candleData\)/);
  assert.match(candle, /status=\{status\}/);
  assert.doesNotMatch(readFileSync("components/TopBar.tsx", "utf8"), /장 운영 중/);
  assert.match(readFileSync("components/TopBar.tsx", "utf8"), /idx.error \? <DataProvenance status="unavailable"/);
  assert.match(readFileSync("components/TradingPanel.tsx", "utf8"), /DataProvenance status="demo"/);
  assert.match(readFileSync("components/AIAnalysisPanel.tsx", "utf8"), /riskScore === null && <DataProvenance status="demo"/);
});

const kisChart: ChartResponse = {
  ticker: "005930", market: "KRX", period: "1M",
  candles: [
    { date: "20261109", open: 70000, high: 72000, low: 69000, close: 71000, volume: 12000000 },
    { date: "20261110", open: 71000, high: 73000, low: 70000, close: 72000, volume: 13000000 },
  ],
};
test("KIS YYYYMMDD candles normalize to renderer-ready ISO without mutating response", () => {
  const original = JSON.stringify(kisChart);
  assert.deepEqual(chartCandles(kisChart, "005930", "1M"), kisChart.candles.map((c, i) => ({ ...c, date: i === 0 ? "2026-11-09" : "2026-11-10" })));
  assert.equal(JSON.stringify(kisChart), original);
});
test("mixed supported date formats preserve ascending order after normalization", () => {
  const mixed = { ...kisChart, candles: [kisChart.candles[0], { ...kisChart.candles[1], date: "2026-11-10" }] };
  assert.deepEqual(chartCandles(mixed, "005930", "1M").map((c) => c.date), ["2026-11-09", "2026-11-10"]);
});
test("mixed-format duplicate dates and out-of-order dates fail closed", () => {
  const duplicate = { ...kisChart, candles: [kisChart.candles[0], { ...kisChart.candles[1], date: "2026-11-09" }] };
  const reversed = { ...kisChart, candles: [{ ...kisChart.candles[1], date: "2026-11-10" }, kisChart.candles[0]] };
  assert.deepEqual(chartCandles(duplicate, "005930", "1M"), []);
  assert.deepEqual(chartCandles(reversed, "005930", "1M"), []);
});
test("calendar validation rejects rollover, malformed dates, and invalid leap days in either format", () => {
  for (const date of ["2026-02-30", "20260230", "2026-02-29", "20260229", "1900-02-29", "19000229", "2026-04-31", "20260431", "2026-00-10", "20261310", "2026-11-00", "00000101", "2026-1-01", "2026-11-10T00:00:00Z"]) {
    assert.deepEqual(chartCandles({ ...kisChart, candles: [{ ...kisChart.candles[0], date }] }, "005930", "1M"), [], date);
  }
  for (const date of ["2024-02-29", "20240229", "2000-02-29", "20000229"]) {
    assert.equal(chartCandles({ ...kisChart, candles: [{ ...kisChart.candles[0], date }] }, "005930", "1M").length, 1, date);
  }
});
test("normalized KIS candles reject nonpositive and nonfinite OHLC", () => {
  for (const field of ["open", "high", "low", "close"] as const) {
    for (const value of [0, -1, NaN, Infinity]) {
      assert.deepEqual(chartCandles({ ...kisChart, candles: [{ ...kisChart.candles[0], [field]: value }] }, "005930", "1M"), [], field + ":" + value);
    }
  }
});
