import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createMarketService, createMarketHandler, parseMarketRequest } from "../lib/server/publicMarket";
const BASE = "https://dashboard.test/api/market?";
const NOW = Date.parse("2026-11-11T05:00:00Z");
function fixture(symbol = "AAPL", range = "1d") {
  return { chart: { error: null, result: [{ meta: { symbol, currency: /KS|KQ/.test(symbol) ? "KRW" : "USD", exchangeTimezoneName: symbol === "AAPL" ? "America/New_York" : "Asia/Seoul", regularMarketTime: 1794358800, regularMarketPrice: 110, previousClose: 100, chartPreviousClose: range === "1d" ? 100 : 50, regularMarketVolume: 20 }, timestamp: [1794358800, 1794272400], indicators: { quote: [{ open: [108, 100], high: [112, 111], low: [100, 99], close: [110, 108], volume: [20, 10] }] } }] } };
}
const calls: { url: string; init?: RequestInit }[] = [];
function mock(change?: (data: any) => void): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input)); calls.push({ url: String(input), init });
    let data: any;
    if (url.hostname === "api.upbit.com") data = url.pathname.endsWith("ticker") ? [{ market: url.searchParams.get("markets"), trade_price: 110, prev_closing_price: 100, acc_trade_volume_24h: 30, timestamp: NOW, trade_timestamp: NOW - 1000 }] : [{ market: url.searchParams.get("market"), candle_date_time_utc: "2026-11-10T00:00:00", opening_price: 100, high_price: 120, low_price: 90, trade_price: 110, candle_acc_trade_volume: 5, timestamp: NOW - 2000 }];
    else data = fixture(decodeURIComponent(url.pathname.split("/").pop()!), url.searchParams.get("range")!);
    change?.(data); return Response.json(data);
  };
}
const read = (query: string, fetcher = mock()) => createMarketService(fetcher, () => NOW).read(BASE + query) as Promise<any>;
for (const query of ["", "kind=order", "kind=quote", "kind=quote&ticker=http://evil", "kind=quote&ticker=..%2FAAPL", "kind=quote&ticker=AAPL%00", "kind=quote&ticker=AAPL%0A", "kind=quote&ticker=AAPL&ticker=MSFT", "kind=quote&ticker=AAPL&host=evil", "kind=quote&ticker=123456", "kind=quote&ticker=aapl", "kind=quote&ticker=constructor", "kind=quote&ticker=AAPL&currency=NaN", "kind=quote&ticker=BTC&currency=usd", "kind=chart&ticker=AAPL&period=MAX", "kind=chart&ticker=AAPL&period=toString", "kind=quotes&tickers=AAPL,AAPL", "kind=quotes&tickers=" + Array.from({length: 11}, (_, i) => `A${i}`).join(","), "kind=indices&ticker=AAPL", "kind=quote&ticker=" + "A".repeat(241)]) {
  test(`reject invalid query ${query.slice(0, 75)}`, () => assert.throws(() => parseMarketRequest(BASE + query)));
}
test("oversized whole URL rejected", () => assert.throws(() => parseMarketRequest(BASE + "x".repeat(2100))));
test("authentication before parsing or upstream and private denied response", async () => {
  let fetched = false; const service = createMarketService(async () => { fetched = true; throw Error("secret"); });
  const handler = createMarketHandler(async h => { assert.equal(h.get("cookie"), "sensitive"); return new Response("Forbidden", {status: 403}); }, service, {});
  assert.equal((await handler(new Request(BASE + "invalid", {headers: {cookie: "sensitive"}}))).status, 403); assert.equal(fetched, false);
});
test("GET response no-store, no incoming credentials forwarded, fixed HTTPS", async () => {
  calls.length = 0; const handler = createMarketHandler(async () => null, createMarketService(mock(), () => NOW), {"Cache-Control": "private, no-store, max-age=0"});
  const response = await handler(new Request(BASE + "kind=quote&ticker=AAPL", {headers: {cookie: "secret", authorization: "secret", "Cf-Access-Jwt-Assertion": "secret"}}));
  assert.equal(response.status, 200); assert.match(response.headers.get("cache-control")!, /private, no-store/);
  assert.equal(calls.length, 1); assert.equal(new URL(calls[0].url).origin, "https://query1.finance.yahoo.com");
  assert.deepEqual(calls[0].init?.headers, {Accept: "application/json"}); assert.equal(calls[0].init?.credentials, "omit"); assert.equal(calls[0].init?.redirect, "error");
});
for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) test(`handler denies ${method} without fetch`, async () => {
  const handler = createMarketHandler(async () => null, createMarketService(async () => {throw Error("must not fetch");}), {});
  const r = await handler(new Request(BASE + "kind=quote&ticker=AAPL", {method})); assert.equal(r.status, 405);
});
test("route has no write exports and imports Access guard", () => {
  const route = readFileSync("app/api/market/route.ts", "utf8"); assert.match(route, /requireAccess/); assert.doesNotMatch(route, /export (?:const|function|async function) (POST|PUT|DELETE|PATCH)/);
});
test("quote daily change and distinct provider time vs receipt", async () => {
  const p = await read("kind=quote&ticker=AAPL"); assert.equal(p.current_price, 110); assert.equal(p.change, 10); assert.equal(p.change_pct, 10); assert.equal(p.currency, "USD"); assert.equal(p.source, "Yahoo Finance"); assert.notEqual(p.as_of, p.fetched_at); assert.equal(p.as_of, new Date(1794358800000).toISOString());
});
for (const ticker of ["005930", "000660", "005930.KS", "035720.KQ"]) test(`explicit Korean mapping ${ticker}`, async () => {
  const p = await read(`kind=quote&ticker=${ticker}`); assert.equal(p.currency, "KRW"); assert.equal(p.providerSymbol, ticker.includes(".") ? ticker : ticker + ".KS");
});
for (const corrupt of [
  (d: any) => { d.chart.result[0].meta.symbol = "MSFT"; },
  (d: any) => { d.chart.result[0].meta.currency = "KRW"; },
  (d: any) => { d.chart.result[0].meta.regularMarketPrice = null; },
  (d: any) => { d.chart.result[0].meta.regularMarketPrice = -1; },
  (d: any) => { d.chart.result[0].meta.regularMarketVolume = -1; },
  (d: any) => { d.chart.result[0].meta.regularMarketTime = "bad"; },
  (d: any) => { d.chart.result[0].meta.exchangeTimezoneName = "Invalid/Zone"; },
  (d: any) => { d.chart.error = {description: "secret provider error"}; },
]) test(`reject malformed quote ${corrupt.toString()}`, async () => assert.rejects(read("kind=quote&ticker=AAPL", mock(corrupt)), /Market data unavailable/));
test("quote request always one day", async () => { calls.length = 0; await read("kind=quote&ticker=AAPL"); assert.equal(new URL(calls[0].url).searchParams.get("range"), "1d"); });
test("chart uses exchange calendar, sorted unique dates and native currency", async () => {
  const p = await read("kind=chart&ticker=AAPL&period=1M", mock(d => { d.chart.result[0].timestamp = [Date.parse("2026-11-11T01:00:00Z") / 1000, Date.parse("2026-11-10T01:00:00Z") / 1000]; }));
  assert.deepEqual(p.candles.map((c: any) => c.date), ["2026-11-09", "2026-11-10"]); assert.equal(p.currency, "USD"); assert.equal(p.covered_from, "2026-11-09"); assert.equal(p.exchange_timezone, "America/New_York");
});
for (const corrupt of [
  (d: any) => { d.chart.result[0].indicators.quote[0].open[0] = 0; },
  (d: any) => { d.chart.result[0].indicators.quote[0].high[0] = 1; },
  (d: any) => { d.chart.result[0].indicators.quote[0].low[0] = 200; },
  (d: any) => { d.chart.result[0].indicators.quote[0].volume[0] = -1; },
  (d: any) => { d.chart.result[0].timestamp = []; },
  (d: any) => { d.chart.result[0].timestamp[0] = "bad"; },
]) test(`invalid chart unavailable ${corrupt.toString()}`, async () => assert.rejects(read("kind=chart&ticker=AAPL", mock(corrupt))));
test("deduplicate dates safely", async () => { const p = await read("kind=chart&ticker=AAPL", mock(d => {d.chart.result[0].timestamp[1] = d.chart.result[0].timestamp[0];})); assert.equal(p.candles.length, 1); });
test("Upbit KRW quote and provider receipt distinct", async () => { const p = await read("kind=quote&ticker=BTC"); assert.equal(p.currency, "KRW"); assert.equal(p.providerSymbol, "KRW-BTC"); assert.equal(p.as_of, new Date(NOW - 1000).toISOString()); });
test("Upbit UTC bars and 1Y coverage explicitly capped", async () => { calls.length = 0; const p = await read("kind=chart&ticker=BTC&period=1Y"); assert.equal(p.candles[0].date, "2026-11-10"); assert.equal(p.exchange_timezone, "UTC"); assert.match(p.coverage_note, /not a full year/); assert.equal(new URL(calls[0].url).searchParams.get("count"), "200"); assert.equal(calls.length, 1); });
test("invalid Upbit calendar rejected", async () => assert.rejects(read("kind=chart&ticker=BTC", mock(d => {d[0].candle_date_time_utc = "2026-02-30T00:00:00";}))));
test("invalid Upbit symbol rejected", async () => assert.rejects(read("kind=quote&ticker=BTC", mock(d => {d[0].market = "USD-BTC";}))));
for (const status of [301, 429, 500]) test(`provider ${status} safe error`, async () => {
  await assert.rejects(read("kind=quote&ticker=AAPL", async () => new Response("secret", {status})), /Market data unavailable/);
});
test("redirected successful response rejected", async () => {
  await assert.rejects(read("kind=quote&ticker=AAPL", async () => { const r = Response.json(fixture()); Object.defineProperty(r, "redirected", {value: true}); return r; }));
});
test("timeout aborts upstream", async () => {
  const service = createMarketService(async (_url, init) => new Promise((_resolve, reject) => { init?.signal?.addEventListener("abort", () => reject(Error("secret timeout"))); }), () => NOW, 5);
  await assert.rejects(service.read(BASE + "kind=quote&ticker=AAPL"), /Market data unavailable/);
});
test("oversize declared body rejected", async () => assert.rejects(read("kind=quote&ticker=AAPL", async () => new Response("{}", {headers: {"Content-Length": "1048577"}}))));
test("oversize streamed body rejected before parse", async () => assert.rejects(read("kind=quote&ticker=AAPL", async () => new Response(" ".repeat(1048577)))));
test("invalid JSON safe error", async () => assert.rejects(read("kind=quote&ticker=AAPL", async () => new Response("secret non-json")), /Market data unavailable/));
test("cache TTL, LRU cap and expired values never fallback", async () => {
  let time = NOW; let count = 0; const fetcher = mock(); const service = createMarketService(async (u, i) => { count++; return fetcher(u, i); }, () => time);
  await service.read(BASE + "kind=quote&ticker=AAPL"); await service.read(BASE + "kind=quote&ticker=AAPL"); assert.equal(count, 1); time += 15001; await service.read(BASE + "kind=quote&ticker=AAPL"); assert.equal(count, 2);
  for (let i = 0; i < 130; i++) { const ticker = "Z" + String.fromCharCode(65 + Math.floor(i / 26)) + String.fromCharCode(65 + i % 26); await service.read(BASE + `kind=quote&ticker=${ticker}`); } assert.equal(service.cacheSize(), 128);
});
test("indices isolated per-item error and metadata", async () => {
  const fetcher = mock(); const p = await read("kind=indices", async (u, i) => String(u).includes("KQ11") ? new Response("secret", {status: 502}) : fetcher(u, i)); assert.equal(p.length, 5); assert.equal(p[1].error, "Market data unavailable"); assert.equal(p[0].currency, "KRW"); assert.equal(p[2].currency, "USD"); assert.equal(p[4].source, "Upbit");
});
test("concurrency capped, no unbounded pending fanout", async () => {
  let finish!: () => void; const blocked = new Promise<void>(r => {finish = r;}); const fetcher = mock(); const service = createMarketService(async (u, i) => {await blocked; return fetcher(u, i);}, () => NOW);
  const first = ["AAPL", "MSFT", "SPY"].map(t => service.read(BASE + `kind=quote&ticker=${t}`)); await assert.rejects(service.read(BASE + "kind=quote&ticker=QQQ")); finish(); await Promise.all(first);
});
test("client market fetch is relative and no GET Content-Type, private methods unchanged", () => {
  const api = readFileSync("lib/api.ts", "utf8"); assert.match(api, /fetch\(`\/api\/market\?/); assert.match(api, /fetchAPI\("\/api\/balance"\)/); assert.match(api, /fetchAPI\("\/api\/order"/);
  const hooks = readFileSync("hooks/usePortfolio.ts", "utf8"); assert.match(hooks, /publicMarket \? async \(\) => true : isBackendUp/); assert.match(hooks, /validPrice\(p, tickers\[i\]\)/);
  assert.doesNotMatch(readFileSync("components/CandlestickChart.tsx", "utf8"), /innerHTML/);
});
test("future provider trade timestamp rejected", async () => assert.rejects(read("kind=quote&ticker=BTC", mock(d => {d[0].trade_timestamp = NOW + 600000;}))));
test("future Yahoo quote time rejected", async () => assert.rejects(read("kind=quote&ticker=AAPL", mock(d => {d.chart.result[0].meta.regularMarketTime = (NOW + 600000) / 1000;}))));
test("future daily candle rejected", async () => assert.rejects(read("kind=chart&ticker=BTC", mock(d => {d[0].candle_date_time_utc = "2026-11-12T00:00:00";}))));
test("body read bounded even if stream stalls", async () => {
  const service = createMarketService(async () => new Response(new ReadableStream({start() {}})), () => NOW, 5);
  await assert.rejects(service.read(BASE + "kind=quote&ticker=AAPL"), /Market data unavailable/);
});
test("overall operation deadline prevents slow serial fanout", async () => {
  let count = 0; const fetcher = mock();
  const service = createMarketService(async (u, i) => {count++; await new Promise(r => setTimeout(r, 8)); return fetcher(u, i);}, () => NOW, 8000, 12);
  await assert.rejects(service.read(BASE + "kind=quotes&tickers=AAPL,MSFT,SPY,QQQ")); assert.ok(count <= 2);
});
test("nonfinite derived quote percentage rejected", async () => assert.rejects(read("kind=quote&ticker=AAPL", mock(d => { d.chart.result[0].meta.previousClose = 1e-300; d.chart.result[0].meta.regularMarketPrice = 1e300; }))));
for (const mode of ["status", "length", "redirect"]) test(`early ${mode} rejection aborts and cancels streaming body before slot release`, async () => {
  let cancelled = false; let signal: AbortSignal | null | undefined;
  await assert.rejects(read("kind=quote&ticker=AAPL", async (_url, init) => {
    signal = init?.signal;
    const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: mode === "status" ? 429 : 200, headers: mode === "length" ? {"Content-Length": "1048577"} : {} });
    if (mode === "redirect") Object.defineProperty(response, "redirected", {value: true});
    return response;
  }));
  assert.equal(signal?.aborted, true); assert.equal(cancelled, true);
});
test("SearchPage uses scoped market hooks with explicit provenance and no local request races", () => {
  const search = readFileSync("components/SearchPage.tsx", "utf8");
  assert.match(search, /usePrice\(ticker\)/); assert.match(search, /useChart\(ticker, period\)/); assert.match(search, /MarketSource/); assert.match(search, /DataProvenance/);
  assert.doesNotMatch(search, /\bgetPrice\(|\bgetChart\(|setPrice\(|setChartData\(/);
});
