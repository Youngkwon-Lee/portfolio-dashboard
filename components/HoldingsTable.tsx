"use client";
import { useBalance } from "@/hooks/usePortfolio";

const marketColor: Record<string, string> = {
  KRX: "#58a6ff", NASDAQ: "#3fb950", ETF: "#e3b341", CRYPTO: "#bc8cff",
};

function guessMarket(ticker: string) {
  if (/^\d{6}$/.test(ticker)) return "KRX";
  if (ticker === "BTC" || ticker === "ETH") return "CRYPTO";
  if (["QQQ","SPY","SCHD","IWM","TLT","GLD"].includes(ticker)) return "ETF";
  return "NASDAQ";
}

export default function HoldingsTable() {
  const { data, loading } = useBalance();

  if (loading) return (
    <div style={{ background: "var(--card)", border: "1px solid var(--card-border)", borderRadius: 8 }}
         className="p-4 h-32 flex items-center justify-center">
      <span className="text-xs" style={{ color: "var(--muted)" }}>불러오는 중...</span>
    </div>
  );
  if (!data) return null;

  return (
    <div style={{ background: "var(--card)", border: "1px solid var(--card-border)", borderRadius: 8 }} className="p-4">
      <div className="text-xs font-semibold tracking-wide mb-3" style={{ color: "var(--muted)" }}>보유 종목</div>
      <div className="overflow-auto">
        <table className="w-full text-xs">
          <thead>
            <tr style={{ color: "var(--muted)", borderColor: "var(--card-border)" }} className="border-b">
              <th className="text-left pb-2">종목</th>
              <th className="text-right pb-2">수량</th>
              <th className="text-right pb-2">평가금액</th>
              <th className="text-right pb-2">수익률</th>
            </tr>
          </thead>
          <tbody>
            {data.holdings.map((h) => {
              const mkt = guessMarket(h.ticker);
              const color = marketColor[mkt] ?? "#8b949e";
              return (
                <tr key={h.ticker} style={{ borderColor: "var(--card-border)" }} className="border-b">
                  <td className="py-2">
                    <div className="font-semibold">{h.ticker}</div>
                    <div style={{ color: "var(--muted)" }} className="truncate max-w-[80px]">{h.name}</div>
                    <span className="px-1 rounded" style={{ background: color + "22", color }}>{mkt}</span>
                  </td>
                  <td className="text-right py-2">{h.qty.toLocaleString()}</td>
                  <td className="text-right py-2">₩{h.value.toLocaleString("ko-KR")}</td>
                  <td className="text-right py-2" style={{ color: h.return_pct >= 0 ? "var(--accent-green)" : "var(--accent-red)" }}>
                    {h.return_pct >= 0 ? "+" : ""}{h.return_pct.toFixed(2)}%
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
