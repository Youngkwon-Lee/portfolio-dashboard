"use client";
import { useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
  Legend, ReferenceLine, AreaChart, Area,
} from "recharts";
import { FlaskConical, Play, ShieldCheck } from "lucide-react";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

// ── 타입 ──────────────────────────────────────

interface BtResult {
  strategy:         string;
  strategy_label:   string;
  initial:          number;
  final:            number;
  total_return_pct: number;
  cagr:             number;
  sharpe:           number;
  sortino:          number;
  calmar:           number;
  mdd:              number;
  win_rate:         number;
  profit_factor:    number;
  total_trades:     number;
  total_cost:       number;
  curve:            { date: string; value: number; dd: number }[];
  monthly_returns:  { year: string; month: string; pct: number }[];
  trades:           { date: string; side: string; price: number; cost: number }[];
  description:      string;
  paper:            string;
}

interface BtResponse {
  ticker:  string;
  period:  string;
  execution_mode: string;
  live_allowed: boolean;
  costs: { commission_bps: number; slippage_bps: number; total_bps: number };
  source: string;
  fetched_at: string | null;
  benchmark: {
    strategy: string;
    strategy_label: string;
    final: number;
    total_return_pct: number;
    mdd: number;
  } | null;
  validation: {
    method: string;
    label: string;
    train_ratio: number;
    train_samples: number;
    test_samples: number;
    warning: string | null;
    train_end: string;
    test_start: string;
    results: {
      strategy: string;
      strategy_label: string;
      train_return_pct: number;
      test_return_pct: number;
      test_mdd: number;
      test_sharpe: number;
    }[];
  };
  walk_forward: {
    method: string;
    available: boolean;
    reason: string | null;
    folds: { fold: number; train_end: string; test_start: string; test_end: string; test_samples: number; results: BtResult[] }[];
  };
  results: BtResult[];
}

// ── 상수 ──────────────────────────────────────

const STRATEGIES = [
  { value: "all",       label: "전략 전체 비교" },
  { value: "ensemble",  label: "🏆 앙상블 (다수결)" },
  { value: "bah",       label: "Buy & Hold" },
  { value: "dual_mom",  label: "Dual Momentum" },
  { value: "sma_cross", label: "SMA 10/30 크로스" },
  { value: "bollinger", label: "Bollinger Band" },
  { value: "rsi",       label: "RSI(14) 역추세" },
];

const PERIODS  = ["1M", "3M", "6M", "1Y"] as const;
const COLORS   = ["#58a6ff", "#3fb950", "#e3b341", "#bc8cff", "#f85149"];

const MONTHS   = ["1","2","3","4","5","6","7","8","9","10","11","12"];

// ── 유틸 ──────────────────────────────────────

function fmt(n: number, prefix = "") {
  return `${prefix}${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}
function fmtKRW(n: number) {
  if (Math.abs(n) >= 1e8) return `${(n / 1e8).toFixed(2)}억`;
  if (Math.abs(n) >= 1e4) return `${(n / 1e4).toFixed(0)}만`;
  return n.toLocaleString();
}
function heatColor(pct: number) {
  if (pct >  5) return "#1a4731";
  if (pct >  2) return "#2d6a4f";
  if (pct >  0) return "#1e4d38";
  if (pct > -2) return "#4d1f1f";
  if (pct > -5) return "#7a2222";
  return "#a62c2c";
}

// ── 서브 컴포넌트 ─────────────────────────────

function KPI({ label, value, color, sub }: { label: string; value: string; color?: string; sub?: string }) {
  return (
    <div className="flex flex-col gap-0.5 p-3 rounded-lg" style={{ background: "#0d1117", border: "1px solid var(--card-border)" }}>
      <div className="text-xs" style={{ color: "var(--muted)" }}>{label}</div>
      <div className="text-base font-bold" style={{ color: color ?? "var(--foreground)" }}>{value}</div>
      {sub && <div className="text-xs" style={{ color: "var(--muted)" }}>{sub}</div>}
    </div>
  );
}

function ScoreBar({ value, max = 3, label }: { value: number; max?: number; label: string }) {
  const pct = Math.min(Math.abs(value) / max * 100, 100);
  const good = value > 0;
  return (
    <div className="flex items-center gap-2 text-xs">
      <div className="w-20 text-right" style={{ color: "var(--muted)" }}>{label}</div>
      <div className="flex-1 h-1.5 rounded-full" style={{ background: "var(--card-border)" }}>
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: good ? "var(--accent-green)" : "var(--accent-red)" }} />
      </div>
      <div className="w-12" style={{ color: good ? "var(--accent-green)" : "var(--accent-red)" }}>
        {value.toFixed(2)}
      </div>
    </div>
  );
}

function MonthlyHeatmap({ data }: { data: BtResult["monthly_returns"] }) {
  // year → month → pct
  const map: Record<string, Record<string, number>> = {};
  for (const d of data) {
    if (!map[d.year]) map[d.year] = {};
    map[d.year][d.month] = d.pct;
  }
  const years = Object.keys(map).sort();

  return (
    <div className="overflow-x-auto">
      <table className="text-xs w-full border-collapse">
        <thead>
          <tr>
            <th className="py-1 pr-2 text-right" style={{ color: "var(--muted)" }}>연도</th>
            {MONTHS.map((m) => (
              <th key={m} className="px-1 py-1 text-center w-10" style={{ color: "var(--muted)" }}>{m}월</th>
            ))}
            <th className="px-1 py-1 text-center" style={{ color: "var(--muted)" }}>합계</th>
          </tr>
        </thead>
        <tbody>
          {years.map((y) => {
            const yearTotal = Object.values(map[y]).reduce((a, b) => a + b, 0);
            return (
              <tr key={y}>
                <td className="py-0.5 pr-2 text-right font-semibold" style={{ color: "var(--muted)" }}>{y}</td>
                {MONTHS.map((m) => {
                  const pct = map[y][m.padStart(2, "0")];
                  return (
                    <td key={m} className="px-0.5 py-0.5">
                      {pct !== undefined ? (
                        <div
                          className="text-center rounded py-0.5 px-1"
                          style={{ background: heatColor(pct), color: "#fff", minWidth: 36 }}
                          title={`${y}-${m}월: ${pct.toFixed(2)}%`}
                        >
                          {pct > 0 ? "+" : ""}{pct.toFixed(1)}
                        </div>
                      ) : (
                        <div className="text-center" style={{ color: "#30363d" }}>—</div>
                      )}
                    </td>
                  );
                })}
                <td className="px-1 py-0.5 text-center font-bold"
                  style={{ color: yearTotal >= 0 ? "var(--accent-green)" : "var(--accent-red)" }}>
                  {yearTotal >= 0 ? "+" : ""}{yearTotal.toFixed(1)}%
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── 메인 ──────────────────────────────────────

export default function BacktestPage() {
  const [ticker,   setTicker]   = useState("BTC");
  const [period,   setPeriod]   = useState<"1M"|"3M"|"6M"|"1Y">("1Y");
  const [initial,  setInitial]  = useState("10000000");
  const [commissionBps, setCommissionBps] = useState("10");
  const [slippageBps, setSlippageBps] = useState("5");
  const [strategy, setStrategy] = useState("all");
  const [response, setResponse] = useState<BtResponse | null>(null);
  const [selected, setSelected] = useState<BtResult | null>(null);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState("");
  const [tab,      setTab]      = useState<"curve"|"dd"|"monthly"|"trades">("curve");

  async function run() {
    setLoading(true);
    setError("");
    setResponse(null);
    setSelected(null);
    try {
      const res = await fetch(`${API_BASE}/api/backtest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticker: ticker.trim().toUpperCase(), period, initial: Number(initial), strategy,
          commission_bps: Number(commissionBps), slippage_bps: Number(slippageBps),
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail ?? "서버 오류");
      }
      const data: BtResponse = await res.json();
      setResponse(data);
      setSelected(data.results[0]);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "요청 실패");
    } finally {
      setLoading(false);
    }
  }

  // 비교 차트 데이터 (all 모드)
  const compareData = (() => {
    if (!response || response.results.length < 2) return [];
    const len = Math.min(...response.results.map((r) => r.curve.length));
    return response.results[0].curve.slice(0, len).map((_, i) => {
      const point: Record<string, unknown> = { date: response.results[0].curve[i].date };
      for (const r of response.results) {
        point[r.strategy] = +(((r.curve[i].value - r.initial) / r.initial) * 100).toFixed(2);
      }
      return point;
    });
  })();

  const isAll = strategy === "all";

  return (
    <div className="flex flex-col h-full p-4 gap-4 overflow-y-auto">
      {/* 헤더 */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <span className="text-sm font-bold flex items-center gap-2"><FlaskConical size={16} aria-hidden="true" /> 백테스트</span>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <span className="text-xs px-2 py-0.5 rounded" style={{ background: "#58a6ff18", color: "var(--accent-blue)", border: "1px solid #58a6ff55" }}>
            HISTORICAL SIMULATION · 실제 주문 없음
          </span>
          {response && (response.execution_mode === "paper" && response.live_allowed === false ? (
            <span className="text-xs px-2 py-0.5 rounded" aria-label="백테스트 실행 모드" style={{ background: "#3fb95018", color: "var(--accent-green)", border: "1px solid #3fb95055" }}>
              PAPER ONLY · LIVE 차단
            </span>
          ) : (
            <span className="text-xs px-2 py-0.5 rounded" role="alert" aria-label="백테스트 실행 모드 확인 실패" style={{ background: "#f8514918", color: "var(--accent-red)", border: "1px solid #f8514955" }}>
              실행 모드 확인 실패
            </span>
          ))}
          {response?.fetched_at && (
            <span className="text-xs" style={{ color: "var(--muted)" }}>
              출처: {response.source} · 조회 {new Date(response.fetched_at).toLocaleString("ko-KR")}
            </span>
          )}
        </div>
      </div>

      <div className="p-3 rounded-lg flex gap-3" role="note" style={{ background: "var(--card)", border: "1px solid var(--card-border)" }}>
        <ShieldCheck size={18} className="shrink-0" aria-hidden="true" style={{ color: "var(--accent-blue)" }} />
        <div className="text-xs leading-relaxed">
          <div className="font-semibold">계좌·주문 경로와 분리된 과거 데이터 시뮬레이션</div>
          <div className="mt-0.5" style={{ color: "var(--muted)" }}>수수료·슬리피지와 무위험 수익률을 직접 설정합니다. 결과는 미래 수익을 보장하지 않습니다.</div>
        </div>
      </div>

      {/* 설정 */}
      <div className="backtest-config p-4 rounded-lg grid grid-cols-4 gap-3" style={{ background: "var(--card)", border: "1px solid var(--card-border)" }}>
        <div className="flex flex-col gap-1">
          <label className="text-xs" style={{ color: "var(--muted)" }}>종목</label>
          <input
            value={ticker}
            aria-label="백테스트 종목"
            onChange={(e) => setTicker(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && run()}
            placeholder="AAPL, BTC, 005930…"
            className="px-3 py-2 rounded text-sm outline-none"
            style={{ background: "#0d1117", border: "1px solid var(--card-border)", color: "var(--foreground)" }}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs" style={{ color: "var(--muted)" }}>초기 투자금</label>
          <input
            value={Number(initial).toLocaleString()}
            aria-label="백테스트 초기 투자금"
            inputMode="numeric"
            onChange={(e) => setInitial(e.target.value.replace(/[^0-9]/g, ""))}
            className="px-3 py-2 rounded text-sm outline-none"
            style={{ background: "#0d1117", border: "1px solid var(--card-border)", color: "var(--foreground)" }}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs" style={{ color: "var(--muted)" }}>기간</label>
          <div className="flex gap-1 h-full items-end pb-0.5">
            {PERIODS.map((p) => (
              <button key={p} onClick={() => setPeriod(p)}
                className="flex-1 py-2 rounded text-xs"
                style={{
                  background: period === p ? "var(--accent-blue)" : "#0d1117",
                  color: period === p ? "#fff" : "var(--muted)",
                  border: "1px solid var(--card-border)",
                }}>
                {p}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs" style={{ color: "var(--muted)" }}>전략</label>
          <select value={strategy} onChange={(e) => setStrategy(e.target.value)} aria-label="백테스트 전략"
            className="px-3 py-2 rounded text-sm outline-none"
            style={{ background: "#0d1117", border: "1px solid var(--card-border)", color: "var(--foreground)" }}>
            {STRATEGIES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs" style={{ color: "var(--muted)" }}>수수료 (bps)</label>
          <input value={commissionBps} aria-label="백테스트 수수료" inputMode="decimal"
            onChange={(e) => setCommissionBps(e.target.value.replace(/[^0-9.]/g, ""))}
            className="px-3 py-2 rounded text-sm outline-none" style={{ background: "#0d1117", border: "1px solid var(--card-border)", color: "var(--foreground)" }} />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs" style={{ color: "var(--muted)" }}>슬리피지 (bps)</label>
          <input value={slippageBps} aria-label="백테스트 슬리피지" inputMode="decimal"
            onChange={(e) => setSlippageBps(e.target.value.replace(/[^0-9.]/g, ""))}
            className="px-3 py-2 rounded text-sm outline-none" style={{ background: "#0d1117", border: "1px solid var(--card-border)", color: "var(--foreground)" }} />
        </div>

        <button onClick={run} disabled={loading}
          className="backtest-run col-span-4 py-2.5 rounded text-sm font-bold flex items-center justify-center gap-2"
          style={{ background: loading ? "#30363d" : "var(--accent-blue)", color: "#fff" }}>
          {!loading && <Play size={14} fill="currentColor" aria-hidden="true" />}
          {loading ? "계산 중…" : "시뮬레이션 실행"}
        </button>
      </div>

      {/* 에러 */}
      {error && (
        <div className="text-sm px-3 py-2 rounded" style={{ background: "#f8514922", color: "var(--accent-red)", border: "1px solid #f8514944" }}>
          {error}
        </div>
      )}

      {/* ── 전략 비교 테이블 (all 모드) ── */}
      {response && isAll && (
        <div className="shrink-0 rounded-lg overflow-x-auto" style={{ border: "1px solid var(--card-border)" }}>
          <table className="w-full min-w-[760px] text-xs">
            <thead>
              <tr style={{ background: "#0d1117" }}>
                {["전략","수익률","CAGR","Sharpe","Sortino","Calmar","MDD","거래수","비용"].map((h) => (
                  <th key={h} className="px-3 py-2 text-left font-semibold" style={{ color: "var(--muted)" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {response.results.map((r, i) => (
                <tr key={r.strategy}
                  onClick={() => setSelected(r)}
                  className="cursor-pointer transition-colors"
                  style={{
                    background: selected?.strategy === r.strategy ? "var(--card)" : "transparent",
                    borderTop: "1px solid var(--card-border)",
                  }}>
                  <td className="px-3 py-2 font-semibold" style={{ color: COLORS[i] }}>{r.strategy_label}</td>
                  <td className="px-3 py-2 font-bold" style={{ color: r.total_return_pct >= 0 ? "var(--accent-green)" : "var(--accent-red)" }}>
                    {fmt(r.total_return_pct)}
                  </td>
                  <td className="px-3 py-2" style={{ color: r.cagr >= 0 ? "var(--accent-green)" : "var(--accent-red)" }}>{fmt(r.cagr)}</td>
                  <td className="px-3 py-2" style={{ color: r.sharpe >= 1 ? "var(--accent-green)" : r.sharpe >= 0 ? "var(--accent-yellow)" : "var(--accent-red)" }}>{r.sharpe.toFixed(3)}</td>
                  <td className="px-3 py-2" style={{ color: r.sortino >= 1 ? "var(--accent-green)" : r.sortino >= 0 ? "var(--accent-yellow)" : "var(--accent-red)" }}>{r.sortino.toFixed(3)}</td>
                  <td className="px-3 py-2" style={{ color: r.calmar >= 0.5 ? "var(--accent-green)" : "var(--accent-red)" }}>{r.calmar.toFixed(3)}</td>
                  <td className="px-3 py-2" style={{ color: "var(--accent-red)" }}>-{r.mdd.toFixed(2)}%</td>
                  <td className="px-3 py-2" style={{ color: "var(--muted)" }}>{r.total_trades}</td>
                  <td className="px-3 py-2" style={{ color: "var(--muted)" }}>{fmtKRW(r.total_cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── 전략 비교 수익률 차트 (all 모드) ── */}
      {response && isAll && compareData.length > 0 && (
        <div className="p-4 rounded-lg" style={{ background: "var(--card)", border: "1px solid var(--card-border)" }}>
          <div className="text-xs font-semibold mb-3" style={{ color: "var(--muted)" }}>전략별 누적 수익률 비교 (%)</div>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={compareData} margin={{ top: 4, right: 4, left: -10, bottom: 0 }}>
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#8b949e" }} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 10, fill: "#8b949e" }} tickFormatter={(v) => `${v}%`} domain={["auto","auto"]} />
              <Tooltip contentStyle={{ background: "#161b22", border: "1px solid #30363d", fontSize: 11 }}
                formatter={(v: unknown, name: unknown) => [`${(v as number).toFixed(2)}%`, response.results.find((r) => r.strategy === name)?.strategy_label ?? name as string]} />
              <ReferenceLine y={0} stroke="#30363d" strokeDasharray="3 3" />
              <Legend formatter={(v) => response.results.find((r) => r.strategy === v)?.strategy_label ?? v} wrapperStyle={{ fontSize: 11 }} />
              {response.results.map((r, i) => (
                <Line key={r.strategy} type="monotone" dataKey={r.strategy}
                  stroke={COLORS[i]} dot={false} strokeWidth={r.strategy === selected?.strategy ? 2.5 : 1.5}
                  strokeDasharray={i === 0 ? undefined : undefined} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* ── 선택된 전략 상세 ── */}
      {selected && (
        <div className="flex flex-col gap-4">
          {/* 전략 설명 */}
          <div className="p-3 rounded-lg text-xs flex flex-col gap-1" style={{ background: "var(--card)", border: "1px solid var(--card-border)" }}>
            <div className="font-bold text-sm" style={{ color: "var(--accent-blue)" }}>{selected.strategy_label}</div>
            <div style={{ color: "var(--muted)" }}>{selected.description}</div>
            <div style={{ color: "#8b949e66" }}>📄 {selected.paper}</div>
          </div>

          {/* KPI 그리드 */}
          <div className="backtest-kpi-grid grid grid-cols-4 gap-2">
            <KPI label="총 수익률" value={fmt(selected.total_return_pct)} color={selected.total_return_pct >= 0 ? "var(--accent-green)" : "var(--accent-red)"}
              sub={`${fmtKRW(selected.final - selected.initial)} 손익`} />
            <KPI label="CAGR (연율)" value={fmt(selected.cagr)} color={selected.cagr >= 0 ? "var(--accent-green)" : "var(--accent-red)"} sub="연복리 수익률" />
            <KPI label="최대 낙폭(MDD)" value={`-${selected.mdd.toFixed(2)}%`} color="var(--accent-red)" sub="최대 손실 구간" />
            <KPI label="최종 자산" value={fmtKRW(selected.final)} sub={`초기 ${fmtKRW(selected.initial)}`} />
          </div>

          {response && response.benchmark && selected.strategy !== response.benchmark.strategy && (
            <div className="p-3 rounded-lg text-xs flex items-center justify-between" style={{ background: "#0d1117", border: "1px solid var(--card-border)" }}>
              <span style={{ color: "var(--muted)" }}>Buy & Hold 기준선 대비</span>
              <span className="font-semibold" style={{ color: selected.total_return_pct >= response.benchmark.total_return_pct ? "var(--accent-green)" : "var(--accent-red)" }}>
                {fmt(selected.total_return_pct - response.benchmark.total_return_pct)}p
              </span>
            </div>
          )}

          {response && (() => {
            const validation = response.validation.results.find((r) => r.strategy === selected.strategy);
            return validation ? (
              <div className="p-3 rounded-lg text-xs" style={{ background: "#0d1117", border: "1px solid var(--card-border)" }}>
                <div className="flex items-center justify-between mb-1">
                  <span className="font-semibold">{response.validation.label} (70% / 30%)</span>
                  <span style={{ color: "var(--muted)" }}>{response.validation.test_start} 이후</span>
                </div>
                <div className="grid grid-cols-4 gap-2" style={{ color: "var(--muted)" }}>
                  <span>학습 {fmt(validation.train_return_pct)}</span>
                  <span style={{ color: validation.test_return_pct >= 0 ? "var(--accent-green)" : "var(--accent-red)" }}>검증 {fmt(validation.test_return_pct)}</span>
                  <span>검증 MDD -{validation.test_mdd.toFixed(2)}%</span>
                  <span>검증 Sharpe {validation.test_sharpe.toFixed(3)}</span>
                </div>
                <div className="mt-1" style={{ color: response.validation.warning ? "var(--accent-yellow)" : "var(--muted)" }}>
                  표본 학습 {response.validation.train_samples}개 · 검증 {response.validation.test_samples}개
                  {response.validation.warning ? ` · ${response.validation.warning}` : ""}
                </div>
              </div>
            ) : null;
          })()}

          {response?.walk_forward && (
            <div className="p-3 rounded-lg text-xs" style={{ background: "#0d1117", border: "1px solid var(--card-border)" }}>
              <div className="font-semibold mb-1">워크포워드 검증 (확장 윈도우)</div>
              {response.walk_forward.available ? (() => {
                const foldResults = response.walk_forward.folds.map((fold) => ({
                  fold: fold.fold,
                  result: fold.results.find((result) => result.strategy === selected.strategy),
                })).filter((fold) => fold.result);
                const averageReturn = foldResults.reduce((sum, fold) => sum + (fold.result?.total_return_pct ?? 0), 0) / Math.max(foldResults.length, 1);
                return (
                  <>
                    <div className="flex flex-wrap gap-x-3 gap-y-1" style={{ color: "var(--muted)" }}>
                      {foldResults.map(({ fold, result }) => (
                        <span key={fold}>폴드 {fold} {fmt(result?.total_return_pct ?? 0)}</span>
                      ))}
                      <span className="font-semibold" style={{ color: averageReturn >= 0 ? "var(--accent-green)" : "var(--accent-red)" }}>
                        평균 {fmt(averageReturn)}
                      </span>
                    </div>
                  </>
                );
              })() : (
                <div style={{ color: "var(--muted)" }}>{response.walk_forward.reason}</div>
              )}
            </div>
          )}

          {/* 위험조정 지표 */}
          <div className="p-3 rounded-lg flex flex-col gap-2" style={{ background: "var(--card)", border: "1px solid var(--card-border)" }}>
            <div className="text-xs font-semibold mb-1">위험 조정 지표</div>
            <ScoreBar label="Sharpe" value={selected.sharpe} max={2} />
            <ScoreBar label="Sortino" value={selected.sortino} max={3} />
            <ScoreBar label="Calmar" value={Math.min(selected.calmar, 3)} max={3} />
            <div className="grid grid-cols-3 gap-2 mt-1 text-xs">
              <div><span style={{ color: "var(--muted)" }}>승률 </span><span className="font-semibold">{selected.win_rate.toFixed(1)}%</span></div>
              <div><span style={{ color: "var(--muted)" }}>Profit Factor </span><span className="font-semibold">{selected.profit_factor.toFixed(2)}</span></div>
              <div><span style={{ color: "var(--muted)" }}>총 거래비용 </span><span className="font-semibold">{fmtKRW(selected.total_cost)}</span></div>
            </div>
          </div>

          {/* 상세 탭 */}
          <div className="p-4 rounded-lg flex flex-col gap-3" style={{ background: "var(--card)", border: "1px solid var(--card-border)" }}>
            <div className="flex gap-1">
              {(["curve","dd","monthly","trades"] as const).map((t) => (
                <button key={t} onClick={() => setTab(t)}
                  className="px-3 py-1 rounded text-xs"
                  style={{ background: tab === t ? "var(--accent-blue)" : "#0d1117", color: tab === t ? "#fff" : "var(--muted)", border: "1px solid var(--card-border)" }}>
                  {t === "curve" ? "자산 곡선" : t === "dd" ? "낙폭" : t === "monthly" ? "월별 수익" : "매매 내역"}
                </button>
              ))}
            </div>

            {tab === "curve" && (
              <ResponsiveContainer width="100%" height={200}>
                <AreaChart data={selected.curve} margin={{ top: 4, right: 4, left: -10, bottom: 0 }}>
                  <defs>
                    <linearGradient id="curveGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#58a6ff" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#58a6ff" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#8b949e" }} interval="preserveStartEnd" />
                  <YAxis tick={{ fontSize: 10, fill: "#8b949e" }} tickFormatter={(v) => fmtKRW(v)} domain={["auto","auto"]} />
                  <Tooltip contentStyle={{ background: "#161b22", border: "1px solid #30363d", fontSize: 11 }}
                    formatter={(v: unknown) => [fmtKRW(v as number) + "원", "자산"]} />
                  <ReferenceLine y={selected.initial} stroke="#30363d" strokeDasharray="4 4" />
                  <Area type="monotone" dataKey="value" stroke="#58a6ff" fill="url(#curveGrad)" dot={false} strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            )}

            {tab === "dd" && (
              <ResponsiveContainer width="100%" height={200}>
                <AreaChart data={selected.curve} margin={{ top: 4, right: 4, left: -10, bottom: 0 }}>
                  <defs>
                    <linearGradient id="ddGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#f85149" stopOpacity={0.4} />
                      <stop offset="95%" stopColor="#f85149" stopOpacity={0.05} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#8b949e" }} interval="preserveStartEnd" />
                  <YAxis tick={{ fontSize: 10, fill: "#8b949e" }} tickFormatter={(v) => `${v}%`} />
                  <Tooltip contentStyle={{ background: "#161b22", border: "1px solid #30363d", fontSize: 11 }}
                    formatter={(v: unknown) => [`${(v as number).toFixed(2)}%`, "낙폭"]} />
                  <Area type="monotone" dataKey="dd" stroke="#f85149" fill="url(#ddGrad)" dot={false} strokeWidth={1.5} />
                </AreaChart>
              </ResponsiveContainer>
            )}

            {tab === "monthly" && (
              <MonthlyHeatmap data={selected.monthly_returns} />
            )}

            {tab === "trades" && (
              <div className="overflow-y-auto max-h-52">
                {selected.trades.length === 0 ? (
                  <div className="text-xs text-center py-4" style={{ color: "var(--muted)" }}>매매 내역 없음</div>
                ) : (
                  <table className="w-full text-xs">
                    <thead>
                      <tr style={{ color: "var(--muted)" }}>
                        <th className="text-left py-1">날짜</th>
                        <th className="text-left py-1">구분</th>
                        <th className="text-right py-1">체결가</th>
                        <th className="text-right py-1">거래비용</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selected.trades.map((t, i) => (
                        <tr key={i} style={{ borderTop: "1px solid var(--card-border)" }}>
                          <td className="py-1" style={{ color: "var(--muted)" }}>{t.date}</td>
                          <td className="py-1 font-semibold" style={{ color: t.side === "BUY" ? "var(--accent-green)" : "var(--accent-red)" }}>{t.side}</td>
                          <td className="py-1 text-right">{t.price.toLocaleString()}</td>
                          <td className="py-1 text-right" style={{ color: "var(--muted)" }}>{fmtKRW(t.cost)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
