import "server-only";
// Server implementation: imported only by the authenticated route, never client code.
import type { Candle, ChartResponse, StockPrice, IndexPrice, MarketMetadata } from "../api";
const CRYPTO = new Set(["BTC", "ETH", "BNB", "SOL", "XRP", "ADA", "DOGE", "DOT", "AVAX", "MATIC"]);
const KRX: Record<string, string> = { "005930": "005930.KS", "000660": "000660.KS" };
const INDICES = [["KOSPI", "^KS11"], ["KOSDAQ", "^KQ11"], ["S&P 500", "^GSPC"], ["NASDAQ", "^IXIC"], ["BTC", "BTC"]] as const;
const PERIODS = { "1M": "1mo", "3M": "3mo", "6M": "6mo", "1Y": "1y" } as const;
const MAX_BODY = 1_048_576;
export class MarketError extends Error {
  constructor(public status = 502) { super(status === 400 ? "Invalid market request" : "Market data unavailable"); }
}
const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const nonnegative = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
function iso(seconds: unknown): string {
  if (!positive(seconds) || seconds > 8_640_000_000_000) throw new MarketError();
  return new Date(seconds * 1000).toISOString();
}
function calendar(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
}
function normalize(candles: Candle[]): Candle[] {
  const dates = new Map<string, Candle>();
  for (const c of candles) {
    if (!calendar(c.date) || ![c.open, c.high, c.low, c.close].every(positive) || !nonnegative(c.volume) || c.low > Math.min(c.open, c.close) || c.high < Math.max(c.open, c.close)) throw new MarketError();
    dates.set(c.date, c);
  }
  if (!dates.size) throw new MarketError();
  return [...dates.values()].sort((a, b) => a.date.localeCompare(b.date));
}
function symbol(ticker: string, internal = false) {
  if (internal && INDICES.some(([, s]) => s === ticker)) return ticker;
  if (CRYPTO.has(ticker)) return `KRW-${ticker}`;
  if (Object.hasOwn(KRX, ticker)) return KRX[ticker];
  if (/^\d{6}\.(KS|KQ)$/.test(ticker) || /^[A-Z]{1,5}(?:[.-][A-Z]{1,2})?$/.test(ticker)) return ticker;
  throw new MarketError(400);
}
export function parseMarketRequest(url: string) {
  if (url.length > 2048) throw new MarketError(400);
  const params = new URL(url).searchParams;
  for (const [key, value] of params) {
    if (!["kind", "ticker", "tickers", "period", "currency"].includes(key) || params.getAll(key).length !== 1 || value.length > 240 || /[\x00-\x20\x7f]/.test(value)) throw new MarketError(400);
  }
  const kind = params.get("kind");
  if (!["quote", "quotes", "chart", "indices"].includes(kind ?? "")) throw new MarketError(400);
  const allowed = kind === "indices" ? ["kind"] : kind === "quotes" ? ["kind", "tickers", "currency"] : kind === "chart" ? ["kind", "ticker", "period", "currency"] : ["kind", "ticker", "currency"];
  for (const key of params.keys()) if (!allowed.includes(key)) throw new MarketError(400);
  const currency = params.get("currency") ?? "krw";
  if (!["krw", "usd"].includes(currency)) throw new MarketError(400);
  const period = params.get("period") ?? "1M";
  if (!(period in PERIODS) || !Object.hasOwn(PERIODS, period)) throw new MarketError(400);
  const tickers = kind === "indices" ? [] : kind === "quotes" ? (params.get("tickers") ?? "").split(",") : [params.get("ticker") ?? ""];
  if (tickers.length > 10 || new Set(tickers).size !== tickers.length) throw new MarketError(400);
  for (const ticker of tickers) {
    symbol(ticker);
    if (CRYPTO.has(ticker) && currency !== "krw") throw new MarketError(400);
  }
  return { kind: kind!, tickers, period: period as keyof typeof PERIODS, currency };
}
export function createMarketService(fetcher: typeof fetch = fetch, now = () => Date.now(), timeoutMs = 8000, operationMs = 18_000) {
  const cache = new Map<string, { until: number; data: unknown }>();
  let active = 0;
  async function json(url: string, deadline: number): Promise<any> {
    if (Date.now() >= deadline) throw new MarketError();
    if (active >= 3) throw new MarketError(503);
    active++;
    const controller = new AbortController();
    let providerResponse: Response | undefined;
    const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(timeoutMs, 8000, deadline - Date.now())));
    try {
      const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new MarketError()), { once: true }));
      return await Promise.race([aborted, (async () => {
      const response = providerResponse = await fetcher(url, { method: "GET", headers: { Accept: "application/json" }, credentials: "omit", redirect: "error", cache: "no-store", signal: controller.signal });
      if (!response.ok || response.redirected || !response.body) throw new MarketError();
      const length = response.headers.get("content-length");
      if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY)) throw new MarketError();
      const reader = response.body.getReader();
      controller.signal.addEventListener("abort", () => { void reader.cancel().catch(() => {}); }, { once: true });
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BODY) throw new MarketError();
          chunks.push(value);
        }
      } catch (e) { void reader.cancel().catch(() => {}); throw e; }
      const body = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
      })()]);
    } catch { throw new MarketError(); }
    finally {
      controller.abort();
      void providerResponse?.body?.cancel().catch(() => {});
      clearTimeout(timer); active--;
    }
  }
  async function cached<T>(key: string, read: () => Promise<T>): Promise<T> {
    const hit = cache.get(key);
    if (hit && hit.until > now()) { cache.delete(key); cache.set(key, hit); return hit.data as T; }
    cache.delete(key);
    const data = await read();
    for (const [k, v] of cache) if (v.until <= now()) cache.delete(k);
    while (cache.size >= 128) cache.delete(cache.keys().next().value!);
    cache.set(key, { until: now() + 15_000, data });
    return data;
  }
  function metadata(provider: "Yahoo Finance" | "Upbit", providerSymbol: string, currency: string, as_of: string, exchange_timezone: string): MarketMetadata {
    if (Date.parse(as_of) > now() + 300_000) throw new MarketError();
    return { source: provider, providerSymbol, currency, as_of, fetched_at: new Date(now()).toISOString(), exchange_timezone, delayed: true };
  }
  async function yahoo(ticker: string, range: string, deadline: number, internal = false) {
    const providerSymbol = symbol(ticker, internal);
    const raw = await json(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(providerSymbol)}?range=${range}&interval=1d`, deadline);
    const result = raw?.chart?.result;
    if (raw?.chart?.error || !Array.isArray(result) || result.length !== 1) throw new MarketError();
    const data = result[0]; const meta = data?.meta;
    const expectedCurrency = /\.(KS|KQ)$/.test(providerSymbol) || ["^KS11", "^KQ11"].includes(providerSymbol) ? "KRW" : "USD";
    if (!meta || meta.symbol !== providerSymbol || meta.currency !== expectedCurrency || typeof meta.exchangeTimezoneName !== "string") throw new MarketError();
    try { new Intl.DateTimeFormat("en", { timeZone: meta.exchangeTimezoneName }); } catch { throw new MarketError(); }
    return { data, meta, info: metadata("Yahoo Finance", providerSymbol, meta.currency, iso(meta.regularMarketTime), meta.exchangeTimezoneName) };
  }
  async function quote(ticker: string, deadline: number, internal = false): Promise<StockPrice> {
    return cached(`q:${ticker}`, async () => {
      if (CRYPTO.has(ticker)) {
        const providerSymbol = symbol(ticker); const raw = await json(`https://api.upbit.com/v1/ticker?markets=${encodeURIComponent(providerSymbol)}`, deadline);
        const p = Array.isArray(raw) && raw.length === 1 ? raw[0] : null;
        if (!p || p.market !== providerSymbol || !positive(p.trade_price) || !positive(p.prev_closing_price) || !nonnegative(p.acc_trade_volume_24h) || !positive(p.trade_timestamp)) throw new MarketError();
        const change = p.trade_price - p.prev_closing_price;
        if (!Number.isFinite(change / p.prev_closing_price * 100)) throw new MarketError();
        return { ticker, name: ticker, current_price: p.trade_price, change, change_pct: change / p.prev_closing_price * 100, volume: p.acc_trade_volume_24h, ...metadata("Upbit", providerSymbol, "KRW", iso(p.trade_timestamp / 1000), "UTC") };
      }
      const { meta, info } = await yahoo(ticker, "1d", deadline, internal);
      // Only a 1-day request may use chartPreviousClose; longer ranges have a different baseline.
      const previous = meta.previousClose ?? meta.chartPreviousClose;
      if (!positive(meta.regularMarketPrice) || !positive(previous) || !nonnegative(meta.regularMarketVolume)) throw new MarketError();
      const change = meta.regularMarketPrice - previous;
      if (!Number.isFinite(change / previous * 100)) throw new MarketError();
      return { ticker, name: typeof meta.shortName === "string" ? meta.shortName.slice(0, 120) : ticker, current_price: meta.regularMarketPrice, change, change_pct: change / previous * 100, volume: meta.regularMarketVolume, ...info };
    });
  }
  async function chart(ticker: string, period: keyof typeof PERIODS, deadline: number): Promise<ChartResponse> {
    return cached(`c:${ticker}:${period}`, async () => {
      let candles: Candle[]; let info: MarketMetadata;
      if (CRYPTO.has(ticker)) {
        const providerSymbol = symbol(ticker);
        const count = { "1M": 31, "3M": 93, "6M": 186, "1Y": 200 }[period];
        const raw = await json(`https://api.upbit.com/v1/candles/days?market=${encodeURIComponent(providerSymbol)}&count=${count}`, deadline);
        if (!Array.isArray(raw) || !raw.length || raw.length > count) throw new MarketError();
        candles = raw.map((c) => {
          if (c.market !== providerSymbol || typeof c.candle_date_time_utc !== "string" || !/^\d{4}-\d{2}-\d{2}T00:00:00$/.test(c.candle_date_time_utc)) throw new MarketError();
          return { date: c.candle_date_time_utc.slice(0, 10), open: c.opening_price, high: c.high_price, low: c.low_price, close: c.trade_price, volume: c.candle_acc_trade_volume };
        });
        const timestamps = raw.map(c => c.timestamp);
        if (!timestamps.every(positive)) throw new MarketError();
        info = metadata("Upbit", providerSymbol, "KRW", iso(Math.max(...timestamps) / 1000), "UTC");
      } else {
        const { data, meta, info: yahooInfo } = await yahoo(ticker, PERIODS[period], deadline); info = yahooInfo;
        const timestamps = data.timestamp; const q = data.indicators?.quote?.[0];
        if (!Array.isArray(timestamps) || timestamps.length > 400 || !q) throw new MarketError();
        const formatter = new Intl.DateTimeFormat("en-US", { timeZone: meta.exchangeTimezoneName, year: "numeric", month: "2-digit", day: "2-digit" });
        candles = timestamps.map((t: unknown, i: number) => {
          const parts = formatter.formatToParts(new Date(iso(t)));
          const part = (name: string) => parts.find(p => p.type === name)?.value;
          return { date: `${part("year")}-${part("month")}-${part("day")}`, open: q.open?.[i], high: q.high?.[i], low: q.low?.[i], close: q.close?.[i], volume: q.volume?.[i] };
        });
      }
      candles = normalize(candles);
      const todayParts = new Intl.DateTimeFormat("en-US", {timeZone: info.exchange_timezone, year: "numeric", month: "2-digit", day: "2-digit"}).formatToParts(new Date(now()));
      const todayPart = (name: string) => todayParts.find(p => p.type === name)?.value;
      const today = `${todayPart("year")}-${todayPart("month")}-${todayPart("day")}`;
      if (candles.some(c => c.date > today)) throw new MarketError();
      return { ticker, market: CRYPTO.has(ticker) ? "CRYPTO" : info.currency === "KRW" ? "KRX" : "US", period, candles, ...info, covered_from: candles[0].date, covered_to: candles[candles.length - 1].date, coverage_note: CRYPTO.has(ticker) && period === "1Y" ? "Upbit: at most 200 daily bars, not a full year" : "Available provider daily bars only" };
    });
  }
  return {
    cacheSize: () => cache.size,
    async read(url: string): Promise<unknown> {
      const deadline = Date.now() + Math.min(operationMs, 18_000);
      const request = parseMarketRequest(url);
      if (request.kind === "chart") return chart(request.tickers[0], request.period, deadline);
      if (request.kind === "quote") return quote(request.tickers[0], deadline);
      if (request.kind === "quotes") { const values: StockPrice[] = []; for (const ticker of request.tickers) values.push(await quote(ticker, deadline)); return values; }
      const values: IndexPrice[] = [];
      for (const [name, ticker] of INDICES) {
        try { const p = await quote(ticker, deadline, true); values.push({ ...p, name, value: p.current_price }); }
        catch { values.push({ name, value: 0, change_pct: 0, error: "Market data unavailable" }); }
      }
      return values;
    },
  };
}
export function createMarketHandler(guard: (headers: Headers) => Promise<Response | null>, service: ReturnType<typeof createMarketService>, headers: Record<string, string>) {
  return async (request: Request) => {
    const denied = await guard(request.headers);
    if (denied) return denied;
    const responseHeaders = { ...headers, "X-Content-Type-Options": "nosniff" };
    if (request.method !== "GET") return Response.json({ error: "Method not allowed" }, { status: 405, headers: { ...responseHeaders, Allow: "GET" } });
    try { return Response.json(await service.read(request.url), { headers: responseHeaders }); }
    catch (error) { return Response.json({ error: error instanceof MarketError ? error.message : "Market data unavailable" }, { status: error instanceof MarketError ? error.status : 502, headers: responseHeaders }); }
  };
}
