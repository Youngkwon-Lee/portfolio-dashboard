import test from "node:test";
import assert from "node:assert/strict";
import {evaluateVenue} from "../lib/funding-venues.ts";
const HOUR=3600000,START=Date.parse("2026-07-01T00:00:00Z");
function fixture(overrides={}){
 const days=overrides.days??30,venue=overrides.venue??"Binance",end=START+days*24*HOUR;
 const step=venue==="Hyperliquid"?HOUR:8*HOUR,rows=[];
 for(let t=START+step;t<=end;t+=step)rows.push({time:t,rate:0.0001});
 return {venue,coin:"XRP",days,start:START,end,notionalUsd:10000,
  spotFeeBps:10,perpFeeBps:5,slippageBps:5,funding:rows,
  entry:{time:START,spot:99,perp:100},
  exit:{time:end-HOUR,spot:104,perp:106},...overrides};
}
test("real observed spot/perp basis change, equal coin units and both legs costs",()=>{
 const result=evaluateVenue(fixture());
 assert.equal(result.execution_mode,"paper");
 assert.equal(result.live_allowed,false);
 assert.equal(result.status,"basis_verified");
 assert.equal(result.basis_entry_pct,-1);
 assert.ok(result.basis_exit_pct<0);
 assert.equal(result.basis_pnl_usd,-100); // spot-perp basis: -1 -> -2, 100 XRP
 assert.equal(result.total_capital_usd,19900);
 assert.ok(result.fees_usd>0);
 assert.ok(result.slippage_usd>0);
 assert.ok(result.estimated_net_usd<result.funding_estimate_usd-100);
});
test("90 days are observed 8-hour settlements, not 30-day yield extrapolation",()=>{
 const out=evaluateVenue(fixture({days:90}));
 assert.equal(out.settlement_count,270);
 assert.equal(out.funding_sum_pct,2.7);
});
test("Hyperliquid 1-hour schedule is validated and never assumes real spot price",()=>{
 const x=fixture({venue:"Hyperliquid",entry:null,exit:null});
 const out=evaluateVenue(x);
 assert.equal(out.status,"funding_only");
 assert.equal(out.estimated_net_usd,null);
 assert.equal(out.settlement_count,720);
});
test("funding reversal reduces short income",()=>{
 const a=fixture();const b=fixture({funding:a.funding.map(x=>({...x,rate:-x.rate}))});
 assert.ok(evaluateVenue(b).funding_estimate_usd<0);
});
test("missing settlement, duplicate and malformed rates fail closed",()=>{
 const a=fixture();a.funding.splice(5,1);
 assert.throws(()=>evaluateVenue(a),/gap/);
 const b=fixture();b.funding[3].time=b.funding[2].time;
 assert.throws(()=>evaluateVenue(b),/duplicate/);
 const c=fixture();c.funding[0].rate=NaN;
 assert.throws(()=>evaluateVenue(c),/malformed/);
});
test("missing and mismatched spot/perp candles never produce estimated net return",()=>{
 const a=evaluateVenue(fixture({entry:null}));
 assert.equal(a.status,"funding_only");
 assert.equal(a.estimated_net_usd,null);
 assert.throws(()=>evaluateVenue(fixture({exit:{time:START,spot:104,perp:106}})),/time-aligned/);
});
test("short collateral shock is independent of off-venue spot",()=>{
 const out=evaluateVenue(fixture());
 assert.equal(out.stress_30pct_upside_margin_equity_usd,7000);
 assert.equal(out.stress_50pct_upside_margin_equity_usd,5000);
 assert.equal(out.stress_100pct_upside_margin_equity_usd,0);
});
test("unsupported markets, windows, fees and incomplete tails fail closed",()=>{
 assert.throws(()=>evaluateVenue(fixture({coin:"DOGE"})),/Unsupported/);
 assert.throws(()=>evaluateVenue(fixture({days:31})),/Unsupported/);
 assert.throws(()=>evaluateVenue(fixture({spotFeeBps:-1})),/Invalid/);
 const x=fixture();x.funding.pop();
 assert.throws(()=>evaluateVenue(x),/tail/);
});
