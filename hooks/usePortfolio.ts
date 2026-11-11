"use client";
import { useState, useEffect } from "react";
import { checkHealth, getBalance, getChart, getPrice, getIndices } from "@/lib/api";
import type { Candle, StockPrice } from "@/lib/api";
import { loadingState, scopedState, loadResource, validBalance, validIndices, validPrice, chartCandles, type DataState } from "@/lib/dataProvenance";

let _backendUp: boolean | null = null;
let _lastChecked = 0;

async function isBackendUp(): Promise<boolean> {
  const now = Date.now();
  if (_backendUp !== null && now - _lastChecked < 30_000) return _backendUp;
  _backendUp = await checkHealth();
  _lastChecked = now;
  return _backendUp;
}


// Results are key-scoped during render as well as cancellation-scoped after I/O.
// Polls do not overlap; a failed refresh clears values instead of implying live data.
function useResource<T>(key: string, read: () => Promise<T>, valid: (value: T) => boolean, interval?: number, publicMarket = false) {
  const [result, setResult] = useState<{key: string; state: DataState<T>}>(() => ({ key, state: loadingState<T>() }));
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      if (!active) return;
      setResult({ key, state: loadingState<T>() });
      const loaded = await loadResource(publicMarket ? async () => true : isBackendUp, read, valid);
      const state: DataState<T> = publicMarket && loaded.status === "backend" ? { ...loaded, status: "market" } : loaded;
      if (!active) return;
      setResult({ key, state });
      if (interval) timer = setTimeout(load, interval);
    }
    void load();
    return () => { active = false; if (timer) clearTimeout(timer); };
    // The key identifies the complete request, not the per-render closures.
  }, [key, interval, publicMarket]); // eslint-disable-line react-hooks/exhaustive-deps
  return scopedState(key, result);
}

export function useBalance(refreshInterval = 30_000) {
  const state = useResource("balance", getBalance, validBalance, refreshInterval);
  return { ...state, loading: state.status === "loading" };
}

const EMPTY_CANDLES: Candle[] = [];
export function useChart(ticker: string, period: "1M" | "3M" | "6M" | "1Y") {
  const state = useResource(
    JSON.stringify([ticker, period]),
    async () => {
      const response = await getChart(ticker, period);
      return { ...response, candles: chartCandles(response, ticker, period) };
    },
    (response) => chartCandles(response, ticker, period).length > 0,
    undefined, true,
  );
  return { ...state, metadata: state.data, candles: state.data?.candles ?? EMPTY_CANDLES, loading: state.status === "loading" };
}

export function usePrice(ticker: string) {
  return useResource(ticker, () => getPrice(ticker), (p) => validPrice(p, ticker), 10_000, true);
}

export function useIndices() {
  return useResource("indices", getIndices, validIndices, 30_000, true);
}

// ─────────────────────────────────────────────────
// useMultiPrice — 여러 종목 현재가 (watchlist용)
// ─────────────────────────────────────────────────

export function useMultiPrice(tickers: string[], intervalMs = 15_000) {
  const key = JSON.stringify(tickers);
  const [result, setResult] = useState<{key: string; prices: Record<string, StockPrice>}>({key: "", prices: {}});
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      setResult({ key, prices: {} });
      if (!tickers.length || tickers.length > 10) return;
      try {
        const { getPrices } = await import("@/lib/api");
        const values = await getPrices(tickers);
        const map: Record<string, StockPrice> = {};
        if (!Array.isArray(values) || values.length !== tickers.length || values.some((p, i) => !validPrice(p, tickers[i]))) throw new Error("Invalid quotes");
        values.forEach(p => { map[p.ticker] = p; });
        if (active) setResult({ key, prices: map });
      } catch { if (active) setResult({ key, prices: {} }); }
      if (active) timer = setTimeout(load, intervalMs);
    }
    void load();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [key, intervalMs]); // eslint-disable-line react-hooks/exhaustive-deps
  return result.key === key ? result.prices : {};
}
