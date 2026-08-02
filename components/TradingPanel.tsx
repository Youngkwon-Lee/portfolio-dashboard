"use client";
import { tradingBots, recentOrders } from "@/lib/mockData";
import { useState } from "react";
import { FlaskConical } from "lucide-react";

export default function TradingPanel() {
  const [activeTab, setActiveTab] = useState<"bots" | "orders">("bots");

  return (
    <div style={{ background: "var(--card)", border: "1px solid var(--card-border)", borderRadius: 8 }} className="p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold tracking-wide flex items-center gap-1.5" style={{ color: "var(--muted)" }}><FlaskConical size={13} aria-hidden="true" /> Paper 자동매매</span>
        <div className="flex gap-1">
          {(["bots", "orders"] as const).map((tab) => (
            <button key={tab} onClick={() => setActiveTab(tab)}
              className="text-xs px-2 py-0.5 rounded"
              style={{ background: activeTab === tab ? "var(--accent-blue)" : "transparent", color: activeTab === tab ? "#fff" : "var(--muted)", border: "1px solid var(--card-border)" }}>
              {tab === "bots" ? "봇 현황" : "가상 체결 내역"}
            </button>
          ))}
        </div>
      </div>

      {activeTab === "bots" && (
        <div className="flex flex-col gap-2">
          {tradingBots.map((bot) => (
            <div key={bot.id} style={{ background: "#0d1117", borderRadius: 6, padding: "10px 12px" }}>
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full" style={{ background: bot.status === "running" ? "var(--accent-green)" : "var(--accent-yellow)" }}></span>
                  <span className="text-xs font-semibold">{bot.name}</span>
                  <span className="text-xs" style={{ color: "var(--muted)" }}>{bot.ticker}</span>
                </div>
                <span className="text-xs" style={{ color: bot.pnl >= 0 ? "var(--accent-green)" : "var(--accent-red)" }}>
                  {bot.pnl >= 0 ? "+" : ""}₩{bot.pnl.toLocaleString("ko-KR")}
                </span>
              </div>
              <div className="flex gap-4 text-xs" style={{ color: "var(--muted)" }}>
                <span>전략: {bot.strategy}</span>
              </div>
              <div className="flex gap-4 text-xs mt-1" style={{ color: "var(--muted)" }}>
                <span>거래: {bot.trades}회</span>
                <span>승률: <span style={{ color: bot.winRate >= 60 ? "var(--accent-green)" : "var(--accent-red)" }}>{bot.winRate}%</span></span>
                <span>최근: {bot.lastTrade}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {activeTab === "orders" && (
        <div className="overflow-auto">
          <table className="w-full text-xs">
            <thead>
              <tr style={{ color: "var(--muted)" }}>
                <th className="text-left pb-2">시간</th>
                <th className="text-left pb-2">종목</th>
                <th className="text-left pb-2">구분</th>
                <th className="text-right pb-2">수량</th>
                <th className="text-right pb-2">가격</th>
                <th className="text-right pb-2">상태</th>
              </tr>
            </thead>
            <tbody>
              {recentOrders.map((o, i) => (
                <tr key={i} style={{ borderTop: "1px solid var(--card-border)" }}>
                  <td className="py-1.5 font-mono" style={{ color: "var(--muted)" }}>{o.time}</td>
                  <td className="py-1.5 font-semibold">{o.ticker}</td>
                  <td className="py-1.5">
                    <span className="px-1.5 py-0.5 rounded text-xs"
                      style={{ background: o.side === "buy" ? "var(--accent-red)22" : "var(--accent-blue)22", color: o.side === "buy" ? "var(--accent-red)" : "var(--accent-blue)" }}>
                      {o.side === "buy" ? "매수" : "매도"}
                    </span>
                  </td>
                  <td className="py-1.5 text-right">{o.qty}</td>
                  <td className="py-1.5 text-right">{o.price.toLocaleString("ko-KR")}</td>
                  <td className="py-1.5 text-right" style={{ color: o.status === "체결" ? "var(--accent-blue)" : "var(--accent-yellow)" }}>{o.status === "체결" ? "가상 체결" : o.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
