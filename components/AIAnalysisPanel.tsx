"use client";
import { useState, useRef, useCallback } from "react";
import { useBalance } from "@/hooks/usePortfolio";
import { streamPortfolioAnalysis, getAIStrategies, streamChat } from "@/lib/aiApi";
import type { Strategy } from "@/lib/aiApi";
import { aiInsights } from "@/lib/mockData";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

type Tab = "analysis" | "strategy" | "chat" | "news";
type RiskAppetite = "aggressive" | "balanced" | "conservative";

const TAG_COLOR: Record<string, string> = {
  High: "var(--accent-yellow)",
  Mid:  "var(--accent-blue)",
  Low:  "var(--accent-green)",
};

const RISK_PRESETS: { label: string; value: RiskAppetite }[] = [
  { label: "공격형", value: "aggressive" },
  { label: "균형형", value: "balanced"   },
  { label: "안정형", value: "conservative" },
];

const QUICK_QUESTIONS = [
  "이 포트폴리오의 가장 큰 리스크는 뭔가요?",
  "지금 어떤 종목을 더 사야 할까요?",
  "시장 하락 시 방어 전략은?",
];

export default function AIAnalysisPanel() {
  const { data: balance } = useBalance();
  const [tab, setTab]   = useState<Tab>("analysis");

  // ── 분석 탭 ──
  const [analysisText, setAnalysisText] = useState("");
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError]     = useState("");
  const [riskScore, setRiskScore] = useState<number | null>(null);

  // ── 전략 탭 ──
  const [strategies, setStrategies]       = useState<Strategy[]>([]);
  const [strategyLoading, setStrategyLoading] = useState(false);
  const [strategyError, setStrategyError]     = useState("");
  const [riskAppetite, setRiskAppetite]   = useState<RiskAppetite>("balanced");
  const [selectedStrategy, setSelectedStrategy] = useState(0);

  // ── 뉴스 탭 ──
  const [newsTicker, setNewsTicker] = useState("BTC");
  const [newsData,   setNewsData]   = useState<Record<string, unknown> | null>(null);
  const [newsLoading, setNewsLoading] = useState(false);

  async function fetchNews(ticker: string) {
    setNewsLoading(true);
    try {
      const r = await fetch(`${API}/api/news/${ticker}`);
      setNewsData(await r.json());
    } catch {}
    finally { setNewsLoading(false); }
  }

  // ── 채팅 탭 ──
  const [chatInput, setChatInput]   = useState("");
  const [chatHistory, setChatHistory] = useState<{ role: "user" | "ai"; text: string }[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // ── 포트폴리오 분석 실행 ──────────────────────

  const runAnalysis = useCallback(async () => {
    if (!balance || analysisLoading) return;
    setAnalysisLoading(true);
    setAnalysisText("");
    setAnalysisError("");
    setRiskScore(null);

    try {
      let full = "";
      await streamPortfolioAnalysis(
        {
          holdings: balance.holdings.map((h) => ({
            ticker:     h.ticker,
            name:       h.name,
            value:      h.value,
            return_pct: h.return_pct,
            qty:        h.qty,
          })),
          total_value: balance.total_value,
          pnl_pct:     balance.pnl_pct,
        },
        (chunk) => {
          full += chunk;
          setAnalysisText(full);
          // 첫 줄에서 리스크 점수 추출
          const match = full.match(/\[리스크 점수\]\s*(\d+)/);
          if (match) setRiskScore(parseInt(match[1]));
        },
        () => setAnalysisLoading(false),
      );
    } catch (e: any) {
      setAnalysisError(e.message ?? "분석 실패");
      setAnalysisLoading(false);
    }
  }, [balance, analysisLoading]);

  // ── 전략 추천 실행 ────────────────────────────

  const runStrategy = useCallback(async () => {
    if (!balance || strategyLoading) return;
    setStrategyLoading(true);
    setStrategyError("");
    try {
      const result = await getAIStrategies(
        balance.holdings.map((h) => ({ ticker: h.ticker, name: h.name, value: h.value })),
        balance.total_value,
        riskAppetite,
      );
      setStrategies(result);
      setSelectedStrategy(0);
    } catch (e: any) {
      setStrategyError(e.message ?? "전략 조회 실패");
    } finally {
      setStrategyLoading(false);
    }
  }, [balance, riskAppetite, strategyLoading]);

  // ── 채팅 전송 ─────────────────────────────────

  const sendChat = useCallback(async (question?: string) => {
    const q = (question ?? chatInput).trim();
    if (!q || chatLoading) return;
    setChatInput("");
    setChatLoading(true);
    setChatHistory((h) => [...h, { role: "user", text: q }]);

    let aiText = "";
    setChatHistory((h) => [...h, { role: "ai", text: "" }]);

    try {
      await streamChat(
        q,
        balance
          ? { holdings: balance.holdings, total_value: balance.total_value }
          : null,
        (chunk) => {
          aiText += chunk;
          setChatHistory((h) => {
            const next = [...h];
            next[next.length - 1] = { role: "ai", text: aiText };
            return next;
          });
        },
        () => {
          setChatLoading(false);
          setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
        },
      );
    } catch (e: any) {
      setChatHistory((h) => {
        const next = [...h];
        next[next.length - 1] = { role: "ai", text: `오류: ${e.message}` };
        return next;
      });
      setChatLoading(false);
    }
  }, [chatInput, chatLoading, balance]);

  // ── 리스크 표시용 ─────────────────────────────

  const score = riskScore ?? aiInsights.riskScore;
  const riskColor = score < 30 ? "var(--accent-green)" : score < 60 ? "var(--accent-yellow)" : "var(--accent-red)";
  const riskLabel = score < 30 ? "낮음" : score < 60 ? "보통" : "높음";

  return (
    <div style={{ background: "var(--card)", border: "1px solid var(--card-border)", borderRadius: 8 }} className="p-4 flex flex-col gap-3 h-full overflow-y-auto">

      {/* 탭 헤더 */}
      <div className="flex gap-1 flex-wrap">
        {([["analysis","분석"], ["strategy","전략"], ["news","뉴스"], ["chat","채팅"]] as [Tab, string][]).map(([t, label]) => (
          <button key={t} onClick={() => setTab(t)}
            className="flex-1 text-xs py-1 rounded transition-all"
            style={{ background: tab === t ? "var(--accent-blue)" : "transparent", color: tab === t ? "#fff" : "var(--muted)", border: "1px solid var(--card-border)" }}>
            {label}
          </button>
        ))}
      </div>

      {/* ── 분석 탭 ── */}
      {tab === "analysis" && (
        <div className="flex flex-col gap-3">
          {/* 리스크 점수 */}
          <div style={{ background: "#0d1117", borderRadius: 6, padding: "10px 12px" }}>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs" style={{ color: "var(--muted)" }}>리스크 점수</span>
              <span className="text-xs px-2 py-0.5 rounded font-semibold"
                style={{ background: riskColor + "22", color: riskColor }}>{riskLabel}</span>
            </div>
            <div className="flex items-end gap-2">
              <span className="text-3xl font-bold" style={{ color: riskColor }}>{score}</span>
              <span className="text-xs mb-1" style={{ color: "var(--muted)" }}>/ 100</span>
            </div>
            <div className="w-full h-1.5 rounded-full mt-2" style={{ background: "#21262d" }}>
              <div className="h-full rounded-full transition-all duration-500"
                style={{ width: `${score}%`, background: riskColor }}></div>
            </div>
          </div>

          {/* 분석 결과 */}
          <div style={{ background: "#0d1117", borderRadius: 6, padding: "10px 12px", minHeight: 80 }}>
            {analysisText ? (
              <p className="text-xs leading-relaxed whitespace-pre-wrap">{analysisText}</p>
            ) : (
              <p className="text-xs" style={{ color: "var(--muted)" }}>
                {analysisLoading ? "분석 중..." : "아래 버튼을 눌러 AI 분석을 시작하세요."}
              </p>
            )}
            {analysisError && (
              <p className="text-xs mt-1" style={{ color: "var(--accent-red)" }}>{analysisError}</p>
            )}
          </div>

          <button onClick={runAnalysis} disabled={analysisLoading || !balance}
            className="text-xs py-2 rounded font-semibold transition-all"
            style={{
              background: analysisLoading ? "#21262d" : "var(--accent-blue)",
              color: "#fff",
              opacity: (!balance || analysisLoading) ? 0.5 : 1,
              cursor: (!balance || analysisLoading) ? "not-allowed" : "pointer",
            }}>
            {analysisLoading ? "⏳ 분석 중..." : "🤖 AI 포트폴리오 분석"}
          </button>
        </div>
      )}

      {/* ── 전략 탭 ── */}
      {tab === "strategy" && (
        <div className="flex flex-col gap-3">
          {/* 성향 선택 */}
          <div className="flex gap-1">
            {RISK_PRESETS.map((r) => (
              <button key={r.value} onClick={() => setRiskAppetite(r.value)}
                className="flex-1 text-xs py-1 rounded"
                style={{ background: riskAppetite === r.value ? "#30363d" : "transparent", color: riskAppetite === r.value ? "var(--foreground)" : "var(--muted)", border: "1px solid var(--card-border)" }}>
                {r.label}
              </button>
            ))}
          </div>

          <button onClick={runStrategy} disabled={strategyLoading || !balance}
            className="text-xs py-2 rounded font-semibold"
            style={{ background: "var(--accent-blue)", color: "#fff", opacity: strategyLoading ? 0.6 : 1, cursor: strategyLoading ? "not-allowed" : "pointer" }}>
            {strategyLoading ? "⏳ 전략 생성 중..." : "✨ AI 전략 추천 받기"}
          </button>

          {strategyError && (
            <p className="text-xs" style={{ color: "var(--accent-red)" }}>{strategyError}</p>
          )}

          {strategies.length > 0 && (
            <>
              {/* 전략 탭 버튼 */}
              <div className="flex gap-1">
                {strategies.map((s, i) => (
                  <button key={i} onClick={() => setSelectedStrategy(i)}
                    className="flex-1 text-xs py-1 rounded"
                    style={{ background: selectedStrategy === i ? TAG_COLOR[s.tag] + "22" : "transparent", border: `1px solid ${selectedStrategy === i ? TAG_COLOR[s.tag] : "var(--card-border)"}`, color: selectedStrategy === i ? TAG_COLOR[s.tag] : "var(--muted)" }}>
                    {s.name}
                  </button>
                ))}
              </div>

              {/* 선택된 전략 상세 */}
              {(() => {
                const s = strategies[selectedStrategy];
                if (!s) return null;
                const color = TAG_COLOR[s.tag];
                return (
                  <div style={{ background: "#0d1117", borderRadius: 6, padding: "10px 12px" }} className="flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold">{s.name}</span>
                      <div className="flex gap-2 text-xs">
                        <span style={{ color: "var(--muted)" }}>예상 수익</span>
                        <span style={{ color }}>{s.expected_return}</span>
                        <span style={{ color: "var(--muted)" }}>리스크</span>
                        <span style={{ color }}>{s.risk_level}</span>
                      </div>
                    </div>
                    <p className="text-xs" style={{ color: "var(--muted)" }}>{s.description}</p>
                    <div className="flex flex-col gap-1 mt-1">
                      {s.allocations.map((a, i) => (
                        <div key={i} className="flex items-center gap-2">
                          <span className="text-xs font-mono w-14">{a.ticker}</span>
                          <div className="flex-1 h-1.5 rounded-full" style={{ background: "#21262d" }}>
                            <div className="h-full rounded-full" style={{ width: `${a.pct}%`, background: color }}></div>
                          </div>
                          <span className="text-xs w-8 text-right" style={{ color }}>{a.pct}%</span>
                          <span className="text-xs" style={{ color: "var(--muted)" }}>{a.reason}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}
            </>
          )}

          {/* 전략 없을 때 mock 미리보기 */}
          {strategies.length === 0 && !strategyLoading && (
            <div className="text-xs text-center py-4" style={{ color: "var(--muted)" }}>
              성향을 선택하고 AI 전략 추천을 받아보세요
            </div>
          )}
        </div>
      )}

      {/* ── 뉴스 탭 ── */}
      {tab === "news" && (
        <div className="flex flex-col gap-3">
          <div className="flex gap-2">
            <input value={newsTicker} onChange={(e) => setNewsTicker(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === "Enter" && fetchNews(newsTicker)}
              placeholder="BTC, ETH, SOL …"
              className="flex-1 px-3 py-1.5 rounded text-xs outline-none"
              style={{ background: "#0d1117", border: "1px solid var(--card-border)", color: "var(--foreground)" }} />
            <button onClick={() => fetchNews(newsTicker)} disabled={newsLoading}
              className="px-3 py-1.5 rounded text-xs font-semibold"
              style={{ background: "var(--accent-blue)", color: "#fff", opacity: newsLoading ? 0.6 : 1 }}>
              {newsLoading ? "…" : "분석"}
            </button>
          </div>
          {newsData && (() => {
            const d = newsData as { label: string; score: number; summary: string; signals: string[]; news: {title:string;url:string;source:string}[]; news_count: number };
            const labelColor = d.label === "bullish" ? "var(--accent-green)" : d.label === "bearish" ? "var(--accent-red)" : "var(--accent-yellow)";
            const labelText  = d.label === "bullish" ? "📈 긍정" : d.label === "bearish" ? "📉 부정" : "😐 중립";
            return (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2 p-2 rounded" style={{ background: "#0d1117" }}>
                  <span className="text-sm font-bold" style={{ color: labelColor }}>{labelText}</span>
                  <div className="flex-1 h-2 rounded-full" style={{ background: "var(--card-border)" }}>
                    <div className="h-full rounded-full" style={{ width: `${(d.score + 1) / 2 * 100}%`, background: labelColor }} />
                  </div>
                  <span className="text-xs font-bold" style={{ color: labelColor }}>{d.score > 0 ? "+" : ""}{d.score.toFixed(2)}</span>
                </div>
                <div className="text-xs p-2 rounded" style={{ background: "#0d1117", color: "var(--foreground)", lineHeight: 1.6 }}>{d.summary}</div>
                {d.signals?.length > 0 && (
                  <div className="flex gap-1 flex-wrap">
                    {d.signals.map((s, i) => (
                      <span key={i} className="px-2 py-0.5 rounded text-xs" style={{ background: "var(--accent-blue)22", color: "var(--accent-blue)" }}>{s}</span>
                    ))}
                  </div>
                )}
                {d.news?.length > 0 && (
                  <div className="flex flex-col gap-1">
                    <div className="text-xs font-semibold" style={{ color: "var(--muted)" }}>최근 뉴스 ({d.news_count}건)</div>
                    {d.news.slice(0, 4).map((n, i) => (
                      <a key={i} href={n.url} target="_blank" rel="noopener noreferrer"
                        className="text-xs p-2 rounded block hover:opacity-80"
                        style={{ background: "#0d1117", color: "var(--foreground)", lineHeight: 1.5 }}>
                        <div>{n.title}</div>
                        <div className="mt-0.5" style={{ color: "var(--muted)" }}>{n.source}</div>
                      </a>
                    ))}
                  </div>
                )}
                {d.news_count === 0 && (
                  <div className="text-xs text-center py-3" style={{ color: "var(--muted)" }}>
                    뉴스 없음 — CryptoPanic 토큰 설정 시 더 많은 뉴스 조회 가능
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      )}

      {/* ── 채팅 탭 ── */}
      {tab === "chat" && (
        <div className="flex flex-col gap-2" style={{ height: "calc(100% - 60px)" }}>
          {/* 빠른 질문 */}
          {chatHistory.length === 0 && (
            <div className="flex flex-col gap-1">
              <p className="text-xs" style={{ color: "var(--muted)" }}>빠른 질문</p>
              {QUICK_QUESTIONS.map((q) => (
                <button key={q} onClick={() => sendChat(q)}
                  className="text-xs px-2 py-1.5 rounded text-left"
                  style={{ background: "#0d1117", border: "1px solid var(--card-border)", color: "var(--foreground)" }}>
                  {q}
                </button>
              ))}
            </div>
          )}

          {/* 채팅 히스토리 */}
          <div className="flex-1 flex flex-col gap-2 overflow-y-auto" style={{ maxHeight: 300 }}>
            {chatHistory.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                <div className="text-xs px-3 py-2 rounded-lg max-w-[85%] whitespace-pre-wrap"
                  style={{
                    background: msg.role === "user" ? "var(--accent-blue)33" : "#0d1117",
                    border: `1px solid ${msg.role === "user" ? "var(--accent-blue)55" : "var(--card-border)"}`,
                    color: "var(--foreground)",
                  }}>
                  {msg.text || (chatLoading && i === chatHistory.length - 1 ? "▌" : "")}
                </div>
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>

          {/* 입력 */}
          <div className="flex gap-2 mt-auto">
            <input
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); } }}
              placeholder="포트폴리오에 대해 물어보세요..."
              className="flex-1 text-xs px-3 py-2 rounded"
              style={{ background: "#0d1117", border: "1px solid var(--card-border)", color: "var(--foreground)", outline: "none" }}
            />
            <button onClick={() => sendChat()} disabled={!chatInput.trim() || chatLoading}
              className="text-xs px-3 py-2 rounded font-semibold"
              style={{ background: "var(--accent-blue)", color: "#fff", opacity: (!chatInput.trim() || chatLoading) ? 0.5 : 1 }}>
              전송
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
