/**
 * OKX official public 1H OHLC + observed funding audit. READ ONLY.
 * Bounded historical GETs, no API keys, trading, storage, wallet or uploads.
 * One 90d collection produces 30d and 90d independent hourly stress reports.
 */
import {evaluateHourlyPath} from "../lib/funding-hourly-risk.ts";
import {evaluateMarkRisk} from "../lib/funding-okx-mark-risk.ts";
import {createHash} from "node:crypto";
const H=3600000,DAY=86400000,API="https://www.okx.com";
const coin=process.env.OKX_AUDIT_COIN||"XRP";
if(!["XRP","BTC","ETH"].includes(coin))throw Error("Unsupported coin");
const end=process.env.OKX_AUDIT_END?Date.parse(process.env.OKX_AUDIT_END):Math.floor(Date.now()/H)*H;
if(!Number.isSafeInteger(end)||end%H!==0||end>Date.now()||end<Date.now()-3*DAY)
 throw Error("End must be a recent, completed UTC hour");
const start90=end-90*DAY;
const maxRequests=80;let requests=0;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function publicGET(path,params){
 if(++requests>maxRequests)throw Error("Public request cap exceeded");
 const u=new URL(path,API);
 for(const [key,val] of Object.entries(params))u.searchParams.set(key,String(val));
 const response=await fetch(u,{headers:{Accept:"application/json"},signal:AbortSignal.timeout(12000),cache:"no-store"});
 if(!response.ok)throw Error("OKX public endpoint HTTP "+response.status);
 const data=await response.json();
 if(data?.code!=="0"||!Array.isArray(data.data))throw Error("OKX public response unavailable");
 await pause(100);
 return data.data;
}
const number=(x,label)=>{if((typeof x!=="string"&&typeof x!=="number")||String(x).trim()==="")throw Error("Invalid "+label);
 const v=Number(x);if(!Number.isFinite(v))throw Error("Invalid "+label);return v;};
async function candles(instId){
 const found=new Map();let cursor=end+H;
 for(let page=0;page<26;page++){
  const data=await publicGET("/api/v5/market/history-candles",{instId,bar:"1H",after:cursor,limit:100});
  if(!data.length)break;
  let oldest=cursor;
  for(const row of data){
   if(!Array.isArray(row)||row.length<9)throw Error("Invalid OKX candle schema");
   const t=number(row[0],"candle time");
   if(!Number.isSafeInteger(t)||t>=cursor||t>=oldest||t%H!==0)throw Error("Unordered candle page");
   oldest=t;
   if(t>=start90&&t<end){
    if(found.has(t))throw Error("Duplicate candle across pages");
    if(String(row[8])!=="1")throw Error("Unconfirmed candle");
    const [open,high,low,close]=row.slice(1,5).map(x=>number(x,"OHLC"));
    if([open,high,low,close].some(x=>x<=0)||high<Math.max(open,close)||low>Math.min(open,close))
      throw Error("Invalid OHLC");
    found.set(t,{time:t,open,high,low,close});
   }
  }
  cursor=oldest;
  if(oldest<=start90)break;
 }
 const ordered=[...found.values()].sort((a,b)=>a.time-b.time);
 if(ordered.length!==2160)throw Error(instId+" incomplete hourly history "+ordered.length+"/2160");
 for(let i=0;i<2160;i++)if(ordered[i].time!==start90+i*H)
  throw Error(instId+" hourly gap at "+i);
 return ordered;
}
async function funding(){
 const rows=[];let cursor=end+8*H;
 for(let page=0;page<6;page++){
  const data=await publicGET("/api/v5/public/funding-rate-history",{
    instId:coin+"-USDT-SWAP",after:cursor,limit:100
  });
  if(!data.length)break;
  let oldest=cursor;
  for(const row of data){
   const time=number(row?.fundingTime,"funding time");
   if(!Number.isSafeInteger(time)||time>=cursor||time>=oldest)
    throw Error("Unordered funding page");
   oldest=time;
   if(time>start90&&time<=end){
    const rate=number(row.realizedRate??row.fundingRate,"funding rate");
    if(Math.abs(rate)>.04)throw Error("Funding rate out of bounds");
    rows.push({time,rate});
   }
  }
  cursor=oldest;
  if(oldest<=start90)break;
 }
 rows.sort((a,b)=>a.time-b.time);
 for(let i=1;i<rows.length;i++)if(rows[i].time<=rows[i-1].time)throw Error("Duplicate funding");
 if(!rows.length||rows[0].time-start90>8*H+60000||end-rows.at(-1).time>=8*H)
  throw Error("Incomplete funding endpoints");
 return rows;
}
const [spot,perp,settlements]=await Promise.all([
 candles(coin+"-USDT"),candles(coin+"-USDT-SWAP"),funding()
]);
const out=[];
for(const days of [30,90]){
 const start=end-days*DAY;
 const offset=spot.length-days*24;
 const data={
  venue:"OKX",coin,days,start,end,notionalUsd:10000,
  spotFeeBps:10,perpFeeBps:5,slippageBps:5,maintenanceMarginRate:.005,
  funding:settlements.filter(x=>x.time>start&&x.time<=end),
  candles:spot.slice(offset).map((x,i)=>({
   time:x.time,
   spot:{open:x.open,high:x.high,low:x.low,close:x.close},
   perp:{open:perp[offset+i].open,high:perp[offset+i].high,
     low:perp[offset+i].low,close:perp[offset+i].close}
  }))
 };
 const result=evaluateHourlyPath(data);
 out.push({
  days,window_start:new Date(start).toISOString(),window_end:new Date(end).toISOString(),
  spot_candles:result.hourly_candles,perp_candles:result.hourly_candles,
  funding_settlements:result.funding_events,first_breach_utc:result.first_breach_utc,
  status:result.status,assumed_maintenance_margin_pct:.5,
  minimum_margin_buffer_usd:result.lowest_margin_buffer_usd,
  max_close_to_close_drawdown_pct:result.max_portfolio_drawdown_pct,
  funding_proxy_usd:result.funding_usd,basis_pnl_usd:result.basis_pnl_usd,
  estimated_net_usd:result.estimated_hold_to_end_net_usd,
  estimated_return_pct:result.estimated_hold_to_end_return_pct,
  committed_capital_usd:result.capital_committed_usd
 });
}
// Optional official mark + current tier overlay. Never silently replace missing
// mark data with last-traded price, and never claim current tiers are historical.
let markOverlay={status:"not_requested"};
if(process.env.OKX_MARK_AUDIT==="1"){
 try{
  const instId=coin+"-USDT-SWAP";
  const [tiersRaw,instruments]=await Promise.all([
   publicGET("/api/v5/public/position-tiers",{
    instType:"SWAP",tdMode:"isolated",instFamily:coin+"-USDT"
   }),
   publicGET("/api/v5/public/instruments",{instType:"SWAP",instId})
  ]);
  const inst=instruments.find(x=>x.instId===instId);
  if(!inst||inst.ctValCcy!==coin||inst.ctType!=="linear")
   throw Error("Unsupported instrument contract metadata");
  const tierSnapshot={
   instId,tdMode:"isolated",fetchedAt:new Date().toISOString(),
   ctVal:number(inst.ctVal,"ctVal"),ctValCcy:inst.ctValCcy,
   ctMult:number(inst.ctMult||"1","ctMult"),
   tiers:tiersRaw.map(x=>({
    tier:String(x.tier),maxSz:number(x.maxSz,"maxSz"),mmr:number(x.mmr,"mmr")
   })).sort((a,b)=>a.maxSz-b.maxSz)
  };
  if(!tierSnapshot.tiers.length)throw Error("No public isolated maintenance tiers");
  const found=new Map();let cursor=end+H;
  for(let page=0;page<26;page++){
   const data=await publicGET("/api/v5/market/history-mark-price-candles",{
    instId,bar:"1H",after:cursor,limit:100
   });
   if(!data.length)break;
   let oldest=cursor;
   for(const row of data){
    if(!Array.isArray(row)||row.length<6)throw Error("Invalid mark OHLC schema");
    const time=number(row[0],"mark time");
    if(!Number.isSafeInteger(time)||time>=cursor||time>=oldest||time%H)
     throw Error("Unordered mark candles");
    oldest=time;
    if(time>=start90&&time<end){
     if(found.has(time)||String(row[5])!=="1")throw Error("Duplicate or unconfirmed mark candle");
     const [open,high,low,close]=row.slice(1,5).map(x=>number(x,"mark OHLC"));
     found.set(time,{time,open,high,low,close});
    }
   }
   cursor=oldest;
   if(oldest<=start90)break;
  }
  const ordered=[...found.values()].sort((a,b)=>a.time-b.time);
  if(ordered.length!==2160)throw Error("Incomplete historical mark price candles");
  for(let i=0;i<2160;i++)if(ordered[i].time!==start90+i*H)
   throw Error("Mark-price hourly gap");
  markOverlay={
   status:"current_tier_retrospective_scenario",
   results:[30,90].map(days=>{
    const start=end-days*DAY,offset=2160-days*24;
    const v=evaluateMarkRisk({
     coin,start,end,notionalUsd:10000,entryPerp:perp[offset].open,
     markCandles:ordered.slice(offset),
     funding:settlements.filter(x=>x.time>start&&x.time<=end),
     tierSnapshot,assumedLiquidationTakerFeeRate:.0005
    });
    return v;
   })
  };
 }catch(error){
  markOverlay={status:"unavailable",reason_code:
   /HTTP/.test(String(error))?"public_endpoint_http_failure":
   /tier|instrument|contract/i.test(String(error))?"tier_snapshot_unverified":
   "mark_history_or_schema_unverified"};
 }
}
const payload={source:"OKX public market/history-candles and public/funding-rate-history",
 provenance:"public_api_observed_ohlc_not_execution_verified",
 mode:"paper",live_allowed:false,coin,request_count:requests,
 model:"hourly-high isolated short margin buffer, constant coin quantity, oracle funding proxy",
 costs:"spot 10bps, perp 5bps, slippage 5bps each side, illustrative",
 risks:"Maintenance rate .5% assumed; OHLC high/low non-synchronous; real mark-price liquidation, funding oracle, order book, FX, taxes and forced fills unverified",
 results:out,mark_overlay:markOverlay};
const hash=createHash("sha256").update(JSON.stringify(payload)).digest("hex");
console.log("OKX_HOURLY_AUDIT_RESULT "+JSON.stringify({...payload,sha256:hash}));
