"use client";
import { useState, useEffect, useRef } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";
import { Gauge, LockKeyhole, OctagonX, Play, ShieldCheck, Square, TriangleAlert } from "lucide-react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

// ── 타입 ──────────────────────────────────────────

interface Position {
  symbol: string; qty: number; avg_price: number;
  current_price?: number; unrealized_pnl?: number;
  unrealized_pnl_pct?: number; invest: number; entry_time: string;
}
interface Trade {
  id: string; symbol: string; side: string; qty: number;
  price: number; cost: number; mode: string; strategy: string;
  timestamp: string; pnl: number; pnl_pct: number;
}
interface BotStatus {
  running: boolean; mode: string; strategy: string;
  symbols: string[]; initial_capital: number; current_capital: number;
  peak_capital: number; total_pnl: number; total_pnl_pct: number;
  drawdown_pct: number; daily_pnl_pct: number; trade_count: number;
  win_count: number; last_signal: Record<string, SignalInfo>;
  last_run: string; error: string; circuit_breaker: boolean;
  positions: Record<string, Position>; trades: Trade[];
  live_allowed: boolean;
  safety?: {
    execution_mode: string;
    live_allowed: boolean;
    credential_input_allowed: boolean;
    live_block_reason: string;
    state: {
      kill_switch: boolean;
      daily_halt: boolean;
      reconciliation_required: boolean;
      halt_reason: string;
    };
  };
}
interface SignalInfo {
  signal: string; price?: number; strategy?: string;
  momentum_12m?: number; sma10?: number; sma30?: number;
  rsi?: number; upper?: number; lower?: number; mid?: number;
  reason?: string; error?: string;
}

// ── 상수 ──────────────────────────────────────────

const STRATEGIES = [
  { value: "ensemble",  label: "🏆 앙상블 (다수결)",  desc: "5전략 투표 — 60% 동의 시 매매 (권장)" },
  { value: "dual_mom",  label: "Dual Momentum",      desc: "Antonacci 2012 — 하락장 현금 전환" },
  { value: "sma_cross", label: "SMA 10/30 크로스",    desc: "Faber 2007 — 추세 추종" },
  { value: "bollinger", label: "Bollinger Band",      desc: "Lo et al. 2000 — 평균 회귀" },
  { value: "rsi",       label: "RSI(14) 역추세",      desc: "Wilder 1978 — 과매도/과매수" },
  { value: "bah",       label: "Buy & Hold",          desc: "항상 보유 (기준선)" },
];

const SYMBOLS = ["BTC", "ETH", "SOL", "BNB", "XRP", "ADA", "DOGE"];

const SIG_COLOR: Record<string, string> = {
  BUY:  "var(--accent-green)",
  SELL: "var(--accent-red)",
  HOLD: "var(--accent-yellow)",
  ERROR: "#8b949e",
};

// ── 유틸 ──────────────────────────────────────────

function fmtMoney(n: number) {
  if (Math.abs(n) >= 1e8) return `${(n/1e8).toFixed(2)}억`;
  if (Math.abs(n) >= 1e4) return `${Math.round(n/1e4)}만`;
  return n.toLocaleString();
}
function fmtTime(iso: string) {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("ko-KR", { month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit" });
}

// ── 서브 컴포넌트 ─────────────────────────────────

function StatCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="flex flex-col gap-0.5 p-3 rounded-lg" style={{ background: "#0d1117", border: "1px solid var(--card-border)" }}>
      <div className="text-xs" style={{ color: "var(--muted)" }}>{label}</div>
      <div className="text-lg font-bold" style={{ color: color ?? "var(--foreground)" }}>{value}</div>
      {sub && <div className="text-xs" style={{ color: "var(--muted)" }}>{sub}</div>}
    </div>
  );
}

function SignalBadge({ signal }: { signal: string }) {
  return (
    <span className="px-2 py-0.5 rounded text-xs font-bold"
      style={{ background: `${SIG_COLOR[signal] ?? "#8b949e"}22`, color: SIG_COLOR[signal] ?? "#8b949e", border: `1px solid ${SIG_COLOR[signal] ?? "#8b949e"}44` }}>
      {signal}
    </span>
  );
}

function PnlCurve({ trades }: { trades: Trade[] }) {
  const data = [...trades].reverse().reduce<{ date: string; cumPnl: number }[]>((acc, t) => {
    const prev = acc[acc.length - 1]?.cumPnl ?? 0;
    acc.push({ date: fmtTime(t.timestamp), cumPnl: +(prev + (t.pnl ?? 0)).toFixed(0) });
    return acc;
  }, []);
  if (data.length < 2) return <div className="text-xs text-center py-6" style={{ color: "var(--muted)" }}>매매 후 PnL 곡선이 표시됩니다</div>;
  const isUp = (data.at(-1)?.cumPnl ?? 0) >= 0;
  return (
    <ResponsiveContainer width="100%" height={120}>
      <LineChart data={data} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
        <XAxis dataKey="date" tick={{ fontSize: 9, fill: "#8b949e" }} interval="preserveStartEnd" />
        <YAxis tick={{ fontSize: 9, fill: "#8b949e" }} tickFormatter={(v) => fmtMoney(v)} domain={["auto","auto"]} />
        <Tooltip contentStyle={{ background: "#161b22", border: "1px solid #30363d", fontSize: 11 }}
          formatter={(v: unknown) => [fmtMoney(v as number) + "원", "누적 손익"]} />
        <ReferenceLine y={0} stroke="#30363d" strokeDasharray="3 3" />
        <Line type="monotone" dataKey="cumPnl" stroke={isUp ? "var(--accent-green)" : "var(--accent-red)"} dot={false} strokeWidth={2} />
      </LineChart>
    </ResponsiveContainer>
  );
}

// ── 메인 ──────────────────────────────────────────

export default function BotPage() {
  const [status,    setStatus]    = useState<BotStatus | null>(null);
  const [strategy,  setStrategy]  = useState("dual_mom");
  const [symbols,   setSymbols]   = useState<string[]>(["BTC", "ETH"]);
  const [capital,   setCapital]   = useState("1000000");
  const [starting,  setStarting]  = useState(false);
  const [activeTab, setActiveTab] = useState<"signals"|"positions"|"trades">("signals");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function fetchStatus() {
    try {
      const r = await fetch(`${API}/api/bot/status`);
      if (r.ok) setStatus(await r.json());
    } catch {}
  }

  useEffect(() => {
    fetchStatus();
    pollRef.current = setInterval(fetchStatus, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  async function handleStart() {
    setStarting(true);
    try {
      const r = await fetch(`${API}/api/bot/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "paper", strategy, symbols,
          initial_capital: Number(capital),
        }),
      });
      if (!r.ok) {
        const e = await r.json();
        alert(e.detail ?? "시작 실패");
      } else {
        await fetchStatus();
      }
    } finally {
      setStarting(false);
    }
  }

  async function handleStop() {
    await fetch(`${API}/api/bot/stop`, { method: "POST" });
    await fetchStatus();
  }

  async function handleKillSwitch() {
    await fetch(`${API}/api/bot/kill-switch`, { method: "POST" });
    await fetchStatus();
  }

  const isRunning  = status?.running ?? false;
  const pnlPositive = (status?.total_pnl_pct ?? 0) >= 0;
  const winRate    = status?.trade_count ? Math.round(status.win_count / status.trade_count * 100) : 0;
  const positions  = Object.values(status?.positions ?? {}) as Position[];
  const trades     = status?.trades ?? [];
  const safetyState = status?.safety?.state;
  const safetyBlocked = Boolean(
    safetyState?.kill_switch || safetyState?.daily_halt || safetyState?.reconciliation_required
  );

  return (
    <div className="bot-layout flex h-full overflow-hidden">

      {/* ── 왼쪽: 설정 패널 ── */}
      <div className="bot-sidebar w-72 shrink-0 flex flex-col gap-3 p-4 overflow-y-auto" style={{ borderRight: "1px solid var(--card-border)" }}>

        {/* 상태 헤더 */}
        <div className="flex items-center gap-2">
          <ShieldCheck size={16} aria-hidden="true" style={{ color: "var(--accent-blue)" }} />
          <div className="w-2 h-2 rounded-full" style={{ background: isRunning ? "var(--accent-green)" : "#30363d", boxShadow: isRunning ? "0 0 6px var(--accent-green)" : "none" }} />
          <span className="text-sm font-bold">{isRunning ? "Paper 봇 실행 중" : "Paper 봇 대기 중"}</span>
          {status?.circuit_breaker && (
            <span className="text-xs px-2 py-0.5 rounded" style={{ background: "#f8514922", color: "var(--accent-red)" }}>Kill switch</span>
          )}
        </div>

        <div className="p-3 rounded-lg text-xs flex gap-2" role="status" style={{ background: "#58a6ff14", border: "1px solid #58a6ff55" }}>
          <ShieldCheck size={17} className="shrink-0 mt-0.5" aria-hidden="true" style={{ color: "var(--accent-blue)" }} />
          <div>
            <div className="font-bold" style={{ color: "var(--accent-blue)" }}>PAPER ONLY · 가상 체결</div>
            <div className="mt-1 leading-relaxed" style={{ color: "var(--muted)" }}>
              거래소·증권사 주문과 자격 증명 입력은 서버에서 차단됩니다.
            </div>
          </div>
        </div>

        {/* 모드 선택 */}
        <div className="flex flex-col gap-1.5">
          <div className="text-xs font-semibold" style={{ color: "var(--muted)" }}>실행 모드</div>
          <div className="grid grid-cols-2 gap-1">
            <button type="button" disabled className="py-2 rounded text-xs font-bold flex items-center justify-center gap-1.5"
              style={{ background: "var(--accent-blue)", color: "#fff", border: "1px solid var(--accent-blue)", opacity: 1 }}>
              <ShieldCheck size={13} aria-hidden="true" /> Paper
            </button>
            <button type="button" disabled aria-describedby="live-mode-blocked"
              className="py-2 rounded text-xs font-bold flex items-center justify-center gap-1.5 cursor-not-allowed"
              style={{ background: "#0d1117", color: "var(--muted)", border: "1px solid var(--card-border)", opacity: 0.65 }}>
              <LockKeyhole size={13} aria-hidden="true" /> Live 차단
            </button>
          </div>
          <div id="live-mode-blocked" className="text-xs leading-relaxed" style={{ color: "var(--muted)" }}>
            Live는 법무·보안 승인 전까지 이중 확인 여부와 관계없이 사용할 수 없습니다.
          </div>
        </div>

        {safetyBlocked && (
          <div className="p-3 rounded text-xs flex gap-2" role="alert" style={{ background: "#f8514915", color: "var(--accent-red)", border: "1px solid #f8514955" }}>
            <TriangleAlert size={16} className="shrink-0" aria-hidden="true" />
            <span>{safetyState?.halt_reason || "안전 상태가 paper 주문을 차단했습니다."}</span>
          </div>
        )}

        {/* 실행 중에도 kill switch가 첫 화면에 보이도록 핵심 제어를 상단에 둔다. */}
        {!isRunning ? (
          <button onClick={handleStart} disabled={starting || symbols.length === 0 || safetyBlocked}
            className="py-3 rounded font-bold text-sm flex items-center justify-center gap-2"
            style={{ background: "var(--accent-blue)", color: "#fff", opacity: starting || symbols.length === 0 || safetyBlocked ? 0.55 : 1 }}>
            <Play size={15} fill="currentColor" aria-hidden="true" />
            {starting ? "시작 중…" : "Paper 시뮬레이션 시작"}
          </button>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <button onClick={handleStop}
              className="py-3 rounded font-bold text-sm flex items-center justify-center gap-2"
              style={{ background: "#30363d", color: "var(--foreground)", border: "1px solid var(--card-border)" }}>
              <Square size={13} fill="currentColor" aria-hidden="true" /> 정지
            </button>
            <button onClick={handleKillSwitch}
              className="py-3 rounded font-bold text-sm flex items-center justify-center gap-2"
              style={{ background: "#f8514922", color: "var(--accent-red)", border: "1px solid #f8514966" }}>
              <OctagonX size={15} aria-hidden="true" /> Kill switch
            </button>
          </div>
        )}

        {/* 전략 */}
        <div className="flex flex-col gap-1.5">
          <div className="text-xs font-semibold" style={{ color: "var(--muted)" }}>전략</div>
          {STRATEGIES.map((s) => (
            <button key={s.value} onClick={() => !isRunning && setStrategy(s.value)} disabled={isRunning}
              className="p-2 rounded text-left"
              style={{
                background: strategy === s.value ? "var(--card)" : "#0d1117",
                border: `1px solid ${strategy === s.value ? "var(--accent-blue)" : "var(--card-border)"}`,
                opacity: isRunning ? 0.6 : 1,
              }}>
              <div className="text-xs font-semibold" style={{ color: strategy === s.value ? "var(--accent-blue)" : "var(--foreground)" }}>{s.label}</div>
              <div className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>{s.desc}</div>
            </button>
          ))}
        </div>

        {/* 종목 */}
        <div className="flex flex-col gap-1.5">
          <div className="text-xs font-semibold" style={{ color: "var(--muted)" }}>대상 종목</div>
          <div className="flex flex-wrap gap-1">
            {SYMBOLS.map((s) => (
              <button key={s} disabled={isRunning}
                onClick={() => !isRunning && setSymbols((prev) => prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s])}
                className="px-2 py-1 rounded text-xs font-semibold"
                style={{
                  background: symbols.includes(s) ? "var(--accent-blue)22" : "#0d1117",
                  color: symbols.includes(s) ? "var(--accent-blue)" : "var(--muted)",
                  border: `1px solid ${symbols.includes(s) ? "var(--accent-blue)66" : "var(--card-border)"}`,
                  opacity: isRunning ? 0.6 : 1,
                }}>
                {s}
              </button>
            ))}
          </div>
        </div>

        {/* 초기 자본 */}
        <div className="flex flex-col gap-1.5">
          <div className="text-xs font-semibold" style={{ color: "var(--muted)" }}>초기 자본 (원)</div>
          <input value={Number(capital).toLocaleString()}
            onChange={(e) => !isRunning && setCapital(e.target.value.replace(/[^0-9]/g, ""))}
            disabled={isRunning}
            aria-label="Paper 초기 자본"
            inputMode="numeric"
            className="px-3 py-2 rounded text-sm outline-none"
            style={{ background: "#0d1117", border: "1px solid var(--card-border)", color: "var(--foreground)", opacity: isRunning ? 0.6 : 1 }} />
        </div>

        {/* 리스크 안내 */}
        <div className="p-2 rounded text-xs flex flex-col gap-0.5" style={{ background: "var(--card)", border: "1px solid var(--card-border)", color: "var(--muted)" }}>
          <div className="font-semibold text-xs mb-1 flex items-center gap-1.5" style={{ color: "var(--foreground)" }}><Gauge size={14} aria-hidden="true" /> 영속 리스크 가드</div>
          <div>• 포지션 한도: 자산의 최대 20%</div>
          <div>• 일일 손실 -2%: UTC 당일 중단</div>
          <div>• 최대 낙폭 -10%: kill switch 영속</div>
          <div>• 중복 주문 키·비정상 재시작 차단</div>
        </div>

      </div>

      {/* ── 오른쪽: 모니터링 ── */}
      <div className="bot-monitor flex-1 flex flex-col gap-3 p-4 overflow-y-auto">

        <div className="flex items-start justify-between gap-3 p-3 rounded-lg" style={{ background: "var(--card)", border: "1px solid var(--card-border)" }}>
          <div>
            <div className="text-xs font-bold" style={{ color: "var(--accent-blue)" }}>PAPER EXECUTION LEDGER</div>
            <div className="text-xs mt-1" style={{ color: "var(--muted)" }}>아래 신호·포지션·손익은 모두 가상 체결 결과이며 실제 계좌 상태가 아닙니다.</div>
          </div>
          <span className="shrink-0 text-xs px-2 py-1 rounded font-semibold" style={{ background: "#58a6ff18", color: "var(--accent-blue)", border: "1px solid #58a6ff55" }}>LIVE OFF</span>
        </div>

        {/* 에러 배너 */}
        {status?.error && (
          <div className="px-3 py-2 rounded text-xs flex items-center gap-2" role="alert" style={{ background: "#f8514922", color: "var(--accent-red)", border: "1px solid #f8514944" }}>
            <TriangleAlert size={14} aria-hidden="true" /> {status.error}
          </div>
        )}

        {/* KPI */}
        <div className="bot-kpi-grid grid grid-cols-4 gap-2">
          <StatCard label="총 손익" value={`${pnlPositive ? "+" : ""}${status?.total_pnl_pct?.toFixed(2) ?? "0.00"}%`}
            color={pnlPositive ? "var(--accent-green)" : "var(--accent-red)"}
            sub={`${fmtMoney(status?.total_pnl ?? 0)}원`} />
          <StatCard label="현재 자산"
            value={fmtMoney((status?.current_capital ?? 0) + positions.reduce((a, p) => a + (p.current_price ?? p.avg_price) * p.qty, 0)) + "원"}
            sub={`초기 ${fmtMoney(status?.initial_capital ?? 0)}원`} />
          <StatCard label="최대 낙폭(MDD)" value={`-${status?.drawdown_pct?.toFixed(2) ?? "0.00"}%`}
            color={( status?.drawdown_pct ?? 0) > 5 ? "var(--accent-red)" : "var(--accent-yellow)"} />
          <StatCard label="승률" value={`${winRate}%`}
            sub={`${status?.win_count ?? 0}승 ${(status?.trade_count ?? 0) - (status?.win_count ?? 0)}패`}
            color={winRate >= 50 ? "var(--accent-green)" : "var(--accent-red)"} />
        </div>

        {/* PnL 곡선 */}
        <div className="p-3 rounded-lg" style={{ background: "var(--card)", border: "1px solid var(--card-border)" }}>
          <div className="text-xs font-semibold mb-2" style={{ color: "var(--muted)" }}>누적 손익 곡선</div>
          <PnlCurve trades={trades} />
        </div>

        {/* 탭 */}
        <div className="flex gap-1">
          {(["signals","positions","trades"] as const).map((t) => (
            <button key={t} onClick={() => setActiveTab(t)}
              className="px-3 py-1.5 rounded text-xs"
              style={{
                background: activeTab === t ? "var(--accent-blue)" : "var(--card)",
                color: activeTab === t ? "#fff" : "var(--muted)",
                border: "1px solid var(--card-border)",
              }}>
              {t === "signals" ? `신호 (${Object.keys(status?.last_signal ?? {}).length})` : t === "positions" ? `포지션 (${positions.length})` : `매매 내역 (${trades.length})`}
            </button>
          ))}
          {status?.last_run && (
            <span className="ml-auto text-xs self-center" style={{ color: "var(--muted)" }}>
              마지막 실행: {fmtTime(status.last_run)}
            </span>
          )}
        </div>

        {/* 신호 탭 */}
        {activeTab === "signals" && (
          <div className="flex flex-col gap-2">
            {Object.entries(status?.last_signal ?? {}).length === 0 ? (
              <div className="text-sm text-center py-8" style={{ color: "var(--muted)" }}>
                {isRunning ? "신호 수집 중…" : "봇을 시작하면 신호가 표시됩니다"}
              </div>
            ) : Object.entries(status!.last_signal).map(([sym, info]) => (
              <div key={sym} className="p-3 rounded-lg flex items-center gap-4"
                style={{ background: "var(--card)", border: "1px solid var(--card-border)" }}>
                <div className="w-12 font-bold text-sm">{sym}</div>
                <SignalBadge signal={info.signal} />
                {info.price && <div className="text-sm font-semibold">${info.price.toLocaleString()}</div>}
                <div className="flex gap-3 text-xs ml-2" style={{ color: "var(--muted)" }}>
                  {info.momentum_12m !== undefined && <span>12M 모멘텀: <b>{info.momentum_12m > 0 ? "+" : ""}{info.momentum_12m}%</b></span>}
                  {info.sma10 !== undefined && <span>SMA10: <b>${info.sma10.toLocaleString()}</b></span>}
                  {info.sma30 !== undefined && <span>SMA30: <b>${info.sma30.toLocaleString()}</b></span>}
                  {info.rsi !== undefined && <span>RSI: <b style={{ color: info.rsi < 30 ? "var(--accent-green)" : info.rsi > 70 ? "var(--accent-red)" : "var(--foreground)" }}>{info.rsi}</b></span>}
                  {info.reason && <span>{info.reason}</span>}
                  {info.error && <span style={{ color: "var(--accent-red)" }}>{info.error}</span>}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* 포지션 탭 */}
        {activeTab === "positions" && (
          <div>
            {positions.length === 0 ? (
              <div className="text-sm text-center py-8" style={{ color: "var(--muted)" }}>보유 포지션 없음</div>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr style={{ color: "var(--muted)", borderBottom: "1px solid var(--card-border)" }}>
                    {["종목","수량","평균가","현재가","평가손익","진입시각"].map((h) => (
                      <th key={h} className="text-left px-3 py-2">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {positions.map((p) => {
                    const pnlUp = (p.unrealized_pnl ?? 0) >= 0;
                    return (
                      <tr key={p.symbol} style={{ borderBottom: "1px solid var(--card-border)" }}>
                        <td className="px-3 py-2 font-bold">{p.symbol}</td>
                        <td className="px-3 py-2">{p.qty.toFixed(6)}</td>
                        <td className="px-3 py-2">${p.avg_price.toLocaleString()}</td>
                        <td className="px-3 py-2">${(p.current_price ?? p.avg_price).toLocaleString()}</td>
                        <td className="px-3 py-2 font-semibold" style={{ color: pnlUp ? "var(--accent-green)" : "var(--accent-red)" }}>
                          {pnlUp ? "+" : ""}{(p.unrealized_pnl ?? 0).toFixed(0)}
                          <span className="ml-1">({pnlUp ? "+" : ""}{(p.unrealized_pnl_pct ?? 0).toFixed(2)}%)</span>
                        </td>
                        <td className="px-3 py-2" style={{ color: "var(--muted)" }}>{fmtTime(p.entry_time)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* 매매내역 탭 */}
        {activeTab === "trades" && (
          <div>
            {trades.length === 0 ? (
              <div className="text-sm text-center py-8" style={{ color: "var(--muted)" }}>매매 내역 없음</div>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr style={{ color: "var(--muted)", borderBottom: "1px solid var(--card-border)" }}>
                    {["시각","종목","구분","체결가","수량","손익","비용","모드"].map((h) => (
                      <th key={h} className="text-left px-3 py-2">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {trades.map((t) => (
                    <tr key={t.id} style={{ borderBottom: "1px solid var(--card-border)" }}>
                      <td className="px-3 py-2" style={{ color: "var(--muted)" }}>{fmtTime(t.timestamp)}</td>
                      <td className="px-3 py-2 font-bold">{t.symbol}</td>
                      <td className="px-3 py-2 font-bold" style={{ color: t.side === "BUY" ? "var(--accent-green)" : "var(--accent-red)" }}>{t.side}</td>
                      <td className="px-3 py-2">${t.price.toLocaleString()}</td>
                      <td className="px-3 py-2">{t.qty.toFixed(6)}</td>
                      <td className="px-3 py-2 font-semibold" style={{ color: t.pnl >= 0 ? "var(--accent-green)" : "var(--accent-red)" }}>
                        {t.side === "SELL" ? `${t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(0)}` : "-"}
                      </td>
                      <td className="px-3 py-2" style={{ color: "var(--muted)" }}>{t.cost.toFixed(0)}</td>
                      <td className="px-3 py-2">
                        <span className="px-1.5 py-0.5 rounded text-xs" style={{ background: t.mode === "paper" ? "var(--accent-blue)22" : "var(--accent-red)22", color: t.mode === "paper" ? "var(--accent-blue)" : "var(--accent-red)" }}>
                          {t.mode}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
