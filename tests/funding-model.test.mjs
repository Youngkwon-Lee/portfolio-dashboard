import test from "node:test";
import assert from "node:assert/strict";
import {HOUR_MS, calculateFundingSimulation, fundingResultReportable} from "../lib/funding-model.ts";

const START=Date.parse("2026-07-01T00:00:00Z");
function fixture(opts={}) {
  const days=opts.days??30, fundingRate=opts.fundingRate??0.0001;
  const p0=opts.startPrice??100, p1=opts.endPrice??100;
  const hours=days*24, candles=[],funding=[];
  for(let i=0;i<hours;i++){
    const o=p0+(p1-p0)*i/hours,c=p0+(p1-p0)*(i+1)/hours;
    const t=START+i*HOUR_MS;
    candles.push({t,T:t+HOUR_MS-1,o:String(o),c:String(c),h:String(Math.max(o,c)),l:String(Math.min(o,c))});
    funding.push({time:t+HOUR_MS,fundingRate:String(fundingRate)});
  }
  return {coin:"XRP",days,startMs:START,endMs:START+hours*HOUR_MS,notionalUsd:10000,
    spotFeeBps:0,perpFeeBps:0,slippageBps:0,funding,candles};
}
test("complete 30d hourly funding: short receives positive rates, hedged return divides by 2x capital",()=>{
  const out=calculateFundingSimulation(fixture());
  assert.equal(out.hourly_settlements,720);
  assert.equal(out.gross_funding_usd,720);
  assert.equal(out.short_net_usd,720);
  assert.equal(out.hedged_net_usd,720);
  assert.equal(out.short_return_pct,7.2);
  assert.equal(out.hedged_return_on_total_capital_pct,3.6);
  assert.equal(out.live_allowed,false);
  assert.equal(out.execution_mode,"paper");
});
test("1x unhedged short loses on upward price move while equal-unit spot hedge offsets it",()=>{
  const out=calculateFundingSimulation(fixture({fundingRate:0,endPrice:110}));
  assert.equal(out.short_price_pnl_usd,-1000);
  assert.equal(out.spot_price_pnl_usd,1000);
  assert.equal(out.short_net_usd,-1000);
  assert.equal(out.hedged_net_usd,0);
});
test("negative hourly funding makes short pay",()=>{
  const out=calculateFundingSimulation(fixture({fundingRate:-0.0001}));
  assert.equal(out.gross_funding_usd,-720);
});
test("fees and slippage are charged on entry and exit of both legs; short-only excludes spot costs",()=>{
  const out=calculateFundingSimulation({...fixture({fundingRate:0}),spotFeeBps:10,perpFeeBps:4.5,slippageBps:5});
  assert.equal(out.perp_fees_usd,9);
  assert.equal(out.spot_fees_usd,20);
  assert.equal(out.slippage_usd,20);
  assert.equal(out.short_net_usd,-19);
  assert.equal(out.hedged_net_usd,-49);
});
test("incomplete, duplicate, inconsistent data and invalid 31-day window fail closed",()=>{
  const a=fixture();a.funding.splice(0,1);
  assert.throws(()=>calculateFundingSimulation(a),/Incomplete/);
  const b=fixture();b.funding[10].time=b.funding[9].time;
  assert.throws(()=>calculateFundingSimulation(b),/duplicate/);
  const c=fixture();c.candles[0].h="1";
  assert.throws(()=>calculateFundingSimulation(c),/Inconsistent/);
  const d=fixture();d.days=31;
  assert.throws(()=>calculateFundingSimulation(d),/Unsupported/);
});
test("1x short collateral buffer can be exhausted by extreme upside",()=>{
  const out=calculateFundingSimulation(fixture({fundingRate:0,endPrice:250}));
  assert.equal(out.short_collateral_breach_in_proxy,true);
  assert.equal(out.short_margin_stress_warning,true);
});
test("90d uses 2160 actual hourly settlements, not scaled 30d yield",()=>{
  const out=calculateFundingSimulation(fixture({days:90,fundingRate:0}));
  assert.equal(out.hourly_settlements,2160);
  assert.equal(out.curve.length,91);
});

test("missing or malformed funding rates are rejected instead of becoming silent zeros",()=>{
  for(const fundingRate of [null, "", "  ", false, {}, "abc", 0.041]) {
    const bad=fixture(); bad.funding[0].fundingRate=fundingRate;
    assert.throws(()=>calculateFundingSimulation(bad),/Invalid funding rate/);
  }
  const scientific=fixture({fundingRate:"1e-5"});
  assert.ok(calculateFundingSimulation(scientific).gross_funding_usd>0);
});
test("intrahour high stress precedes that hour's funding credit",()=>{
  const input=fixture({fundingRate:0});
  input.candles[0].h="199";
  input.funding[0].fundingRate="0.04";
  const out=calculateFundingSimulation(input);
  assert.equal(out.minimum_short_equity_pct,1);
  assert.equal(out.short_margin_stress_warning,true);
});

test("real public API settlement timestamps a few milliseconds after the hour are aligned",()=>{
  const x=fixture();
  x.funding.forEach((row,i)=>{row.time += 1+(i%90);});
  const out=calculateFundingSimulation(x);
  assert.equal(out.hourly_settlements,720);
  assert.equal(out.gross_funding_usd,720);
});
test("out-of-tolerance timestamps or duplicate aligned hourly settlements fail closed",()=>{
  const late=fixture();
  late.funding[0].time += 60_001;
  assert.throws(()=>calculateFundingSimulation(late),/Invalid funding time/);
  const duplicate=fixture();
  duplicate.funding[1].time=duplicate.funding[0].time+11;
  assert.throws(()=>calculateFundingSimulation(duplicate),/duplicate/);
});
test("liquidation-like intrahour spike invalidates held-to-expiry profit, even when funding looks positive",()=>{
  const x=fixture({fundingRate:0.0001});
  x.candles[12].h="210"; // start=100, short 1x collateral=10000, adverse high=210
  const out=calculateFundingSimulation(x);
  assert.equal(out.short_collateral_breach_in_proxy,true);
  assert.ok(out.hedged_net_usd>0); // raw counterfactual must not be exposed as reportable
  assert.equal(fundingResultReportable(out),false);
  const ordinary=calculateFundingSimulation(fixture({fundingRate:0.0001}));
  assert.equal(ordinary.short_collateral_breach_in_proxy,false);
  assert.equal(fundingResultReportable(ordinary),true);
});
