"use client";
import { useState } from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

type WalletType = "phantom" | "metamask" | "binance";

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

  if (wallet.type === "binance") {
    const d = wallet.data as { balances: { asset: string; free: number; locked: number; total: number }[] };
    return (
      <div className="text-xs p-3 rounded flex flex-col gap-2" style={{ background: "#0d1117", border: "1px solid var(--card-border)" }}>
        {d.balances.slice(0, 8).map((b) => (
          <div key={b.asset} className="flex justify-between">
            <span style={{ color: "var(--muted)" }}>{b.asset}</span>
            <span className="font-semibold">{b.total.toLocaleString()}</span>
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

  // 바이낸스
  const [bnKey,    setBnKey]    = useState("");
  const [bnSecret, setBnSecret] = useState("");
  const [bnResult, setBnResult] = useState<WalletResult>({ ...INIT_WALLET, type: "binance" });

  // KIS
  const [kisKey,    setKisKey]    = useState("");
  const [kisSecret, setKisSecret] = useState("");
  const [kisAccount, setKisAccount] = useState("");
  const [kisSaved,  setKisSaved]  = useState(false);

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

  async function connectBinance() {
    if (!bnKey.trim() || !bnSecret.trim()) return;
    setBnResult((p) => ({ ...p, loading: true, error: "", data: null }));
    try {
      const res = await fetch(`${API_BASE}/api/wallet/binance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: bnKey.trim(), api_secret: bnSecret.trim() }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setBnResult({ type: "binance", data, error: "", loading: false });
    } catch (e: unknown) {
      setBnResult({ type: "binance", data: null, error: e instanceof Error ? e.message : "연결 실패", loading: false });
    }
  }

  function saveKis() {
    localStorage.setItem("kis_app_key",    kisKey);
    localStorage.setItem("kis_app_secret", kisSecret);
    localStorage.setItem("kis_account",    kisAccount);
    setKisSaved(true);
    setTimeout(() => setKisSaved(false), 2000);
  }

  return (
    <div className="flex flex-col h-full p-4 gap-4 overflow-y-auto">
      <div className="text-sm font-bold">⚙️ 설정</div>

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

      {/* 바이낸스 */}
      <Section title="🟡 Binance">
        <Field label="API Key" note="바이낸스 앱 → 프로필 → API 관리 → Read Only 권한만">
          <Input value={bnKey} onChange={setBnKey} placeholder="API Key" />
        </Field>
        <Field label="API Secret">
          <Input value={bnSecret} onChange={setBnSecret} placeholder="API Secret" type="password" />
        </Field>
        <div className="flex gap-2 items-center">
          <Btn onClick={connectBinance} loading={bnResult.loading}>연결 확인</Btn>
          {bnResult.data && <span className="text-xs" style={{ color: "var(--accent-green)" }}>✓ 연결됨</span>}
        </div>
        <ResultBox wallet={bnResult} />
      </Section>

      {/* KIS */}
      <Section title="🇰🇷 한국투자증권 KIS (선택)">
        <Field label="App Key">
          <Input value={kisKey} onChange={setKisKey} placeholder="KIS_APP_KEY" />
        </Field>
        <Field label="App Secret">
          <Input value={kisSecret} onChange={setKisSecret} placeholder="KIS_APP_SECRET" type="password" />
        </Field>
        <Field label="계좌번호" note="모의투자 계좌번호 8자리">
          <Input value={kisAccount} onChange={setKisAccount} placeholder="12345678" />
        </Field>
        <div className="flex gap-2 items-center">
          <Btn onClick={saveKis}>저장</Btn>
          {kisSaved && <span className="text-xs" style={{ color: "var(--accent-green)" }}>✓ 저장됨</span>}
        </div>
      </Section>

      {/* 앱 정보 */}
      <div className="p-3 rounded text-xs flex flex-col gap-1" style={{ background: "var(--card)", border: "1px solid var(--card-border)", color: "var(--muted)" }}>
        <div>PortfolioAI Beta · 데이터 출처: Yahoo Finance, CoinGecko, Etherscan, Solana RPC</div>
        <div>⚠️ 투자 권유 아님 — 참고용 분석 서비스입니다.</div>
      </div>
    </div>
  );
}
