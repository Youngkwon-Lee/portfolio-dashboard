"use client";
import DataProvenance from "./DataProvenance";
import { useIndices } from "@/hooks/usePortfolio";

export default function TopBar() {
  const { data: indices, status } = useIndices();

  return (
    <div style={{ background: "#0d1117", borderBottom: "1px solid var(--card-border)" }}
         className="flex items-center gap-6 px-4 py-2 text-xs overflow-x-auto shrink-0">
      {indices?.map((idx) => (
        <span key={idx.name} className="flex items-center gap-2 whitespace-nowrap">
          <span style={{ color: "var(--muted)" }}>{idx.name}</span>
          {idx.error ? <DataProvenance status="unavailable" /> : <>
          <span className="font-semibold">{idx.value.toLocaleString("ko-KR")}</span>
          <span style={{ color: idx.change_pct >= 0 ? "var(--accent-green)" : "var(--accent-red)" }}>
            {idx.change_pct >= 0 ? "▲" : "▼"} {Math.abs(idx.change_pct).toFixed(2)}%
          </span>
          </>}
        </span>
      ))}
      <span className="ml-auto whitespace-nowrap"><DataProvenance status={status} /></span>
    </div>
  );
}
