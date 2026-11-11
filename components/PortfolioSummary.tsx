"use client";
import DataProvenance from "./DataProvenance";
import { useBalance } from "@/hooks/usePortfolio";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from "recharts";

const COLORS = ["#58a6ff", "#3fb950", "#e3b341", "#bc8cff"];

function fmt(n: number) { return n.toLocaleString("ko-KR"); }

export default function PortfolioSummary() {
  const { data, loading, status } = useBalance();

  if (loading) return (
    <div style={{ background: "var(--card)", border: "1px solid var(--card-border)", borderRadius: 8 }}
         className="p-4 flex items-center justify-center h-48">
      <span className="text-xs" style={{ color: "var(--muted)" }}><DataProvenance status={status} /></span>
    </div>
  );
  if (!data) return <div className="p-4" style={{ background: "var(--card)", border: "1px solid var(--card-border)", borderRadius: 8 }}><DataProvenance status={status} /></div>;

  const pnlColor = data.pnl >= 0 ? "var(--accent-green)" : "var(--accent-red)";

  // 자산 배분용 파이 데이터 (보유 종목별)
  const pieData = data.holdings.slice(0, 4).map((h, i) => ({
    name: h.ticker,
    value: h.value,
    color: COLORS[i % COLORS.length],
  }));

  return (
    <div style={{ background: "var(--card)", border: "1px solid var(--card-border)", borderRadius: 8 }} className="p-4">
      <div className="mb-2"><DataProvenance status={status} /></div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-semibold tracking-wide" style={{ color: "var(--muted)" }}>총 자산</span>
        <span className="text-xs" style={{ color: pnlColor }}>
          {data.pnl_pct >= 0 ? "+" : ""}{data.pnl_pct.toFixed(2)}% 총 수익률
        </span>
      </div>
      <div className="text-2xl font-bold mb-1">₩{fmt(data.total_value)}</div>
      <div className="flex gap-3 text-xs mb-4 flex-wrap">
        <span>
          <span style={{ color: "var(--muted)" }}>수익 </span>
          <span style={{ color: pnlColor }}>{data.pnl >= 0 ? "+" : ""}₩{fmt(data.pnl)}</span>
        </span>
        <span>
          <span style={{ color: "var(--muted)" }}>현금 </span>
          <span>₩{fmt(data.cash)}</span>
        </span>
      </div>

      <div className="flex items-center gap-3">
        <ResponsiveContainer width={90} height={90}>
          <PieChart>
            <Pie data={pieData} cx="50%" cy="50%" innerRadius={24} outerRadius={42} dataKey="value" paddingAngle={2}>
              {pieData.map((e, i) => <Cell key={i} fill={e.color} />)}
            </Pie>
            <Tooltip formatter={(v) => `₩${fmt(Number(v))}`}
              contentStyle={{ background: "var(--card)", border: "1px solid var(--card-border)", fontSize: 11 }} />
          </PieChart>
        </ResponsiveContainer>
        <div className="flex flex-col gap-1">
          {pieData.map((d) => (
            <div key={d.name} className="flex items-center gap-2 text-xs">
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: d.color }}></span>
              <span style={{ color: "var(--muted)" }}>{d.name}</span>
              <span className="font-semibold">{data.total_value > 0 ? `${((d.value / data.total_value) * 100).toFixed(0)}%` : "해당 없음"}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
