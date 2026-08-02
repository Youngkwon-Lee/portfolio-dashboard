"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type LineData,
  type HistogramData,
  type Time,
} from "lightweight-charts";
import { useChart, usePrice } from "@/hooks/usePortfolio";
import { detectMarket } from "@/lib/api";
import type { Candle } from "@/lib/api";

const PERIODS = ["1M", "3M", "6M", "1Y"] as const;
type Period = typeof PERIODS[number];

// ── MA 계산 헬퍼 ───────────────────────────────

function calcMA(candles: Candle[], n: number): LineData<Time>[] {
  return candles
    .map((_, i) => {
      if (i < n - 1) return null;
      const avg =
        candles.slice(i - n + 1, i + 1).reduce((s, c) => s + c.close, 0) / n;
      return { time: candles[i].date as Time, value: Math.round(avg * 100) / 100 };
    })
    .filter(Boolean) as LineData<Time>[];
}

// ── 다크 테마 설정 ─────────────────────────────

const CHART_THEME = {
  layout: {
    background: { color: "transparent" },
    textColor: "#8b949e",
    fontSize: 11,
  },
  grid: {
    vertLines: { color: "#21262d" },
    horzLines: { color: "#21262d" },
  },
  crosshair: {
    vertLine: { color: "#58a6ff44", labelBackgroundColor: "#161b22" },
    horzLine: { color: "#58a6ff44", labelBackgroundColor: "#161b22" },
  },
  rightPriceScale: {
    borderColor: "#30363d",
    textColor: "#8b949e",
  },
  timeScale: {
    borderColor: "#30363d",
    textColor: "#8b949e",
    fixLeftEdge: true,
    fixRightEdge: true,
  },
};

// ── 메인 컴포넌트 ──────────────────────────────

export default function CandlestickChart() {
  const [ticker, setTicker]   = useState("005930");
  const [input, setInput]     = useState("005930");
  const [period, setPeriod]   = useState<Period>("3M");
  const [showMA5, setShowMA5]   = useState(true);
  const [showMA20, setShowMA20] = useState(true);

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef     = useRef<IChartApi | null>(null);
  const candleRef    = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volRef       = useRef<ISeriesApi<"Histogram"> | null>(null);
  const ma5Ref       = useRef<ISeriesApi<"Line"> | null>(null);
  const ma20Ref      = useRef<ISeriesApi<"Line"> | null>(null);

  const { candles, loading } = useChart(ticker, period);
  const livePrice            = usePrice(ticker);
  const market               = detectMarket(ticker);

  // ── 차트 초기화 ──────────────────────────────

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      ...CHART_THEME,
      width:  containerRef.current.clientWidth,
      height: 280,
      autoSize: false,
    });
    chartRef.current = chart;

    // 캔들스틱
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor:     "#3fb950",
      downColor:   "#f85149",
      borderUpColor:   "#3fb950",
      borderDownColor: "#f85149",
      wickUpColor:   "#3fb950",
      wickDownColor: "#f85149",
    });
    candleRef.current = candleSeries;

    // 거래량 (별도 price scale)
    const volSeries = chart.addSeries(HistogramSeries, {
      priceScaleId: "vol",
      color: "#30363d",
    });
    chart.priceScale("vol").applyOptions({
      scaleMargins: { top: 0.85, bottom: 0 },
    });
    volRef.current = volSeries;

    // MA5
    const ma5Series = chart.addSeries(LineSeries, {
      color:       "#e3b341",
      lineWidth:   1,
      lineStyle:   2, // dashed
      crosshairMarkerVisible: false,
      lastValueVisible: false,
      priceLineVisible: false,
    });
    ma5Ref.current = ma5Series;

    // MA20
    const ma20Series = chart.addSeries(LineSeries, {
      color:       "#bc8cff",
      lineWidth:   1,
      crosshairMarkerVisible: false,
      lastValueVisible: false,
      priceLineVisible: false,
    });
    ma20Ref.current = ma20Series;

    // Tooltip 커스텀
    const tooltip = document.createElement("div");
    tooltip.style.cssText = `
      position:absolute; left:12px; top:12px; z-index:10;
      background:#161b22; border:1px solid #30363d; border-radius:6px;
      padding:8px 12px; font-size:11px; color:#e6edf3;
      pointer-events:none; display:none; line-height:1.6;
    `;
    containerRef.current.style.position = "relative";
    containerRef.current.appendChild(tooltip);

    chart.subscribeCrosshairMove((param) => {
      if (!param.time || !param.point) {
        tooltip.style.display = "none";
        return;
      }
      const c = param.seriesData.get(candleSeries) as CandlestickData | undefined;
      if (!c) { tooltip.style.display = "none"; return; }

      const changePct = (((c.close - c.open) / c.open) * 100).toFixed(2);
      const isUp = c.close >= c.open;
      const color = isUp ? "#3fb950" : "#f85149";

      tooltip.innerHTML = `
        <div style="color:#8b949e;margin-bottom:2px">${String(param.time)}</div>
        <div>시가 <b>${c.open.toLocaleString()}</b></div>
        <div style="color:#f85149">고가 <b>${c.high.toLocaleString()}</b></div>
        <div style="color:#58a6ff">저가 <b>${c.low.toLocaleString()}</b></div>
        <div>종가 <b style="color:${color}">${c.close.toLocaleString()}</b>
          <span style="color:${color}">(${isUp ? "+" : ""}${changePct}%)</span></div>
      `;
      tooltip.style.display = "block";
    });

    // 리사이즈
    const ro = new ResizeObserver(() => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth });
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      tooltip.remove();
      chart.remove();
      chartRef.current = null;
    };
  }, []); // 마운트 시 1회만

  // ── 데이터 업데이트 ───────────────────────────

  useEffect(() => {
    if (!candleRef.current || !volRef.current || !ma5Ref.current || !ma20Ref.current) return;
    if (!candles.length) return;

    const candleData: CandlestickData<Time>[] = candles.map((c) => ({
      time:  c.date as Time,
      open:  c.open,
      high:  c.high,
      low:   c.low,
      close: c.close,
    }));

    const volData: HistogramData<Time>[] = candles.map((c) => ({
      time:  c.date as Time,
      value: c.volume,
      color: c.close >= c.open ? "#3fb95044" : "#f8514944",
    }));

    candleRef.current.setData(candleData);
    volRef.current.setData(volData);
    ma5Ref.current.setData(calcMA(candles, 5));
    ma20Ref.current.setData(calcMA(candles, 20));

    chartRef.current?.timeScale().fitContent();
  }, [candles]);

  // ── 실시간 가격 업데이트 ──────────────────────

  useEffect(() => {
    if (!livePrice || !candleRef.current) return;
    // 오늘 날짜의 캔들을 실시간으로 업데이트
    const today = new Date().toISOString().slice(0, 10) as Time;
    const last  = candles[candles.length - 1];
    if (!last) return;
    candleRef.current.update({
      time:  today,
      open:  last.open,
      high:  Math.max(last.high, livePrice.current_price),
      low:   Math.min(last.low,  livePrice.current_price),
      close: livePrice.current_price,
    });
  }, [livePrice]);

  // ── MA 토글 ───────────────────────────────────

  useEffect(() => {
    ma5Ref.current?.applyOptions({ visible: showMA5 });
  }, [showMA5]);

  useEffect(() => {
    ma20Ref.current?.applyOptions({ visible: showMA20 });
  }, [showMA20]);

  // ── 헤더 정보 ─────────────────────────────────

  const last = candles[candles.length - 1];
  const displayPrice    = livePrice?.current_price  ?? last?.close   ?? 0;
  const displayChange   = livePrice?.change         ?? (last && candles.length > 1 ? last.close - candles[candles.length - 2].close : 0);
  const displayPct      = livePrice?.change_pct     ?? 0;
  const isUp            = displayChange >= 0;
  const priceColor      = isUp ? "var(--accent-green)" : "var(--accent-red)";

  const isKRX = market === "KRX";

  return (
    <div style={{ background: "var(--card)", border: "1px solid var(--card-border)", borderRadius: 8 }} className="p-4">
      {/* ── 헤더 ── */}
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="flex items-center gap-3 flex-wrap">
          {/* 티커 입력 */}
          <form onSubmit={(e) => { e.preventDefault(); const t = input.trim().toUpperCase(); setTicker(t); }}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              className="text-xs px-2 py-1 rounded font-mono w-28"
              style={{ background: "#0d1117", border: "1px solid var(--card-border)", color: "var(--foreground)", outline: "none" }}
              placeholder="티커 (Enter)"
            />
          </form>

          {/* 현재가 */}
          <div className="flex items-center gap-2">
            <span className="font-bold text-sm">
              {isKRX ? "₩" : ""}{displayPrice.toLocaleString("ko-KR", { maximumFractionDigits: 2 })}
            </span>
            <span className="text-xs" style={{ color: priceColor }}>
              {isUp ? "▲" : "▼"} {Math.abs(displayChange).toLocaleString("ko-KR", { maximumFractionDigits: 2 })} ({displayPct.toFixed(2)}%)
            </span>
            {livePrice && (
              <span className="text-xs px-1.5 py-0.5 rounded font-semibold"
                style={{ background: "var(--accent-green)22", color: "var(--accent-green)", border: "1px solid var(--accent-green)44" }}>
                실시간 시세
              </span>
            )}
          </div>

          {/* 마켓 배지 */}
          <span className="text-xs px-1.5 py-0.5 rounded"
            style={{ background: "#30363d", color: "var(--muted)" }}>{market}</span>
        </div>

        {/* 컨트롤 */}
        <div className="flex items-center gap-2">
          {/* MA 토글 */}
          <button onClick={() => setShowMA5((v) => !v)}
            className="text-xs px-2 py-1 rounded"
            style={{ background: showMA5 ? "#e3b34122" : "transparent", color: showMA5 ? "#e3b341" : "var(--muted)", border: "1px solid #30363d" }}>
            MA5
          </button>
          <button onClick={() => setShowMA20((v) => !v)}
            className="text-xs px-2 py-1 rounded"
            style={{ background: showMA20 ? "#bc8cff22" : "transparent", color: showMA20 ? "#bc8cff" : "var(--muted)", border: "1px solid #30363d" }}>
            MA20
          </button>

          <span style={{ color: "#30363d" }}>|</span>

          {/* 기간 */}
          {PERIODS.map((p) => (
            <button key={p} onClick={() => setPeriod(p)}
              className="text-xs px-2 py-1 rounded"
              style={{ background: period === p ? "var(--accent-blue)" : "transparent", color: period === p ? "#fff" : "var(--muted)", border: "1px solid var(--card-border)" }}>
              {p}
            </button>
          ))}
        </div>
      </div>

      {/* ── 차트 컨테이너 ── */}
      <div className="relative">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center z-10"
            style={{ background: "var(--card)cc" }}>
            <span className="text-xs" style={{ color: "var(--muted)" }}>차트 로딩 중...</span>
          </div>
        )}
        <div ref={containerRef} style={{ height: 280 }} />
      </div>

      {/* ── 범례 ── */}
      <div className="flex items-center gap-4 mt-2 text-xs" style={{ color: "var(--muted)" }}>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-2.5 rounded-sm" style={{ background: "#3fb950" }}></span>상승
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-2.5 rounded-sm" style={{ background: "#f85149" }}></span>하락
        </span>
        {showMA5 && (
          <span className="flex items-center gap-1">
            <span className="inline-block w-4 border-t-2 border-dashed" style={{ borderColor: "#e3b341" }}></span>MA5
          </span>
        )}
        {showMA20 && (
          <span className="flex items-center gap-1">
            <span className="inline-block w-4 border-t-2" style={{ borderColor: "#bc8cff" }}></span>MA20
          </span>
        )}
        <span className="ml-auto" style={{ color: "#30363d" }}>드래그·스크롤로 확대/이동</span>
      </div>
    </div>
  );
}
