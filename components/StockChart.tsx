"use client";
import { useState } from "react";
import { useChart, usePrice } from "@/hooks/usePortfolio";
import { ComposedChart, Line, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";

const PERIODS = ["1M", "3M", "6M", "1Y"] as const;
type Period = typeof PERIODS[number];

export default function StockChart() {
  const [ticker, setTicker] = useState("005930");
  const [input, setInput] = useState("005930");
  const [period, setPeriod] = useState<Period>("1M");

  const { candles, loading } = useChart(ticker, period);
  const livePrice = usePrice(ticker);

  const data = candles.map((c, i, arr) => {
    const ma5 = i >= 4
      ? Math.round(arr.slice(i - 4, i + 1).reduce((s, x) => s + x.close, 0) / 5)
      : null;
    return { ...c, label: c.date.slice(5).replace("-", "/"), ma5 };
  });

  const latest = data[data.length - 1];
  const displayPrice = livePrice?.current_price ?? latest?.close ?? 0;
  const displayChange = livePrice?.change ?? (latest ? latest.close - data[data.length - 2]?.close : 0);
  const displayChangePct = livePrice?.change_pct ?? 0;
  const isUp = displayChange >= 0;

  const CustomTooltip = ({ active, payload }: any) => {
    if (!active || !payload?.length) return null;
    const d = payload[0]?.payload;
    return (
      <div style={{ background: "var(--card)", border: "1px solid var(--card-border)", borderRadius: 6, padding: "8px 12px", fontSize: 11 }}>
        <div style={{ color: "var(--muted)" }}>{d.date}</div>
        <div>시가 <span className="font-semibold">{d.open?.toLocaleString()}</span></div>
        <div style={{ color: "var(--accent-red)" }}>고가 {d.high?.toLocaleString()}</div>
        <div style={{ color: "var(--accent-blue)" }}>저가 {d.low?.toLocaleString()}</div>
        <div>종가 <span className="font-semibold">{d.close?.toLocaleString()}</span></div>
        <div style={{ color: "var(--muted)" }}>거래량 {((d.volume ?? 0) / 1_000_000).toFixed(1)}M</div>
      </div>
    );
  };

  return (
    <div style={{ background: "var(--card)", border: "1px solid var(--card-border)", borderRadius: 8 }} className="p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="flex items-center gap-3">
          {/* 종목 입력 */}
          <form onSubmit={(e) => { e.preventDefault(); setTicker(input.trim().toUpperCase()); }}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              className="text-xs px-2 py-1 rounded font-mono w-24"
              style={{ background: "#0d1117", border: "1px solid var(--card-border)", color: "var(--foreground)" }}
              placeholder="티커 입력"
            />
          </form>
          <div>
            <span className="font-bold text-sm">{displayPrice.toLocaleString("ko-KR")}</span>
            <span className="text-xs ml-2" style={{ color: isUp ? "var(--accent-green)" : "var(--accent-red)" }}>
              {isUp ? "▲" : "▼"} {Math.abs(displayChange).toLocaleString()} ({displayChangePct.toFixed(2)}%)
            </span>
            {livePrice && (
              <span className="text-xs ml-2 px-1 rounded" style={{ background: "var(--accent-green)22", color: "var(--accent-green)" }}>
                실시간 시세
              </span>
            )}
          </div>
        </div>
        <div className="flex gap-1">
          {PERIODS.map((p) => (
            <button key={p} onClick={() => setPeriod(p)}
              className="text-xs px-2 py-1 rounded"
              style={{ background: period === p ? "var(--accent-blue)" : "transparent", color: period === p ? "#fff" : "var(--muted)", border: "1px solid var(--card-border)" }}>
              {p}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-[220px]" style={{ color: "var(--muted)" }}>
          <span className="text-xs">차트 로딩 중...</span>
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <ComposedChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
            <XAxis dataKey="label" tick={{ fontSize: 10, fill: "#8b949e" }} interval={Math.floor(data.length / 6)} />
            <YAxis yAxisId="price" domain={["auto", "auto"]} tick={{ fontSize: 10, fill: "#8b949e" }} width={58} tickFormatter={(v) => v.toLocaleString()} />
            <YAxis yAxisId="vol" orientation="right" tick={{ fontSize: 10, fill: "#8b949e" }} width={38} tickFormatter={(v) => `${(v / 1e6).toFixed(0)}M`} />
            <Tooltip content={<CustomTooltip />} />
            <Bar yAxisId="vol" dataKey="volume" fill="#30363d" opacity={0.5} />
            <Line yAxisId="price" type="monotone" dataKey="close" stroke="#58a6ff" dot={false} strokeWidth={2} />
            <Line yAxisId="price" type="monotone" dataKey="ma5" stroke="#e3b341" dot={false} strokeWidth={1.5} strokeDasharray="4 2" connectNulls />
          </ComposedChart>
        </ResponsiveContainer>
      )}
      <div className="flex gap-4 mt-2 text-xs" style={{ color: "var(--muted)" }}>
        <span><span className="inline-block w-3 h-0.5 bg-blue-400 mr-1 align-middle"></span>종가</span>
        <span><span className="inline-block w-3 h-0.5 bg-yellow-400 mr-1 align-middle"></span>MA5</span>
        <span style={{ color: "var(--card-border)" }}>|</span>
        <span>Enter로 종목 변경</span>
      </div>
    </div>
  );
}
