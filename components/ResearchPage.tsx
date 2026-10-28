"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  Clock3,
  Database,
  FlaskConical,
  LockKeyhole,
  Play,
  Search,
  ShieldCheck,
  WifiOff,
} from "lucide-react";
import {
  getResearchRun,
  getResearchRuns,
  getResearchStatus,
  runResearch,
  searchResearchInstruments,
} from "@/lib/api";
import type {
  ResearchInstrument,
  ResearchRun,
  ResearchRunSummary,
  ResearchStatus,
} from "@/lib/api";

const STRATEGIES = [
  { value: "sma_cross", label: "SMA 10 / 30 cross" },
  { value: "dual_mom", label: "Dual momentum" },
  { value: "bollinger", label: "Bollinger 2σ" },
  { value: "rsi", label: "RSI(14) mean reversion" },
  { value: "ensemble", label: "Ensemble vote" },
  { value: "bah", label: "Buy & hold baseline" },
];

const ANSWER_LABELS: Record<string, string> = {
  evidence_sufficiency: "Evidence sufficiency",
  signal_alignment: "Signal alignment",
  market_regime_fit: "Market regime fit",
};

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}

function formatNumber(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(value);
}

function makeRequestKey(symbol: string): string {
  const suffix = typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}`;
  return `research-ui:${symbol}:${suffix}`;
}

function statusTone(status: string | undefined): string {
  if (status === "evaluated" || status === "ready") return "research-tone-good";
  if (status === "deferred" || status === "not_configured" || status === "configured_unverified") return "research-tone-warn";
  return "research-tone-muted";
}

function SignalMark({ signal }: { signal: string | null | undefined }) {
  const normalized = signal ?? "HOLD";
  const className = normalized === "BUY"
    ? "research-signal research-signal-buy"
    : normalized === "SELL"
      ? "research-signal research-signal-sell"
      : "research-signal research-signal-hold";
  return <span className={className}>{normalized}</span>;
}

function SourceBadge({ source }: { source: string | undefined }) {
  return (
    <span className="research-source-badge">
      <span className="research-source-dot" aria-hidden="true" />
      {source === "fixture" ? "FIXTURE / DEMO" : source === "yahoo_public" ? "YAHOO / PUBLIC" : "LIVE · UNVERIFIED"}
    </span>
  );
}

function HistoryRow({
  run,
  active,
  onSelect,
}: {
  run: ResearchRunSummary;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`research-history-row${active ? " research-history-row-active" : ""}`}
      onClick={onSelect}
      aria-label={`${run.symbol} ${formatTimestamp(run.created_at)} 연구 실행 열기`}
    >
      <span className="research-history-symbol">{run.symbol}</span>
      <span className="research-history-meta">
        <span>{run.exchange} · {run.strategy}</span>
        <span>{formatTimestamp(run.created_at)}</span>
      </span>
      <SignalMark signal={run.signal} />
      <ChevronRight size={15} aria-hidden="true" className="research-history-chevron" />
    </button>
  );
}

export default function ResearchPage() {
  const [status, setStatus] = useState<ResearchStatus | null>(null);
  const [statusError, setStatusError] = useState("");
  const [instruments, setInstruments] = useState<ResearchInstrument[]>([]);
  const [instrumentQuery, setInstrumentQuery] = useState("");
  const [symbol, setSymbol] = useState("005930");
  const [exchange, setExchange] = useState("KRX");
  const [strategy, setStrategy] = useState("sma_cross");
  const [source, setSource] = useState<"fixture" | "yahoo_public" | "tradingview">("fixture");
  const [decisionProvider, setDecisionProvider] = useState<"mock" | "jev">("mock");
  const [runs, setRuns] = useState<ResearchRunSummary[]>([]);
  const [selectedRun, setSelectedRun] = useState<ResearchRun | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const nextStatus = await getResearchStatus();
        if (active) setStatus(nextStatus);
      } catch {
        if (active) setStatusError("백엔드 연결 상태를 확인하지 못했습니다.");
      }
      try {
        const nextRuns = await getResearchRuns();
        if (active) setRuns(nextRuns);
      } catch {
        if (active) setStatusError((current) => current || "최근 연구 기록을 불러오지 못했습니다.");
      }
    };
    load();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    const loadInstruments = async () => {
      const instrumentSource = source === "tradingview" && !status?.tradingview.configured ? "fixture" : source;
      try {
        const nextInstruments = await searchResearchInstruments("", instrumentSource);
        if (active) setInstruments(nextInstruments);
      } catch {
        if (active) setStatusError((current) => current || "종목 목록을 불러오지 못했습니다.");
      }
    };
    loadInstruments();
    return () => { active = false; };
  }, [source, status?.tradingview.configured]);

  const filteredInstruments = useMemo(() => {
    const query = instrumentQuery.trim().toLowerCase();
    if (!query) return instruments;
    return instruments.filter((instrument) =>
      [instrument.symbol, instrument.exchange, instrument.name].some((value) =>
        value.toLowerCase().includes(query),
      ),
    );
  }, [instrumentQuery, instruments]);

  const selectInstrument = (instrument: ResearchInstrument) => {
    setSymbol(instrument.symbol);
    setExchange(instrument.exchange);
    setInstrumentQuery(instrument.symbol);
  };

  const refreshHistory = async () => {
    setLoadingHistory(true);
    try {
      setRuns(await getResearchRuns());
    } catch {
      setError("연구 이력을 새로 고치지 못했습니다.");
    } finally {
      setLoadingHistory(false);
    }
  };

  const handleRun = async () => {
    if (!symbol.trim() || !exchange.trim()) return;
    setLoading(true);
    setError("");
    try {
      const result = await runResearch({
        symbol: symbol.trim().toUpperCase(),
        exchange: exchange.trim().toUpperCase(),
        interval: "1D",
        source,
        strategy,
        decision_provider: decisionProvider,
        request_key: makeRequestKey(symbol.trim().toUpperCase()),
      });
      setSelectedRun(result);
      await refreshHistory();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "연구 실행에 실패했습니다.");
    } finally {
      setLoading(false);
    }
  };

  const openRun = async (runId: string) => {
    setError("");
    try {
      setSelectedRun(await getResearchRun(runId));
    } catch {
      setError("연구 상세 기록을 불러오지 못했습니다.");
    }
  };

  const signal = selectedRun?.state?.strategy_signal;
  const snapshot = selectedRun?.snapshot;
  const decision = selectedRun?.decision;
  const liveReady = status?.tradingview.configured === true;
  const jevReady = status?.jev.configured === true;

  return (
    <main className="research-page" aria-labelledby="research-title">
      <div className="research-page-inner">
        <header className="research-hero">
          <div>
            <div className="research-kicker"><FlaskConical size={13} aria-hidden="true" /> PORTFOLIOAI / RESEARCH LAB</div>
            <h1 id="research-title">Evidence before execution.</h1>
            <p>
              한 종목의 시점 스냅샷과 전략 신호를 묶어 JeV 판단을 검토합니다.
              이 화면은 shadow 모드이며 paper 실행에는 연결되지 않습니다.
            </p>
          </div>
          <div className="research-hero-status">
            <span className="research-mode-pill"><span aria-hidden="true" /> SHADOW MODE</span>
            <span className="research-hero-caption">LIVE ORDER PATH · CLOSED</span>
          </div>
        </header>

        {(statusError || error) && (
          <div className="research-alert research-alert-warn" role="alert">
            <AlertTriangle size={16} aria-hidden="true" />
            <span>{error || statusError}</span>
          </div>
        )}

        <div className="research-layout">
          <section className="research-panel research-control-panel" aria-labelledby="research-run-title">
            <div className="research-panel-heading">
              <div>
                <span className="research-section-index">01 / INPUT</span>
                <h2 id="research-run-title">Run a shadow review</h2>
              </div>
              <Activity size={18} aria-hidden="true" className="research-heading-icon" />
            </div>

            <div className="research-connection-strip" aria-label="연구 연결 상태">
              <div>
                <span>TradingView MCP</span>
                <strong className={statusTone(status?.tradingview.status)}>
                  {status?.tradingview.status === "configured_unverified" ? "configured · unverified" : status?.tradingview.status || "checking"}
                </strong>
              </div>
              <div>
                <span>Jev provider</span>
                <strong className={statusTone(status?.jev.status)}>
                  {status?.jev.status === "configured_unverified" ? "configured · unverified" : status?.jev.status || "checking"}
                </strong>
              </div>
              <div>
                <span>Public data</span>
                <strong className="research-tone-good">available</strong>
              </div>
              <div>
                <span>Fixture</span>
                <strong className="research-tone-good">available</strong>
              </div>
            </div>

            <div className="research-field">
              <label htmlFor="research-instrument-search">Instrument</label>
              <div className="research-input-wrap">
                <Search size={16} aria-hidden="true" />
                <input
                  id="research-instrument-search"
                  value={instrumentQuery || symbol}
                  onChange={(event) => setInstrumentQuery(event.target.value)}
                  placeholder="Search symbol or exchange"
                  autoComplete="off"
                />
              </div>
              <div className="research-instrument-list" aria-label="검색된 fixture 종목">
                {filteredInstruments.map((instrument) => (
                  <button
                    key={`${instrument.exchange}:${instrument.symbol}`}
                    type="button"
                    className={`research-instrument-option${symbol === instrument.symbol && exchange === instrument.exchange ? " selected" : ""}`}
                    onClick={() => selectInstrument(instrument)}
                  >
                    <span><strong>{instrument.symbol}</strong><small>{instrument.name}</small></span>
                    <span>{instrument.exchange}</span>
                  </button>
                ))}
                {!filteredInstruments.length && <span className="research-empty-inline">No fixture match. Use a listed symbol.</span>}
              </div>
            </div>

            <div className="research-field-grid">
              <div className="research-field">
                <label htmlFor="research-exchange">Exchange</label>
                <input id="research-exchange" value={exchange} onChange={(event) => setExchange(event.target.value.toUpperCase())} />
              </div>
              <div className="research-field">
                <label htmlFor="research-interval">Interval</label>
                <select id="research-interval" value="1D" disabled>
                  <option value="1D">1D · daily</option>
                </select>
              </div>
            </div>

            <div className="research-field">
              <label htmlFor="research-strategy">Strategy signal</label>
              <select id="research-strategy" value={strategy} onChange={(event) => setStrategy(event.target.value)}>
                {STRATEGIES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
              <span className="research-field-help">Existing backtest engine · read-only signal</span>
            </div>

            <div className="research-source-choice">
              <div className="research-source-choice-header">
                <div>
                  <span className="research-section-index">DATA SOURCE</span>
                  <strong>{source === "fixture" ? "Deterministic fixture" : source === "yahoo_public" ? "Yahoo Finance public" : "TradingView MCP"}</strong>
                </div>
                <SourceBadge source={source} />
              </div>
              <div className="research-source-buttons" role="group" aria-label="데이터 출처 선택">
                <button type="button" className={source === "fixture" ? "active" : ""} onClick={() => setSource("fixture")}>
                  <Database size={14} aria-hidden="true" /> Fixture
                </button>
                <button type="button" className={source === "yahoo_public" ? "active" : ""} onClick={() => setSource("yahoo_public")}>
                  <Activity size={14} aria-hidden="true" /> Yahoo public
                </button>
                <button
                  type="button"
                  className={source === "tradingview" ? "active" : ""}
                  onClick={() => setSource("tradingview")}
                  disabled={!liveReady}
                  title={liveReady ? "TradingView MCP 첫 read-only 검증" : "공식 OAuth access token 설정 후 사용 가능"}
                >
                  <Activity size={14} aria-hidden="true" /> TradingView
                </button>
              </div>
              <p className="research-source-note">
                {source === "fixture"
                  ? "DEMO ONLY · 현재 데이터나 실시간 시세를 의미하지 않습니다."
                  : source === "yahoo_public"
                    ? "PUBLIC DATA · Yahoo Finance/yfinance · TradingView MCP가 아닙니다."
                    : "실연결은 아직 검증되지 않았습니다. 인증 설정 후에만 활성화됩니다."}
              </p>
            </div>

            <div className="research-decision-choice">
              <div className="research-source-choice-header">
                <div>
                  <span className="research-section-index">DECISION PROVIDER</span>
                  <strong>{decisionProvider === "jev" ? "TypeSafe Jev" : "Mock Jev"}</strong>
                </div>
                <span className={`research-provider-status ${jevReady ? "research-tone-good" : "research-tone-muted"}`}>
                  {jevReady ? "configured" : "offline only"}
                </span>
              </div>
              <div className="research-source-buttons research-decision-buttons" role="group" aria-label="판단 provider 선택">
                <button type="button" className={decisionProvider === "mock" ? "active" : ""} onClick={() => setDecisionProvider("mock")}>
                  <FlaskConical size={14} aria-hidden="true" /> Mock Jev
                </button>
                <button
                  type="button"
                  className={decisionProvider === "jev" ? "active" : ""}
                  onClick={() => setDecisionProvider("jev")}
                  disabled={!jevReady}
                  title={jevReady ? "실제 Jev API 호출" : "backend에 TYPESAFE_API_KEY 필요"}
                >
                  <Activity size={14} aria-hidden="true" /> Jev live
                </button>
              </div>
              <p className="research-source-note">
                {decisionProvider === "jev"
                  ? "LIVE PROVIDER · confidence/usage를 실제 Jev 응답에서 기록합니다."
                  : "OFFLINE MOCK · 외부 모델 호출 없이 재현 가능한 demo 응답입니다."}
              </p>
            </div>

            <button type="button" className="research-run-button" onClick={handleRun} disabled={loading || !symbol.trim() || !exchange.trim() || (decisionProvider === "jev" && !jevReady)}>
              <Play size={16} fill="currentColor" aria-hidden="true" />
              {loading ? "Building snapshot…" : "Run analysis"}
            </button>
            <p className="research-action-note"><LockKeyhole size={13} aria-hidden="true" /> 결과는 shadow 기록으로만 저장되며 주문 경로를 바꾸지 않습니다.</p>
          </section>

          <section className="research-panel research-result-panel" aria-labelledby="research-result-title">
            <div className="research-panel-heading">
              <div>
                <span className="research-section-index">02 / OUTPUT</span>
                <h2 id="research-result-title">Decision record</h2>
              </div>
              {selectedRun && <SourceBadge source={selectedRun.source} />}
            </div>

            {!selectedRun && (
              <div className="research-empty-state">
                <div className="research-empty-mark"><CircleDashed size={30} aria-hidden="true" /></div>
                <strong>Awaiting an analysis</strong>
                <p>Select an instrument, then run the fixture review to create the first immutable record.</p>
                <span>INPUT → SNAPSHOT → SIGNAL → JEv CHECKS</span>
              </div>
            )}

            {selectedRun && (
              <div className="research-result-content">
                <div className="research-result-headline">
                  <div>
                    <span className="research-result-symbol">{selectedRun.symbol} <small>{selectedRun.exchange} / {selectedRun.interval}</small></span>
                    <span className="research-result-time"><Clock3 size={13} aria-hidden="true" /> captured {formatTimestamp(selectedRun.created_at)}</span>
                  </div>
                  <span className={`research-status-label ${statusTone(selectedRun.status)}`}>
                    {selectedRun.status === "evaluated" ? <CheckCircle2 size={14} aria-hidden="true" /> : <AlertTriangle size={14} aria-hidden="true" />}
                    {selectedRun.status.toUpperCase()}
                  </span>
                </div>

                {selectedRun.error && (
                  <div className="research-alert research-alert-warn">
                    <WifiOff size={15} aria-hidden="true" />
                    <span><strong>{selectedRun.error.code}</strong> · {selectedRun.error.message}</span>
                  </div>
                )}

                {snapshot && (
                  <>
                    <div className="research-metrics">
                      <div><span>Last close</span><strong>{formatNumber(snapshot.ohlcv.close)}</strong><small>{snapshot.currency}</small></div>
                      <div><span>20D return</span><strong className={(snapshot.indicators.return_20d_pct ?? 0) >= 0 ? "research-positive" : "research-negative"}>{formatNumber(snapshot.indicators.return_20d_pct)}%</strong><small>snapshot indicator</small></div>
                      <div><span>RSI(14)</span><strong>{formatNumber(snapshot.indicators.rsi_14)}</strong><small>distribution input</small></div>
                    </div>

                    <div className="research-signal-card">
                      <div>
                        <span className="research-section-index">STRATEGY EVENT</span>
                        <strong>{signal?.strategy_label || selectedRun.strategy}</strong>
                        <small>{signal?.signal_basis || "—"} · {signal?.bars_used || 0} bars</small>
                      </div>
                      <SignalMark signal={signal?.signal} />
                    </div>

                    {decision && (
                      <div className="research-checks">
                        <div className="research-checks-heading">
                          <span className="research-section-index">JEv CHECKS · {decision.question_version}</span>
                          <span className="research-confidence">mean confidence <strong>{Math.round(decision.confidence * 100)}%</strong></span>
                        </div>
                        {decision.answers.map((answer) => (
                          <div className="research-check-row" key={answer.question_id}>
                            <div className="research-check-copy">
                              <span>{ANSWER_LABELS[answer.question_id] || answer.question_id}</span>
                              <strong>{answer.answer.replaceAll("_", " ")}</strong>
                              <small>{answer.reason_code.replaceAll("_", " ")}</small>
                            </div>
                            <div className="research-confidence-bar" aria-label={`${Math.round(answer.confidence * 100)} percent confidence`}>
                              <span style={{ width: `${Math.round(answer.confidence * 100)}%` }} />
                            </div>
                            <strong className="research-confidence-value">{Math.round(answer.confidence * 100)}%</strong>
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="research-audit-line">
                      <span>Observed {formatTimestamp(snapshot.observed_at)}</span>
                      <span>Fetched {formatTimestamp(snapshot.fetched_at)}</span>
                      <span>{snapshot.bar_closed ? "Closed bar" : "Open bar"}</span>
                    </div>
                  </>
                )}

                <div className="research-record-footer">
                  <span><ShieldCheck size={13} aria-hidden="true" /> PAPER ONLY · LIVE DISABLED</span>
                  <span>hash {selectedRun.input_hash.slice(0, 12)}… · {selectedRun.latency_ms}ms</span>
                </div>
              </div>
            )}
          </section>
        </div>

        <section className="research-panel research-history-panel" aria-labelledby="research-history-title">
          <div className="research-panel-heading research-history-heading">
            <div>
              <span className="research-section-index">03 / AUDIT TRAIL</span>
              <h2 id="research-history-title">Recent runs</h2>
            </div>
            <button type="button" className="research-refresh-button" onClick={refreshHistory} disabled={loadingHistory}>
              <Clock3 size={14} aria-hidden="true" /> {loadingHistory ? "Refreshing…" : "Refresh"}
            </button>
          </div>
          {runs.length ? (
            <div className="research-history-list">
              {runs.map((run) => <HistoryRow key={run.run_id} run={run} active={run.run_id === selectedRun?.run_id} onSelect={() => openRun(run.run_id)} />)}
            </div>
          ) : (
            <div className="research-history-empty"><Database size={16} aria-hidden="true" /> No saved research records yet.</div>
          )}
        </section>
      </div>
    </main>
  );
}
