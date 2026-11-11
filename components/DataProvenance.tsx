import { DATA_LABELS, type DataStatus } from "@/lib/dataProvenance";

export default function DataProvenance({ status }: { status: DataStatus }) {
  return <span role="status" className="text-xs" style={{ color: status === "demo" || status === "unavailable" ? "var(--accent-yellow)" : "var(--muted)" }}>{DATA_LABELS[status]}</span>;
}
