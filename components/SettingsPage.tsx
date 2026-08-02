"use client";
import { useState } from "react";
import { KeyRound, LockKeyhole, ShieldCheck } from "lucide-react";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

type WalletType = "phantom" | "metamask";

interface WalletResult {
  type: WalletType;
  data: Record<string, unknown> | null;
  error: string;
  loading: boolean;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="p-4 rounded-lg flex flex-col gap-3" style={{ background: "var(--card)", border: "1px solid var(--card-border)" }}>
      <div className="text-sm font-bold">{title}</div>
      {children}
    </div>
  );
}

function Field({ label, note, children }: { label: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-semibold" style={{ color: "var(--muted)" }}>{label}</label>
      {children}
      {note && <div className="text-xs" style={{ color: "#8b949e66" }}>{note}</div>}
    </div>
  );
}

function Input({ value, onChange, placeholder, type = "text" }: {
  value: string; onChange: (v: string) => void; placeholder?: string; type?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="px-3 py-2 rounded text-sm outline-none w-full"
      style={{ background: "#0d1117", border: "1px solid var(--card-border)", color: "var(--foreground)" }}
    />
  );
}

function Btn({ onClick, loading, children, variant = "blue" }: {
  onClick: () => void; loading?: boolean; children: React.ReactNode; variant?: "blue" | "gray";
}) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className="px-4 py-2 rounded text-xs font-semibold"
      style={{
        background: loading ? "#30363d" : variant === "blue" ? "var(--accent-blue)" : "var(--card)",
        color: variant === "blue" ? "#fff" : "var(--muted)",
        border: variant === "gray" ? "1px solid var(--card-border)" : "none",
      }}
    >
      {loading ? "확인 중…" : children}
    </button>
  );
}

function ResultBox({ wallet }: { wallet: WalletResult }) {
  if (wallet.loading) return (
    <div className="text-xs p-2 rounded" style={{ background: "#0d1117", color: "var(--muted)" }}>연결 중…</div>
  );
  if (wallet.error) return (
    <div className="text-xs p-2 rounded" style={{ background: "#f8514922", color: "var(--accent-red)", border: "1px solid var(--accent-red)44" }}>
      {wallet.error}
    </div>
  );
  if (!wallet.data) return null;

  if (wallet.type === "phantom") {
    const d = wallet.data as { sol: number; tokens: { symbol: string; balance: number }[] };
    return (
      <div className="text-xs p-3 rounded flex flex-col gap-2" style={{ background: "#0d1117", border: "1px solid var(--card-border)" }}>
        <div className="flex justify-between">
          <span style={{ color: "var(--muted)" }}>SOL</span>
          <span className="font-semibold">{d.sol.toFixed(4)}</span>
        </div>
        {d.tokens.slice(0, 5).map((t) => (
          <div key={t.symbol} className="flex justify-between">
            <span style={{ color: "var(--muted)" }}>{t.symbol}</span>
            <span className="font-semibold">{t.balance.toLocaleString()}</span>
          </div>
        ))}
      </div>
    );
  }

  if (wallet.type === "metamask") {
    const d = wallet.data as { eth: number; tokens: { symbol: string; balance: number }[] };
    return (
      <div className="text-xs p-3 rounded flex flex-col gap-2" style={{ background: "#0d1117", border: "1px solid var(--card-border)" }}>
        <div className="flex justify-between">
          <span style={{ color: "var(--muted)" }}>ETH</span>
          <span className="font-semibold">{d.eth.toFixed(6)}</span>
        </div>
        {d.tokens?.slice(0, 5).map((t) => (
          <div key={t.symbol} className="flex justify-between">
            <span style={{ color: "var(--muted)" }}>{t.symbol}</span>
            <span className="font-semibold">{t.balance.toLocaleString()}</span>
          </div>
        ))}
      </div>
    );
  }

  return null;
}

const INIT_WALLET: WalletResult = { type: "phantom", data: null, error: "", loading: false };

export default function SettingsPage() {
  // 팬텀
  const [phantomAddr, setPhantomAddr] = useState("");
  const [phantomResult, setPhantomResult] = useState<WalletResult>({ ...INIT_WALLET, type: "phantom" });

  // 메타마스크
  const [mmAddr, setMmAddr] = useState("");
  const [mmResult, setMmResult] = useState<WalletResult>({ ...INIT_WALLET, type: "metamask" });

  async function connectPhantom() {
    if (!phantomAddr.trim()) return;
    setPhantomResult((p) => ({ ...p, loading: true, error: "", data: null }));
    try {
      const res = await fetch(`${API_BASE}/api/wallet/phantom/${phantomAddr.trim()}`);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setPhantomResult({ type: "phantom", data, error: "", loading: false });
      localStorage.setItem("phantom_address", phantomAddr.trim());
    } catch (e: unknown) {
      setPhantomResult({ type: "phantom", data: null, error: e instanceof Error ? e.message : "연결 실패", loading: false });
    }
  }

  async function connectMetaMask() {
    if (!mmAddr.trim()) return;
    setMmResult((p) => ({ ...p, loading: true, error: "", data: null }));
    try {
      const res = await fetch(`${API_BASE}/api/wallet/metamask/${mmAddr.trim()}`);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setMmResult({ type: "metamask", data, error: "", loading: false });
      localStorage.setItem("metamask_address", mmAddr.trim());
    } catch (e: unknown) {
      setMmResult({ type: "metamask", data: null, error: e instanceof Error ? e.message : "연결 실패", loading: false });
    }
  }

  return (
    <div className="flex flex-col h-full p-4 gap-4 overflow-y-auto">
      <div className="text-sm font-bold flex items-center gap-2"><KeyRound size={16} aria-hidden="true" /> 설정</div>

      <div className="p-4 rounded-lg flex gap-3" role="status" style={{ background: "#58a6ff12", border: "1px solid #58a6ff55" }}>
        <ShieldCheck size={20} className="shrink-0" aria-hidden="true" style={{ color: "var(--accent-blue)" }} />
        <div>
          <div className="text-sm font-bold" style={{ color: "var(--accent-blue)" }}>Paper-only 자격 증명 경계</div>
          <div className="text-xs mt-1 leading-relaxed" style={{ color: "var(--muted)" }}>
            KIS·Upbit·Binance 계좌 인증과 주문용 API 키 입력은 UI와 서버 모두에서 차단됩니다. 이 화면에는 공개 지갑 주소만 입력하세요.
          </div>
        </div>
      </div>

      {/* 팬텀 */}
      <Section title="👻 Phantom (Solana)">
        <Field label="지갑 주소" note="공개 주소만 입력 — 시드/개인키 절대 입력 금지">
          <Input value={phantomAddr} onChange={setPhantomAddr} placeholder="예) 9WzDXwBbmkg8ZTbNMqUxvQRA…" />
        </Field>
        <div className="flex gap-2 items-center">
          <Btn onClick={connectPhantom} loading={phantomResult.loading}>연결 확인</Btn>
          {phantomResult.data && <span className="text-xs" style={{ color: "var(--accent-green)" }}>✓ 연결됨</span>}
        </div>
        <ResultBox wallet={phantomResult} />
      </Section>

      {/* 메타마스크 */}
      <Section title="🦊 MetaMask (Ethereum)">
        <Field label="지갑 주소 (0x…)" note="공개 주소만 입력 — 개인키 입력 금지">
          <Input value={mmAddr} onChange={setMmAddr} placeholder="예) 0xd8dA6BF26964aF9D7eEd9e03E5…" />
        </Field>
        <div className="flex gap-2 items-center">
          <Btn onClick={connectMetaMask} loading={mmResult.loading}>연결 확인</Btn>
          {mmResult.data && <span className="text-xs" style={{ color: "var(--accent-green)" }}>✓ 연결됨</span>}
        </div>
        <ResultBox wallet={mmResult} />
      </Section>

      <Section title="거래소·증권사 연결">
        <div className="flex gap-3 text-xs leading-relaxed" style={{ color: "var(--muted)" }}>
          <LockKeyhole size={18} className="shrink-0" aria-hidden="true" style={{ color: "var(--accent-yellow)" }} />
          <div>
            <div className="font-semibold" style={{ color: "var(--foreground)" }}>KIS · Upbit · Binance — 인증 연결 차단</div>
            <div className="mt-1">실거래 전환, 계좌 잔고 조회, API 자격 증명 저장 기능은 현재 제품 경계 밖입니다.</div>
          </div>
        </div>
      </Section>

      {/* 앱 정보 */}
      <div className="p-3 rounded text-xs flex flex-col gap-1" style={{ background: "var(--card)", border: "1px solid var(--card-border)", color: "var(--muted)" }}>
        <div>PortfolioAI Beta · 데이터 출처: Yahoo Finance, CoinGecko, Etherscan, Solana RPC</div>
        <div>투자 권유·수익 보장 아님 — 시뮬레이션과 참고용 분석 서비스입니다.</div>
      </div>
    </div>
  );
}
