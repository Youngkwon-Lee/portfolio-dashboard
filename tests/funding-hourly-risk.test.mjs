import test from "node:test";
import assert from "node:assert/strict";
import {evaluateHourlyPath} from "../lib/funding-hourly-risk.ts";
const H=3600000,START=Date.parse("2026-07-01T00:00:00Z");
function fixture({days=30,price=100,high=100,maintenanceMarginRate=.005,spotClose=100,perpClose=100}={}){
 const hours=days*24,end=START+hours*H;
 const candles=Array.from({length:hours},(_,i)=>({
   time:START+i*H,
   spot:{open:price,high:Math.max(price,spotClose),low:Math.min(price,spotClose),close:spotClose},
   perp:{open:price,high:Math.max(high,price,perpClose),low:Math.min(price,perpClose),close:perpClose}
 }));
 const funding=Array.from({length:days*3},(_,i)=>({time:START+(i+1)*8*H,rate:.0001}));
 return {venue:"OKX",coin:"XRP",days,start:START,end,notionalUsd:10000,
   spotFeeBps:10,perpFeeBps:5,slippageBps:5,maintenanceMarginRate,candles,funding};
}
test("30-day complete path computes real hourly basis, fees, and positive buffer",()=>{
 const result=evaluateHourlyPath(fixture());
 assert.equal(result.execution_mode,"paper");
 assert.equal(result.live_allowed,false);
 assert.equal(result.provenance,"user_supplied_unverified");
 assert.equal(result.status,"no_breach_observed_proxy");
 assert.equal(result.hourly_candles,720);
 assert.equal(result.funding_events,90);
 assert.equal(result.daily_curve.length,30);
 assert.equal(result.funding_usd,90);
 assert.equal(result.basis_pnl_usd,0);
 assert.ok(result.estimated_hold_to_end_net_usd<90);
 assert.ok(result.estimated_hold_to_end_return_pct!==null);
});
test("90-day path has 2160 candles and 270 actual 8h settlements",()=>{
 const result=evaluateHourlyPath(fixture({days:90}));
 assert.equal(result.hourly_candles,2160);
 assert.equal(result.funding_events,270);
 assert.equal(result.daily_curve.length,90);
});
test("intrahour spike breaches margin even if close recovers, no fictional hold-to-end profit",()=>{
 const x=fixture();
 x.candles[4].perp.high=210;
 const r=evaluateHourlyPath(x);
 assert.equal(r.status,"margin_buffer_breach_proxy");
 assert.equal(r.first_breach_utc,new Date(START+5*H).toISOString());
 assert.equal(r.estimated_hold_to_end_net_usd,null);
 assert.equal(r.estimated_hold_to_end_return_pct,null);
});
test("funding at end of spike hour cannot be credited before the high",()=>{
 const x=fixture();
 x.candles[7].perp.high=200;
 x.funding[0].rate=.04; // very large payment, posts only after the adverse high
 const r=evaluateHourlyPath(x);
 assert.equal(r.status,"margin_buffer_breach_proxy");
});
test("margin rate assumption changes stress threshold, not venue liquidation engine",()=>{
 const a=fixture({high:198,maintenanceMarginRate:0});
 const b=fixture({high:198,maintenanceMarginRate:.03});
 assert.equal(evaluateHourlyPath(a).status,"no_breach_observed_proxy");
 assert.equal(evaluateHourlyPath(b).status,"margin_buffer_breach_proxy");
});
test("incomplete and unordered spot/perp hourly candles are rejected",()=>{
 const a=fixture();a.candles.splice(12,1);
 assert.throws(()=>evaluateHourlyPath(a),/Incomplete/);
 const b=fixture();b.candles[12].time=b.candles[11].time;
 assert.throws(()=>evaluateHourlyPath(b),/Missing, duplicated/);
});
test("invalid OHLC, negative prices, invalid funding and missing settlement rejected",()=>{
 const a=fixture();a.candles[0].spot.high=90;
 assert.throws(()=>evaluateHourlyPath(a),/Inconsistent/);
 const b=fixture();b.candles[0].perp.low=-1;
 assert.throws(()=>evaluateHourlyPath(b),/Invalid/);
 const c=fixture();c.funding.splice(10,1);
 assert.throws(()=>evaluateHourlyPath(c),/gap/);
});
test("synthetic equal spot/perp paths cannot be mistaken for exchange-verified observations",()=>{
 const x=fixture({spotClose:110,perpClose:112});
 const r=evaluateHourlyPath(x);
 assert.equal(r.provenance,"user_supplied_unverified");
 assert.equal(r.basis_pnl_usd,-200);
});
test("Hyperliquid and invalid maintenance assumption fail closed",()=>{
 const a=fixture();a.venue="Hyperliquid";
 assert.throws(()=>evaluateHourlyPath(a),/Unsupported hourly venue/);
 const b=fixture({maintenanceMarginRate:.2});
 assert.throws(()=>evaluateHourlyPath(b),/Invalid assumed/);
});
