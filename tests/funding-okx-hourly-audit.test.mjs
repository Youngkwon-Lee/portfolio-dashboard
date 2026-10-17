import test from "node:test";
import assert from "node:assert/strict";
const H=3600000,DAY=86400000;
const END=Math.floor(Date.now()/H)*H,START=END-90*DAY;
function setup({spike=false}={}){
 const candles=[];
 for(let i=0;i<2160;i++){
  const t=START+i*H;
  candles.push([String(t),"100",spike&&i===100?"220":"100","100","100","0","0","0","1"]);
 }
 const funding=[];
 for(let t=START+8*H;t<=END;t+=8*H)
  funding.push({fundingTime:String(t),realizedRate:"0.0001"});
 const old=globalThis.fetch,logs=[];
 let count=0;
 globalThis.fetch=async url=>{
  const u=new URL(url),after=Number(u.searchParams.get("after"));
  assert.equal(u.origin,"https://www.okx.com");
  assert.equal(u.searchParams.get("limit"),"100");
  count++;
  let rows;
  if(u.pathname==="/api/v5/market/history-candles"){
   rows=candles.filter(x=>Number(x[0])<after).slice(-100).reverse();
   if(u.searchParams.get("instId")?.endsWith("-USDT-SWAP")===false){
    // Spot is never spiked, so the isolated short stress is observable.
    rows=rows.map(x=>[x[0],x[1],"100",x[3],x[4],...x.slice(5)]);
   }
  }else if(u.pathname==="/api/v5/public/funding-rate-history"){
   rows=funding.filter(x=>Number(x.fundingTime)<after).slice(-100).reverse();
  }else throw Error("Unexpected URL "+u.pathname);
  return {ok:true,json:async()=>({code:"0",data:rows})};
 };
 return {restore:()=>{globalThis.fetch=old;},logs,count:()=>count};
}
async function runAudit(spike,label){
 const fixture=setup({spike});
 const original=console.log;
 let payload;
 console.log=(...args)=>{const line=args.join(" ");if(line.startsWith("OKX_HOURLY_AUDIT_RESULT "))payload=JSON.parse(line.slice("OKX_HOURLY_AUDIT_RESULT ".length));};
 try{
  process.env.OKX_AUDIT_COIN="XRP";
  process.env.OKX_AUDIT_END=new Date(END).toISOString();
  await import("../scripts/funding-okx-hourly-audit.mjs?"+label);
  assert.ok(payload,"Audit summary must be produced");
  assert.equal(payload.request_count,fixture.count());
  assert.ok(payload.request_count<=70);
  assert.equal(payload.results.length,2);
  return payload;
 }finally{
  console.log=original;
  fixture.restore();
  delete process.env.OKX_AUDIT_END;
 }
}
test("official OKX pagination adapter validates 2160 contiguous candles, 30/90 windows",async()=>{
 const p=await runAudit(false,"complete");
 assert.equal(p.mode,"paper");
 assert.equal(p.live_allowed,false);
 assert.equal(p.results[0].spot_candles,720);
 assert.equal(p.results[1].spot_candles,2160);
 assert.equal(p.results[0].funding_settlements,90);
 assert.equal(p.results[1].funding_settlements,270);
 assert.equal(p.results[1].status,"no_breach_observed_proxy");
 assert.ok(p.results[1].estimated_net_usd!==null);
});
test("real-hourly adapter suppresses held-to-end profit after intrahour short spike",async()=>{
 const p=await runAudit(true,"spike");
 for(const x of p.results){
  assert.equal(x.status,"margin_buffer_breach_proxy");
  assert.equal(x.estimated_net_usd,null);
 }
});
