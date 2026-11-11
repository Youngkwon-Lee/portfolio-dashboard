// Pure local-paper domain. All financial arithmetic uses fixed-point integers.
export const STORAGE_KEY = 'quant-lab:manual-paper-portfolio:v1';
export const SCALE = BigInt(100000000);
export const PRODUCT = SCALE * SCALE;
export const MAX_RAW = 16384;
export type Currency = 'KRW' | 'USD';
export type Position = { id: string; ticker: string; currency: Currency; qty: string; avg: string };
export type Portfolio = { version: 1; holdings: Position[]; cash: { KRW: string; USD: string } };
export const emptyPortfolio = (): Portfolio => ({ version: 1, holdings: [], cash: { KRW: '0', USD: '0' } });
const crypto = new Set(['BTC','ETH','BNB','SOL','XRP','ADA','DOGE','DOT','AVAX','MATIC']);
const fail = (): never => { throw Error('입력 또는 저장 형식이 올바르지 않습니다.'); };
export function instrument(input: string): {ticker: string; currency: Currency; source: string; providerSymbol: string} {
  if (typeof input !== 'string' || input.length > 12) return fail();
  const ticker = input === '005930' || input === '000660' ? `${input}.KS` : input;
  if (crypto.has(ticker)) return { ticker, currency: 'KRW', source: 'Upbit', providerSymbol: `KRW-${ticker}` };
  if (/^\d{6}\.(KS|KQ)$/.test(ticker)) return { ticker, currency: 'KRW', source: 'Yahoo Finance', providerSymbol: ticker };
  if (/^[A-Z]{1,5}(?:[.-][A-Z]{1,2})?$/.test(ticker)) return { ticker, currency: 'USD', source: 'Yahoo Finance', providerSymbol: ticker };
  return fail();
}
export function decimal(value: unknown, kind: 'qty' | 'avg' | 'cash'): string {
  if (typeof value !== 'string' || value.length > 24 || !/^(0|[1-9]\d*)(?:\.\d{1,8})?$/.test(value)) return fail();
  const [a, b = ''] = value.split('.');
  const n = BigInt(a) * SCALE + BigInt(b.padEnd(8, '0'));
  const max = BigInt(kind === 'qty' ? '1000000000' : '1000000000000') * SCALE;
  if (n > max || (kind !== 'cash' && n === BigInt(0))) return fail();
  return b.replace(/0+$/, '') ? `${a}.${b.replace(/0+$/, '')}` : a;
}
export function units(value: string): bigint { const [a,b=''] = value.split('.'); return BigInt(a)*SCALE + BigInt(b.padEnd(8,'0')); }
function exact(obj: unknown, keys: string[]): asserts obj is Record<string, unknown> {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || Object.getPrototypeOf(obj) !== Object.prototype || Object.keys(obj).sort().join(',') !== [...keys].sort().join(',')) fail();
}
export function validate(value: unknown): Portfolio {
  exact(value, ['version','holdings','cash']);
  if (value.version !== 1 || !Array.isArray(value.holdings) || value.holdings.length > 10) return fail();
  exact(value.cash, ['KRW','USD']);
  const ids = new Set<string>(), symbols = new Set<string>();
  const holdings = value.holdings.map((p: unknown): Position => {
    exact(p, ['id','ticker','currency','qty','avg']);
    if (typeof p.id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(p.id) || typeof p.ticker !== 'string') return fail();
    const i = instrument(p.ticker);
    if (p.currency !== i.currency || ids.has(p.id) || symbols.has(i.ticker)) return fail();
    ids.add(p.id); symbols.add(i.ticker);
    return {id:p.id, ticker:i.ticker, currency:i.currency, qty:decimal(p.qty,'qty'), avg:decimal(p.avg,'avg')};
  });
  return {version:1, holdings, cash:{KRW:decimal(value.cash.KRW,'cash'), USD:decimal(value.cash.USD,'cash')}};
}
export function decode(raw: string | null): Portfolio {
  if (raw === null) return emptyPortfolio();
  if (!raw || raw.length > MAX_RAW || new TextEncoder().encode(raw).length > MAX_RAW) return fail();
  return validate(JSON.parse(raw));
}
export function encode(p: Portfolio): string { const raw = JSON.stringify(validate(p)); if (raw.length > MAX_RAW) return fail(); return raw; }
export interface Store {getItem(key: string): string | null; setItem(key: string,value: string): void; removeItem(key: string): void}
export function writePortfolio(store: Store, expected: string | null, next: Portfolio): string {
  if (store.getItem(STORAGE_KEY) !== expected) throw Error('다른 탭에서 변경되었습니다. 최신 내용을 확인하고 다시 편집하세요.');
  // Fail closed for malformed/unsupported prior documents. Recovery is explicit reset only.
  decode(expected);
  const raw = encode(next); store.setItem(STORAGE_KEY, raw);
  if (store.getItem(STORAGE_KEY) !== raw) throw Error('저장을 확인할 수 없습니다. 다시 불러오세요.');
  decode(raw); return raw;
}
export function resetPortfolio(store: Store, expected: string | null): void {
  if (store.getItem(STORAGE_KEY) !== expected) throw Error('다른 탭에서 변경되었습니다. 다시 확인하세요.');
  store.removeItem(STORAGE_KEY);
  if (store.getItem(STORAGE_KEY) !== null) throw Error('초기화를 확인할 수 없습니다.');
}
// Signed round-half-away-from-zero, including display and percent.
export function rounded(n: bigint, divisor: bigint): bigint { const sign=n<BigInt(0)?BigInt(-1):BigInt(1); const a=n*sign; return sign*((a+divisor/BigInt(2))/divisor); }
export function money(n: bigint, currency: Currency): string {
  const digits=currency==='KRW'?0:2; const factor=digits===0?BigInt(1):BigInt(100);
  const v=rounded(n, PRODUCT/factor), abs=v<BigInt(0)?-v:v;
  const text=abs.toString().padStart(digits+1,'0');
  const integer=(digits?text.slice(0,-digits):text).replace(/\B(?=(\d{3})+(?!\d))/g,',');
  return `${v<BigInt(0)?'-':''}${integer}${digits?'.'+text.slice(-digits):''} ${currency}`;
}
export function percent(pnl: bigint, cost: bigint): string { if(cost===BigInt(0)) return '해당 없음'; const v=rounded(pnl*BigInt(10000),cost); const a=(v<BigInt(0)?-v:v).toString().padStart(3,'0'); return `${v<BigInt(0)?'-':''}${a.slice(0,-2)}.${a.slice(-2)}%`; }
export type Quote = { price: bigint; source: string; providerSymbol: string; currency: Currency; as_of: string; fetched_at: string; exchange_timezone: string };
export function totals(p: Portfolio, quotes: Record<string, Quote | undefined>, currency: Currency) {
  const rows=p.holdings.filter(h=>h.currency===currency); let cost=BigInt(0), value=BigInt(0), complete=true;
  for(const h of rows) {cost+=units(h.qty)*units(h.avg); const q=quotes[h.ticker]; if(!q || q.currency!==currency) complete=false; else value+=units(h.qty)*q.price;}
  const cash=units(p.cash[currency])*SCALE;
  return {cost,cash,complete,value:complete?value:null,pnl:complete?value-cost:null,total:complete?value+cash:null};
}
