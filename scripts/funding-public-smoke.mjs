/**
 * Public Hyperliquid market-data completeness smoke (PAPER ONLY).
 * No key, wallet, authenticated request, order, transfer or position.
 * This runs separately from deterministic CI; upstream availability is not
 * evidence that this model predicts future cash returns.
 */
import { appendFile } from "node:fs/promises";
import { calculateFundingSimulation, HOUR_MS, DAY_MS } from "../lib/funding-model.ts";

const URL = "https://api.hyperliquid.xyz/info";
const COINS = ["BTC", "ETH", "XRP"];
const end = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
const start90 = end - 90 * DAY_MS;
const maxRecords = 2160;
const output = [];

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function query(payload) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(URL, {
        method: "POST",
        headers: {"Content-Type": "application/json", Accept: "application/json"},
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20000),
        cache: "no-store"
      });
      if (!response.ok) throw new Error("Exchange returned HTTP " + response.status);
      return await response.json();
    } catch (error) {
      if (attempt === 1) throw error;
      await pause(700);
    }
  }
  throw new Error("Unexpected retry exit");
}
async function fundingHistory(coin) {
  const rows = [];
  let cursor = start90 + 1;
  for (let page = 0; page < 7 && cursor <= end; page++) {
    const raw = await query({type:"fundingHistory",coin,startTime:cursor,endTime:end});
    if (!Array.isArray(raw) || raw.length > 500 || raw.length === 0) {
      if (Array.isArray(raw) && raw.length === 0) break;
      throw new Error("Malformed funding page for " + coin);
    }
    let last = cursor - 1;
    for (const row of raw) {
      if (!row || !Number.isSafeInteger(row.time) || row.time < cursor ||
          row.time > end || row.time <= last ||
          (typeof row.fundingRate !== "string" && typeof row.fundingRate !== "number")) {
        throw new Error("Invalid or unsorted funding data for " + coin);
      }
      last = row.time;
      rows.push({time:row.time,fundingRate:row.fundingRate});
    }
    cursor = last + 1;
    if (raw.length < 500) break;
  }
  if (rows.length !== maxRecords) throw new Error(
    coin + " funding incomplete: expected 2160 hourly rows, received " + rows.length
  );
  return rows;
}
async function hourlyCandles(coin) {
  const raw = await query({type:"candleSnapshot",req:{
    coin, interval:"1h", startTime:start90, endTime:end
  }});
  if (!Array.isArray(raw) || raw.length > 5000) throw new Error("Malformed candle snapshot for " + coin);
  const rows = raw.filter(x=>x && x.t >= start90 && x.t < end)
    .map(x=>({t:x.t,T:x.T,o:x.o,h:x.h,l:x.l,c:x.c}));
  if (rows.length !== maxRecords) throw new Error(
    coin + " candles incomplete: expected 2160 hourly rows, received " + rows.length
  );
  return rows;
}
function verify(coin,days,funding,candles) {
  const startMs = end - days * DAY_MS;
  const simulation = calculateFundingSimulation({
    coin,days,startMs,endMs:end,notionalUsd:10000,
    spotFeeBps:10,perpFeeBps:4.5,slippageBps:5,
    funding: funding.filter(x=>x.time>startMs),
    candles: candles.filter(x=>x.t>=startMs)
  });
  return {
    coin,days,execution_mode:simulation.execution_mode,
    source:simulation.source,
    start_utc:simulation.start_utc,end_utc:simulation.end_utc,
    hourly_settlements:simulation.hourly_settlements,
    funding_sum_pct:simulation.funding_rate_sum_pct,
    annualized_funding_pct:simulation.funding_simple_annualized_pct,
    gross_funding_usd:simulation.gross_funding_usd,
    hedged_net_usd:simulation.hedged_net_usd,
    hedged_return_pct_on_2x_capital:simulation.hedged_return_on_total_capital_pct,
    short_collateral_breach_proxy:simulation.short_collateral_breach_in_proxy,
    short_margin_stress_proxy:simulation.short_margin_stress_warning
  };
}
try {
  for (const coin of COINS) {
    const [funding,candles]=await Promise.all([fundingHistory(coin),hourlyCandles(coin)]);
    output.push(verify(coin,30,funding,candles));
    output.push(verify(coin,90,funding,candles));
  }
  const summary = [
    "## Hyperliquid market-data read-only smoke",
    "UTC cutoff: " + new Date(end).toISOString(),
    "Simulated leg notional: $10,000; total spot+perp capital: $20,000.",
    "Assumptions: perp candle closes proxy oracle-settled funding; basis, tax, FX, borrow and actual liquidation not modeled.",
    "",
    "| Coin | Window | Settlements | Gross funding (USD) | Hedged after-cost (USD) | On 2x capital | Margin proxy |",
    "| --- | ---: | ---: | ---: | ---: | ---: | --- |",
    ...output.map(r=>`| ${r.coin} | ${r.days}d | ${r.hourly_settlements} | ${r.gross_funding_usd} | ${r.hedged_net_usd} | ${r.hedged_return_pct_on_2x_capital}% | ${r.short_collateral_breach_proxy ? "breach" : r.short_margin_stress_proxy ? "warning" : "none in proxy"} |`)
  ].join("\n");
  console.log(summary);
  console.log("JSON_RESULT=" + JSON.stringify(output));
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, summary+"\n");
  }
} catch (error) {
  const message = "Public market-data smoke cannot verify all BTC/ETH/XRP 30/90-day rows: "+(error instanceof Error?error.message:String(error));
  console.error(message);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, "## Hyperliquid market-data smoke\n"+message+"\n");
  }
  process.exitCode=1;
}
