"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import { checkHealth, getBalance, getChart, getPrice, getIndices } from "@/lib/api";
import type { Balance, Candle, StockPrice, IndexPrice } from "@/lib/api";
import { portfolioSummary, holdings, samsungPriceData, marketIndices } from "@/lib/mockData";

// ── 백엔드 상태 (싱글톤, 30초 캐시) ──────────────

let _backendUp: boolean | null = null;
let _lastChecked = 0;

async function isBackendUp(): Promise<boolean> {
  const now = Date.now();
  if (_backendUp !== null && now - _lastChecked < 30_000) return _backendUp;
  _backendUp = await checkHealth();
  _lastChecked = now;
  return _backendUp;
}

// ── mock → Balance 변환 ───────────────────────────

function getMockBalance(): Balance {
  return {
    holdings: holdings.map((h) => ({
      ticker: h.ticker,
      name: h.name,
      qty: h.qty,
      avg_cost: h.avgCost,
      current_price: h.currentPrice,
      value: h.value,
      return_pct: h.returnPct,
    })),
    total_value: portfolioSummary.totalValue,
    total_cost: portfolioSummary.totalCost,
    cash: 5_000_000,
    pnl: portfolioSummary.totalReturn,
    pnl_pct: portfolioSummary.totalReturnPct,
  };
}

// ─────────────────────────────────────────────────
// useBalance — 계좌 잔고 (30초 자동 갱신)
// ─────────────────────────────────────────────────

export function useBalance(refreshInterval = 30_000) {
  const [data, setData] = useState<Balance | null>(null);
  const [loading, setLoading] = useState(true);
  const [useMock, setUseMock] = useState(false);

  const load = useCallback(async () => {
    const up = await isBackendUp();
    if (!up) {
      setUseMock(true);
      setData(getMockBalance());
      setLoading(false);
      return;
    }
    try {
      const result = await getBalance();
      setData(result);
      setUseMock(false);
    } catch {
      if (!data) setData(getMockBalance());
    } finally {
      setLoading(false);
    }
  }, []); // eslint-disable-line

  useEffect(() => {
    load();
    const id = setInterval(load, refreshInterval);
    return () => clearInterval(id);
  }, [load, refreshInterval]);

  return { data, loading, useMock };
}

// ─────────────────────────────────────────────────
// useChart — 일봉 차트 (마켓 자동 감지)
// ─────────────────────────────────────────────────

export function useChart(ticker: string, period: "1M" | "3M" | "6M" | "1Y") {
  const [candles, setCandles] = useState<Candle[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);

    isBackendUp().then(async (up) => {
      if (!active) return;

      if (!up) {
        // mock 폴백 (삼성전자 데이터 재사용)
        const sliceMap = { "1M": 20, "3M": 40, "6M": 55, "1Y": 60 };
        setCandles(
          samsungPriceData.slice(-sliceMap[period]).map((d) => ({
            date: d.date, open: d.open, high: d.high,
            low: d.low, close: d.close, volume: d.volume,
          }))
        );
        setLoading(false);
        return;
      }

      try {
        const res = await getChart(ticker, period);
        if (active) setCandles(res.candles);
      } catch {
        // 에러 시 기존 데이터 유지
      } finally {
        if (active) setLoading(false);
      }
    });

    return () => { active = false; };
  }, [ticker, period]);

  return { candles, loading };
}

// ─────────────────────────────────────────────────
// usePrice — 단일 종목 현재가 (10초 갱신)
// ─────────────────────────────────────────────────

export function usePrice(ticker: string) {
  const [price, setPrice] = useState<StockPrice | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let active = true;

    const load = async () => {
      const up = await isBackendUp();
      if (!up || !active) return;
      try {
        const p = await getPrice(ticker);
        if (active) setPrice(p);
      } catch {}
      if (active) timerRef.current = setTimeout(load, 10_000);
    };

    load();
    return () => {
      active = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [ticker]);

  return price;
}

// ─────────────────────────────────────────────────
// useIndices — 전체 지수 (30초 갱신)
// ─────────────────────────────────────────────────

const MOCK_INDICES: IndexPrice[] = marketIndices.map((m) => ({
  name: m.name,
  value: m.value,
  change_pct: m.change,
}));

export function useIndices() {
  const [indices, setIndices] = useState<IndexPrice[]>(MOCK_INDICES);

  useEffect(() => {
    let active = true;

    const load = async () => {
      const up = await isBackendUp();
      if (!up || !active) return;
      try {
        const data = await getIndices();
        if (active) setIndices(data.filter((d) => !d.error));
      } catch {}
    };

    load();
    const id = setInterval(load, 30_000);
    return () => { active = false; clearInterval(id); };
  }, []);

  return indices;
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
