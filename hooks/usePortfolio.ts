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
function useResource<T>(key: string, read: () => Promise<T>, valid: (value: T) => boolean, interval?: number) {
  const [result, setResult] = useState<{key: string; state: DataState<T>}>(() => ({ key, state: loadingState<T>() }));
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      if (!active) return;
      setResult({ key, state: loadingState<T>() });
      const state = await loadResource(isBackendUp, read, valid);
      if (!active) return;
      setResult({ key, state });
      if (interval) timer = setTimeout(load, interval);
    }
    void load();
    return () => { active = false; if (timer) clearTimeout(timer); };
    // The key identifies the complete request, not the per-render closures.
  }, [key, interval]); // eslint-disable-line react-hooks/exhaustive-deps
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
    async () => chartCandles(await getChart(ticker, period), ticker, period),
    (candles) => candles.length > 0,
  );
  return { ...state, candles: state.data ?? EMPTY_CANDLES, loading: state.status === "loading" };
}

export function usePrice(ticker: string) {
  return useResource(ticker, () => getPrice(ticker), (p) => validPrice(p, ticker), 10_000);
}

export function useIndices() {
  return useResource("indices", getIndices, validIndices, 30_000);
}

// ─────────────────────────────────────────────────
// useMultiPrice — 여러 종목 현재가 (watchlist용)
// ─────────────────────────────────────────────────

export function useMultiPrice(tickers: string[], intervalMs = 15_000) {
  const [prices, setPrices] = useState<Record<string, StockPrice>>({});

  useEffect(() => {
    if (!tickers.length) return;
    let active = true;

    const load = async () => {
      const up = await isBackendUp();
      if (!up || !active) return;
      try {
        const { getPrices } = await import("@/lib/api");
        const results = await getPrices(tickers);
        if (!active) return;
        const map: Record<string, StockPrice> = {};
        results.forEach((p) => { map[p.ticker] = p; });
        setPrices(map);
      } catch {}
    };

    load();
    const id = setInterval(load, intervalMs);
    return () => { active = false; clearInterval(id); };
  }, [tickers.join(","), intervalMs]); // eslint-disable-line

  return prices;
}
