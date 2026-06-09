"use client";
import { useState } from "react";
import {
  ScatterChart, Scatter, XAxis, YAxis, Tooltip,
  ResponsiveContainer, ReferenceDot, Cell,
} from "recharts";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

interface PortfolioResult {
  weights: Record<string, number>;
  return:  number;
  vol:     number;
  sharpe:  number;
}
interface OptResult {
  tickers:            string[];
  max_sharpe:         PortfolioResult;
  min_vol:            PortfolioResult;
  risk_parity:        PortfolioResult;
  equal_weight:       PortfolioResult;
  efficient_frontier: { vol: number; ret: number; sharpe: number }[];
  correlation:        number[][];
  annual_returns:     Record<string, number>;
  volatilities:       Record<string, number>;
}

const PRESET_GROUPS = [
  { label: "크립토 3대장",  tickers: ["BTC", "ETH", "SOL"] },
  { label: "크립토 5종",    tickers: ["BTC", "ETH", "SOL", "BNB", "XRP"] },
  { label: "미국 빅테크",   tickers: ["AAPL", "NVDA", "MSFT", "GOOGL"] },
  { label: "크립토+주식",   tickers: ["BTC", "ETH", "AAPL", "NVDA"] },
];

const PORT_LABELS: Record<string, { label: string; color: string; desc: string }> = {
  max_sharpe:   { label: "최대 샤프",   color: "#58a6ff", desc: "위험 대비 수익 최대 (Markowitz 접선 포트폴리오)" },
  min_vol:      { label: "최소 변동성", color: "#3fb950", desc: "변동성 최소화 — 안정성 최우선" },
  risk_parity:  { label: "리스크 패리티", color: "#e3b341", desc: "각 자산이 동일 리스크 기여 (Bridgewater 방식)" },
  equal_weight: { label: "동일 가중",   color: "#bc8cff", desc: "1/N 배분 — 단순하지만 강력 (DeMiguel 2009)" },
};

function heatColor(v: number) {
  if (v > 0.8) return "#7a1010";
  if (v > 0.6) return "#c0392b";
  if (v > 0.3) return "#e67e22";
  if (v > 0)   return "#27ae60";
  return "#2980b9";
}

function WeightBar({ weights, colors }: { weights: Record<string, number>; colors: string[] }) {
  const entries = Object.entries(weights);
  return (
    <div className="flex h-3 rounded overflow-hidden w-full gap-px">
      {entries.map(([t, w], i) => (
        <div key={t} style={{ width: `${w * 100}%`, background: colors[i % colors.length] }}
          title={`${t}: ${(w * 100).toFixed(1)}%`} />
      ))}
    </div>
  );
}

export default function OptimizerPage() {
  const [tickerInput, setTickerInput] = useState("BTC,ETH,SOL");
  const [period,      setPeriod]      = useState<"6M"|"1Y">("1Y");
  const [result,      setResult]      = useState<OptResult | null>(null);
  const [selected,    setSelected]    = useState<string>("max_sharpe");
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState("");

  async function run(tickers?: string[]) {
    const t = tickers ?? tickerInput.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    if (t.length < 2) { setError("최소 2개 종목 필요"); return; }
    if (t.length > 8) { setError("최대 8개 종목"); return; }
    setLoading(true); setError(""); setResult(null);
    try {
      const r = await fetch(`${API}/api/optimize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tickers: t, period }),
      });
      if (!r.ok) { const e = await r.json(); throw new Error(e.detail); }
      const data = await r.json();
      setResult(data);
      setTickerInput(t.join(", "));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "오류 발생");
    } finally {
      setLoading(false);
    }
  }

  const colors = ["#58a6ff","#3fb950","#e3b341","#bc8cff","#f85149","#79c0ff","#56d364","#ffa657"];
  const selResult = result?.[selected as keyof OptResult] as PortfolioResult | undefined;

  return (
    <div className="flex flex-col h-full p-4 gap-4 overflow-y-auto">
      <div className="flex items-center justify-between">
        <span className="text-sm font-bold">⚖️ 포트폴리오 최적화</span>
        <span className="text-xs px-2 py-0.5 rounded" style={{ background: "#58a6ff22", color: "var(--accent-blue)", border: "1px solid #58a6ff44" }}>
          Markowitz MPT · Sharpe 1994 · Black-Litterman
        </span>
      </div>

      {/* 입력 */}
      <div className="p-4 rounded-lg flex flex-col gap-3" style={{ background: "var(--card)", border: "1px solid var(--card-border)" }}>
        <div className="flex gap-2">
          <input value={tickerInput} onChange={(e) => setTickerInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && run()}
            placeholder="BTC, ETH, AAPL, 005930 … (쉼표 구분, 최대 8개)"
            className="flex-1 px-3 py-2 rounded text-sm outline-none"
            style={{ background: "#0d1117", border: "1px solid var(--card-border)", color: "var(--foreground)" }} />
          <div className="flex gap-1">
            {(["6M","1Y"] as const).map((p) => (
              <button key={p} onClick={() => setPeriod(p)}
                className="px-3 py-2 rounded text-xs"
                style={{ background: period === p ? "var(--accent-blue)" : "#0d1117", color: period === p ? "#fff" : "var(--muted)", border: "1px solid var(--card-border)" }}>
                {p}
              </button>
            ))}
          </div>
          <button onClick={() => run()} disabled={loading}
            className="px-4 py-2 rounded text-sm font-bold"
            style={{ background: loading ? "#30363d" : "var(--accent-blue)", color: "#fff" }}>
            {loading ? "계산 중…" : "최적화"}
          </button>
        </div>

        {/* 프리셋 */}
        <div className="flex gap-2 flex-wrap">
          {PRESET_GROUPS.map((g) => (
            <button key={g.label} onClick={() => run(g.tickers)}
              className="px-3 py-1 rounded text-xs"
              style={{ background: "#0d1117", border: "1px solid var(--card-border)", color: "var(--muted)" }}>
              {g.label}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="text-xs px-3 py-2 rounded" style={{ background: "#f8514922", color: "var(--accent-red)", border: "1px solid #f8514944" }}>{error}</div>}

      {result && (
        <>
          {/* 포트폴리오 비교 카드 */}
          <div className="grid grid-cols-4 gap-2">
            {Object.entries(PORT_LABELS).map(([key, meta]) => {
              const r = result[key as keyof OptResult] as PortfolioResult;
              const isSelected = selected === key;
              return (
                <button key={key} onClick={() => setSelected(key)}
                  className="p-3 rounded-lg text-left flex flex-col gap-2"
                  style={{ background: isSelected ? "var(--card)" : "#0d1117", border: `1px solid ${isSelected ? meta.color : "var(--card-border)"}` }}>
                  <div className="text-xs font-bold" style={{ color: meta.color }}>{meta.label}</div>
                  <WeightBar weights={r.weights} colors={colors} />
                  <div className="grid grid-cols-3 gap-1 text-xs">
                    <div><span style={{ color: "var(--muted)" }}>수익</span><br/><b style={{ color: r.return >= 0 ? "var(--accent-green)" : "var(--accent-red)" }}>{r.return >= 0 ? "+" : ""}{r.return}%</b></div>
                    <div><span style={{ color: "var(--muted)" }}>변동성</span><br/><b>{r.vol}%</b></div>
                    <div><span style={{ color: "var(--muted)" }}>샤프</span><br/><b style={{ color: r.sharpe >= 0 ? "var(--accent-green)" : "var(--accent-red)" }}>{r.sharpe}</b></div>
                  </div>
                  <div className="text-xs" style={{ color: "var(--muted)" }}>{meta.desc}</div>
                </button>
              );
            })}
          </div>

          {/* 선택된 포트폴리오 비중 */}
          {selResult && (
            <div className="p-4 rounded-lg flex flex-col gap-3" style={{ background: "var(--card)", border: "1px solid var(--card-border)" }}>
              <div className="text-xs font-bold">{PORT_LABELS[selected].label} — 종목별 비중</div>
              <div className="flex flex-col gap-2">
                {Object.entries(selResult.weights).map(([ticker, w], i) => (
                  <div key={ticker} className="flex items-center gap-3">
                    <div className="w-12 text-xs font-bold" style={{ color: colors[i % colors.length] }}>{ticker}</div>
                    <div className="flex-1 h-2 rounded-full" style={{ background: "var(--card-border)" }}>
                      <div className="h-full rounded-full" style={{ width: `${w * 100}%`, background: colors[i % colors.length] }} />
                    </div>
                    <div className="w-14 text-right text-xs font-bold">{(w * 100).toFixed(1)}%</div>
                    <div className="w-20 text-right text-xs" style={{ color: "var(--muted)" }}>
                      연수익 <span style={{ color: (result.annual_returns[ticker] ?? 0) >= 0 ? "var(--accent-green)" : "var(--accent-red)" }}>
                        {(result.annual_returns[ticker] ?? 0) >= 0 ? "+" : ""}{result.annual_returns[ticker] ?? 0}%
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 효율적 프론티어 + 상관계수 */}
          <div className="grid grid-cols-2 gap-3">
            {/* 효율적 프론티어 */}
            <div className="p-4 rounded-lg" style={{ background: "var(--card)", border: "1px solid var(--card-border)" }}>
              <div className="text-xs font-bold mb-3">효율적 프론티어</div>
              <ResponsiveContainer width="100%" height={200}>
                <ScatterChart margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <XAxis dataKey="vol" name="변동성" unit="%" tick={{ fontSize: 10, fill: "#8b949e" }} domain={["auto","auto"]} />
                  <YAxis dataKey="ret" name="수익률" unit="%" tick={{ fontSize: 10, fill: "#8b949e" }} domain={["auto","auto"]} />
                  <Tooltip cursor={{ strokeDasharray: "3 3" }}
                    contentStyle={{ background: "#161b22", border: "1px solid #30363d", fontSize: 11 }}
                    formatter={(v: unknown, n: unknown) => [`${(v as number).toFixed(2)}%`, n as string]} />
                  <Scatter data={result.efficient_frontier} fill="#30363d">
                    {result.efficient_frontier.map((_, i) => (
                      <Cell key={i} fill={`hsl(${200 + i * 3}, 60%, 50%)`} opacity={0.6} />
                    ))}
                  </Scatter>
                  {/* 4개 포트폴리오 강조 */}
                  {Object.entries(PORT_LABELS).map(([key, meta]) => {
                    const r = result[key as keyof OptResult] as PortfolioResult;
                    return <ReferenceDot key={key} x={r.vol} y={r.return} r={6} fill={meta.color} stroke="#0d1117" strokeWidth={2} />;
                  })}
                </ScatterChart>
              </ResponsiveContainer>
              <div className="flex gap-3 mt-2 flex-wrap">
                {Object.entries(PORT_LABELS).map(([key, meta]) => (
                  <div key={key} className="flex items-center gap-1 text-xs">
                    <div className="w-2 h-2 rounded-full" style={{ background: meta.color }} />
                    <span style={{ color: "var(--muted)" }}>{meta.label}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* 상관계수 행렬 */}
            <div className="p-4 rounded-lg" style={{ background: "var(--card)", border: "1px solid var(--card-border)" }}>
              <div className="text-xs font-bold mb-3">상관계수 행렬</div>
              <table className="w-full text-xs text-center">
                <thead>
                  <tr>
                    <th className="py-1" />
                    {result.tickers.map((t) => (
                      <th key={t} className="py-1 px-2" style={{ color: "var(--muted)" }}>{t}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.tickers.map((t, i) => (
                    <tr key={t}>
                      <td className="py-1 pr-2 font-bold text-right" style={{ color: "var(--muted)" }}>{t}</td>
                      {result.correlation[i].map((v, j) => (
                        <td key={j} className="py-1 px-2 rounded"
                          style={{ background: heatColor(v), color: "#fff" }}>
                          {v.toFixed(2)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-3 text-xs" style={{ color: "var(--muted)" }}>
                상관계수가 낮을수록 분산 효과가 큽니다. 0.8 이상이면 사실상 같은 방향으로 움직입니다.
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
