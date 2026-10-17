import test from "node:test";
import assert from "node:assert/strict";
import {evaluateMarkRisk,selectTier} from "../lib/funding-okx-mark-risk.ts";
const H=3600000,START=Date.parse("2026-07-01T00:00:00Z");
function fixture({days=30,high=100,mmr=.005,fee=.0005,spike=false}={}){
 const hours=days*24,end=START+hours*H;
 return {
  coin:"XRP",start:START,end,notionalUsd:10000,entryPerp:100,
  markCandles:Array.from({length:hours},(_,i)=>({
   time:START+i*H,open:100,high:spike&&i===10?210:high,low:100,close:100
  })),
  funding:Array.from({length:days*3},(_,i)=>({time:START+(i+1)*8*H,rate:.0001})),
  tierSnapshot:{instId:"XRP-USDT-SWAP",tdMode:"isolated",
   fetchedAt:"2026-10-17T00:00:00Z",ctVal:1,ctValCcy:"XRP",ctMult:1,
   tiers:[{tier:"1",maxSz:200,mmr},{tier:"2",maxSz:1000,mmr:mmr*2}]},
  assumedLiquidationTakerFeeRate:fee
 };
}
test("30/90-day current tier retrospective mark stress and metadata",()=>{
 for(const days of [30,90]){
  const x=evaluateMarkRisk(fixture({days}));
  assert.equal(x.hourly_mark_candles,days*24);
  assert.equal(x.status,"no_mark_buffer_breach_observed_proxy");
  assert.equal(x.historical_liquidation_confirmed,false);
  assert.equal(x.actual_liquidation_fee_verified,false);
  assert.equal(x.maintenance_rate_pct,.5);
  assert.equal(x.provenance,"current_tier_retrospective_scenario_not_historical_tier");
 }
});
test("isolated short high-mark spike triggers risk proxy despite close recovery",()=>{
 const x=evaluateMarkRisk(fixture({spike:true}));
 assert.equal(x.status,"mark_margin_buffer_breach_proxy");
 assert.equal(x.first_possible_buffer_breach_utc,new Date(START+11*H).toISOString());
});
test("higher fee reserve decreases margin buffer",()=>{
 const a=evaluateMarkRisk(fixture({fee:0}));
 const b=evaluateMarkRisk(fixture({fee:.005}));
 assert.ok(b.minimum_mark_based_margin_buffer_usd<a.minimum_mark_based_margin_buffer_usd);
});
test("position tier selected by verified contract count not coin quantity alone",()=>{
 const x=fixture();
 x.tierSnapshot.ctVal=.25;
 const r=evaluateMarkRisk(x);
 assert.equal(r.current_tier,"2");
 assert.equal(r.maintenance_rate_pct,1);
});
test("invalid tiers, gaps, mark candles, missing funding fail closed",()=>{
 const a=fixture();a.tierSnapshot.ctValCcy="USDT";
 assert.throws(()=>evaluateMarkRisk(a),/Unsupported/);
 const b=fixture();b.markCandles.splice(10,1);
 assert.throws(()=>evaluateMarkRisk(b),/Incomplete/);
 const c=fixture();c.markCandles[1].high=90;
 assert.throws(()=>evaluateMarkRisk(c),/Invalid mark OHLC/);
 const d=fixture();d.funding.splice(10,1);
 assert.throws(()=>evaluateMarkRisk(d),/gap/);
});
test("invalid tier boundary, fee, unsupported size are blocked",()=>{
 const a=fixture();a.tierSnapshot.tiers[1].maxSz=100;
 assert.throws(()=>selectTier(a.tierSnapshot,"XRP",300),/Invalid tier/);
 const b=fixture({fee:.02});
 assert.throws(()=>evaluateMarkRisk(b),/Invalid position/);
 const c=fixture();c.tierSnapshot.tiers[0].maxSz=20;c.tierSnapshot.tiers[1].maxSz=50;
 assert.throws(()=>evaluateMarkRisk(c),/exceeds tier/);
});
