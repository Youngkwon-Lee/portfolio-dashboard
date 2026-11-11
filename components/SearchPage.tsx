"use client";
import { useState, useRef } from "react";
import { detectMarket } from "@/lib/api";
import { usePrice, useChart } from "@/hooks/usePortfolio";
import DataProvenance from "./DataProvenance";
import MarketSource from "./MarketSource";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";

const POPULAR = [
  { ticker: "AAPL",   label: "Apple" },
  { ticker: "NVDA",   label: "NVIDIA" },
  { ticker: "TSLA",   label: "Tesla" },
  { ticker: "BTC",    label: "Bitcoin" },
  { ticker: "ETH",    label: "Ethereum" },
  { ticker: "SOL",    label: "Solana" },
  { ticker: "005930", label: "삼성전자" },
  { ticker: "000660", label: "SK하이닉스" },
];

const PERIOD_OPTIONS = ["1M", "3M", "6M", "1Y"] as const;
type Period = typeof PERIOD_OPTIONS[number];

export default function SearchPage() {
  const [query, setQuery] = useState("005930");
  const [ticker, setTicker] = useState("005930");
  const [period, setPeriod] = useState<Period>("1M");
  // These shared hooks scope both render and async completions to ticker/period.
  // A failed refresh clears its value instead of retaining a prior symbol/bar.
  const priceState = usePrice(ticker);
  const chartState = useChart(ticker, period);
  const result = priceState.data;
  const candles = chartState.candles;
  const loading = priceState.status === "loading";
  const chartLoading = chartState.loading;
  const error = priceState.status === "unavailable"
    ? "공개 시세를 불러오지 못했습니다. 종목 코드나 제공자 제한을 확인해 주세요. 이전 가격은 표시하지 않습니다."
    : "";
  const inputRef = useRef<HTMLInputElement>(null);

  function search(value: string) {
    const next = value.trim().toUpperCase();
    if (next) setTicker(next);
  }

  function handlePeriod(p: Period) {
    setPeriod(p);
  }

  const firstClose = candles[0]?.close ?? 0;
  const chartData  = candles.map((c) => ({
    date:   c.date.slice(5),
    close:  c.close,
    pct:    firstClose ? +((c.close - firstClose) / firstClose * 100).toFixed(2) : 0,
  }));
  const isUp = (result?.change_pct ?? 0) >= 0;

  return (
    <div className="flex flex-col h-full p-4 gap-4 overflow-y-auto">
      {/* 검색 바 */}
      <div className="flex gap-2">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && search(query)}
          placeholder="티커 입력 (AAPL, BTC, 005930.KS …)"
          className="flex-1 px-3 py-2 rounded text-sm outline-none"
          style={{ background: "var(--card)", border: "1px solid var(--card-border)", color: "var(--foreground)" }}
        />
        <button
          onClick={() => search(query)}
          disabled={loading}
          className="px-4 py-2 rounded text-sm font-semibold"
          style={{ background: "var(--accent-blue)", color: "#fff", opacity: loading ? 0.6 : 1 }}
        >
          {loading ? "…" : "검색"}
        </button>
      </div>

      {/* 인기 종목 */}
      <div className="flex flex-wrap gap-2">
        {POPULAR.map((p) => (
          <button
            key={p.ticker}
            onClick={() => { setQuery(p.ticker); search(p.ticker); }}
            className="px-3 py-1 rounded text-xs"
            style={{ background: "var(--card)", border: "1px solid var(--card-border)", color: "var(--muted)" }}
          >
            {p.label} <span style={{ color: "var(--accent-blue)" }}>{p.ticker}</span>
          </button>
        ))}
      </div>

      {/* 에러 */}
      {error && (
        <div className="text-sm px-3 py-2 rounded" style={{ background: "#f8514922", color: "var(--accent-red)", border: "1px solid var(--accent-red)44" }}>
          {error}
        </div>
      )}

      {/* 결과: 가격과 차트는 독립적으로 실패 상태를 표시합니다. */}
        <div className="flex flex-col gap-4">
          <DataProvenance status={priceState.status} />
          {/* 가격 헤더 */}
          {result && <div className="p-4 rounded-lg" style={{ background: "var(--card)", border: "1px solid var(--card-border)" }}>
            <div className="flex items-start justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-lg font-bold">{result.name}</span>
                  <span className="text-xs px-2 py-0.5 rounded" style={{ background: "var(--accent-blue)22", color: "var(--accent-blue)" }}>
                    {detectMarket(result.ticker)}
                  </span>
                </div>
                <div className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>{result.ticker}</div>
              </div>
              <div className="text-right">
                <div className="text-2xl font-bold">
                  {result.current_price.toLocaleString()}
                  <span className="text-sm ml-1" style={{ color: "var(--muted)" }}>{result.currency ?? "USD"}</span>
                </div>
                <div className="text-sm font-semibold mt-0.5" style={{ color: isUp ? "var(--accent-green)" : "var(--accent-red)" }}>
                  {isUp ? "▲" : "▼"} {Math.abs(result.change_pct).toFixed(2)}%
                  <span className="ml-1 text-xs" style={{ color: "var(--muted)" }}>
                    ({isUp ? "+" : ""}{result.change.toLocaleString()})
                  </span>
                </div>
              </div>
            </div>

            <MarketSource data={result} />
            {/* 세부 지표 */}
            <div className="grid grid-cols-3 gap-3 mt-4">
              {[
                { label: "고가",   value: result.high?.toLocaleString() ?? "-" },
                { label: "저가",   value: result.low?.toLocaleString()  ?? "-" },
                { label: "거래량", value: result.volume ? (result.volume / 1e6).toFixed(1) + "M" : "-" },
              ].map(({ label, value }) => (
                <div key={label} className="text-center p-2 rounded" style={{ background: "#0d1117" }}>
                  <div className="text-xs" style={{ color: "var(--muted)" }}>{label}</div>
                  <div className="text-sm font-semibold mt-0.5">{value}</div>
                </div>
              ))}
            </div>
          </div>}

          {/* 차트 */}
          <div className="p-4 rounded-lg" style={{ background: "var(--card)", border: "1px solid var(--card-border)" }}>
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-semibold">가격 변동률 · 첫 일봉 종가 기준</span>
              <div className="flex gap-1">
                {PERIOD_OPTIONS.map((p) => (
                  <button
                    key={p}
                    onClick={() => handlePeriod(p)}
                    className="px-2 py-0.5 rounded text-xs"
                    style={{
                      background: period === p ? "var(--accent-blue)" : "var(--card)",
                      color: period === p ? "#fff" : "var(--muted)",
                      border: "1px solid var(--card-border)",
                    }}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>

            <DataProvenance status={chartState.status} />
            <MarketSource data={chartState.metadata} />
            {chartLoading ? (
              <div className="h-48 flex items-center justify-center text-sm" style={{ color: "var(--muted)" }}>로딩 중…</div>
            ) : candles.length === 0 ? (
              <div className="h-48 flex items-center justify-center text-sm" style={{ color: "var(--muted)" }}>차트 데이터를 확인할 수 없습니다. 이전 차트는 표시하지 않습니다.</div>
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={chartData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#8b949e" }} interval="preserveStartEnd" />
                  <YAxis tick={{ fontSize: 10, fill: "#8b949e" }} domain={["auto", "auto"]} />
                  <Tooltip
                    contentStyle={{ background: "#161b22", border: "1px solid #30363d", fontSize: 12 }}
                    formatter={(v: unknown) => [`${(v as number).toFixed(2)}%`, "기간 가격 변동률"]}
                  />
                  <ReferenceLine y={0} stroke="#30363d" strokeDasharray="3 3" />
                  <Line
                    type="monotone" dataKey="pct" dot={false} strokeWidth={2}
                    stroke={(chartData.at(-1)?.pct ?? 0) >= 0 ? "#3fb950" : "#f85149"}
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
    </div>
  );
}
