import test from "node:test";
import assert from "node:assert/strict";
import {evaluateLocalBundle,parseLocalBundle} from "../lib/funding-local-import.ts";
const HOUR=3600000,START=Date.parse("2026-07-01T00:00:00Z");
function bundle(overrides={}){
 const days=30,end=START+days*24*HOUR,funding=[];
 for(let t=START+8*HOUR;t<=end;t+=8*HOUR)funding.push({time:t,rate:0.0001});
 return {format:"quant-lab-funding-bundle-v1",venue:"Binance",coin:"XRP",
  days,start:START,end,notionalUsd:10000,
  sourceUrl:"https://data.binance.vision/data/futures/um/monthly/fundingRate/XRPUSDT/",
  downloadedAt:"2026-10-17T04:00:00Z",funding,
  entry:{time:START,spot:99,perp:100},
  exit:{time:end,spot:104,perp:106},...overrides};
}
const fees={spotFeeBps:10,perpFeeBps:5,slippageBps:5};
test("local dataset is never represented as verified external exchange data",()=>{
 const out=evaluateLocalBundle(JSON.stringify(bundle()),fees);
 assert.equal(out.provenance,"user_supplied_unverified");
 assert.equal(out.result.execution_mode,"paper");
 assert.equal(out.result.live_allowed,false);
 assert.equal(out.result.settlement_count,90);
 assert.equal(out.result.status,"basis_verified");
 assert.ok(Number.isFinite(out.result.estimated_net_usd));
});
test("Bybit official claimed source accepted but not authenticated",()=>{
 const x=bundle({venue:"Bybit",sourceUrl:"https://www.bybit.com/market/data"});
 const out=evaluateLocalBundle(JSON.stringify(x),fees);
 assert.equal(out.provenance,"user_supplied_unverified");
});
test("unexpected secret fields and malformed data are rejected",()=>{
 const x=bundle();x.apiKey="sensitive";assert.throws(()=>parseLocalBundle(JSON.stringify(x)),/Unexpected/);
 const y=bundle();y.funding[0].rate="0.0001";assert.throws(()=>parseLocalBundle(JSON.stringify(y)),/Invalid funding value/);
});
test("lookalike host is not accepted",()=>{
 const x=bundle({sourceUrl:"https://data.binance.vision.attacker.invalid/x"});
 assert.throws(()=>parseLocalBundle(JSON.stringify(x)),/Official source/);
});
test("missing settlement and mismatched snapshots fail closed",()=>{
 const x=bundle();x.funding.splice(5,1);
 assert.throws(()=>evaluateLocalBundle(JSON.stringify(x),fees),/gap/);
 const y=bundle();y.exit.time-=HOUR;
 assert.throws(()=>evaluateLocalBundle(JSON.stringify(y),fees),/time-aligned/);
});
test("file size, unsupported exchange and malformed JSON rejected",()=>{
 assert.throws(()=>parseLocalBundle("x".repeat(2_000_001)),/size/);
 assert.throws(()=>parseLocalBundle("{not json"),/Invalid JSON/);
 const x=bundle({venue:"Unknown"});
 assert.throws(()=>parseLocalBundle(JSON.stringify(x)),/Unsupported/);
});
