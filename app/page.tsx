"use client";
import { useState } from "react";
import TopBar from "@/components/TopBar";
import PortfolioSummary from "@/components/PortfolioSummary";
import HoldingsTable from "@/components/HoldingsTable";
import CandlestickChart from "@/components/CandlestickChart";
import AIAnalysisPanel from "@/components/AIAnalysisPanel";
import TradingPanel from "@/components/TradingPanel";
import SearchPage from "@/components/SearchPage";
import BacktestPage from "@/components/BacktestPage";
import SettingsPage from "@/components/SettingsPage";
import BotPage from "@/components/BotPage";
import OptimizerPage from "@/components/OptimizerPage";

type Tab = "대시보드" | "종목 검색" | "백테스트" | "최적화" | "자동매매" | "설정";
const TABS: Tab[] = ["대시보드", "종목 검색", "백테스트", "최적화", "자동매매", "설정"];

export default function Dashboard() {
  const [tab, setTab] = useState<Tab>("대시보드");

  return (
    <div className="flex flex-col h-full" style={{ background: "var(--background)" }}>
      {/* Top bar: market indices */}
      <TopBar />

      {/* Header nav */}
      <div
        style={{ borderBottom: "1px solid var(--card-border)", background: "#0d1117" }}
        className="flex items-center justify-between px-4 py-2 shrink-0"
      >
        <div className="flex items-center gap-2">
          <span className="font-bold text-sm tracking-tight">📈 PortfolioAI</span>
          <span
            className="text-xs px-2 py-0.5 rounded"
            style={{ background: "var(--accent-blue)22", color: "var(--accent-blue)", border: "1px solid var(--accent-blue)44" }}
          >
            Beta
          </span>
        </div>

        <div className="nav-tabs flex gap-1 text-xs" style={{ color: "var(--muted)" }}>
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className="px-3 py-1 rounded transition-colors whitespace-nowrap"
              style={{
                background: tab === t ? "var(--card)" : "transparent",
                color: tab === t ? "var(--foreground)" : "var(--muted)",
                border: tab === t ? "1px solid var(--card-border)" : "1px solid transparent",
              }}
            >
              {t}
            </button>
          ))}
        </div>

        <button
          className="text-xs px-3 py-1 rounded font-semibold"
          style={{ background: "var(--accent-blue)", color: "#fff" }}
        >
          KIS 연결됨 ✓
        </button>
      </div>

      {/* 탭 콘텐츠 */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── 대시보드 ── */}
        {tab === "대시보드" && (
          <div className="dashboard-grid flex flex-1 overflow-hidden">
            {/* LEFT */}
            <div className="sidebar w-64 shrink-0 flex flex-col gap-3 p-3 overflow-y-auto"
              style={{ borderRight: "1px solid var(--card-border)" }}>
              <PortfolioSummary />
              <HoldingsTable />
            </div>

            {/* CENTER */}
            <div className="flex-1 flex flex-col gap-3 p-3 overflow-y-auto">
              <CandlestickChart />
              <TradingPanel />
            </div>

            {/* RIGHT */}
            <div className="right-panel w-72 shrink-0 p-3 overflow-y-auto"
              style={{ borderLeft: "1px solid var(--card-border)" }}>
              <AIAnalysisPanel />
            </div>
          </div>
        )}

        {/* ── 종목 검색 ── */}
        {tab === "종목 검색" && (
          <div className="flex-1 overflow-hidden">
            <SearchPage />
          </div>
        )}

        {/* ── 백테스트 ── */}
        {tab === "백테스트" && (
          <div className="flex-1 overflow-hidden">
            <BacktestPage />
          </div>
        )}

        {/* ── 최적화 ── */}
        {tab === "최적화" && (
          <div className="flex-1 overflow-hidden">
            <OptimizerPage />
          </div>
        )}

        {/* ── 자동매매 ── */}
        {tab === "자동매매" && (
          <div className="flex-1 overflow-hidden">
            <BotPage />
          </div>
        )}

        {/* ── 설정 ── */}
        {tab === "설정" && (
          <div className="flex-1 overflow-hidden">
            <SettingsPage />
          </div>
        )}
      </div>
    </div>
  );
}
