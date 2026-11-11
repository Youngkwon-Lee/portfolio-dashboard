import type { MarketMetadata, ChartResponse } from "@/lib/api";
export default function MarketSource({ data }: { data?: (MarketMetadata & Partial<ChartResponse>) | null }) {
  if (!data?.source) return null;
  return <span className="block text-xs" style={{ color: "var(--muted)" }}>
    {data.source} · {data.providerSymbol} · {data.currency} · 기준 {data.as_of ?? "미제공"} · 거래소 시간대 {data.exchange_timezone ?? "미제공"} · 수신 {data.fetched_at ?? "미제공"} · 지연 가능
    {data.covered_from && <> · 일봉 {data.covered_from} ~ {data.covered_to} · {data.coverage_note}</>}
  </span>;
}
