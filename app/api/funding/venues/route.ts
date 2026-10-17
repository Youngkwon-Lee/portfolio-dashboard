/** Public exchange data only: GET/Hyperliquid public info; no credentials or trading endpoints. */
import {NextRequest,NextResponse} from "next/server";
import {evaluateVenue,type Venue,type Asset,type Settlement,type SpotPerpSnapshot} from "@/lib/funding-venues";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=60;
const HOUR=3600000;
const providers:Venue[]=["Hyperliquid","Binance","Bybit","OKX"];
const coinList:Asset[]=["BTC","ETH","XRP"];
const fees={spot:10,perp:5,slippage:5};
async function json(url:string,body?:unknown):Promise<any>{
  const res=await fetch(url,{method:body?"POST":"GET",
    headers:{"Accept":"application/json",...(body?{"Content-Type":"application/json"}:{})},
    ...(body?{body:JSON.stringify(body)}:{}),
    cache:"no-store",signal:AbortSignal.timeout(12000)});
  if(!res.ok)throw Error("Exchange public API HTTP "+res.status);
  return res.json();
}
function parseRate(x:unknown):number{
  if((typeof x!=="number"&&typeof x!=="string")||String(x).trim()==="")throw Error("Missing funding rate");
  const n=Number(x);if(!Number.isFinite(n)||Math.abs(n)>.04)throw Error("Invalid funding rate");
  return n;
}
function parseTime(x:unknown):number{
  const n=Number(x);if(!Number.isSafeInteger(n)||n<1e12)throw Error("Invalid funding timestamp");
  return n;
}
function parsePrice(x:unknown):number{
  const n=Number(x);if(!Number.isFinite(n)||n<=0)throw Error("Invalid price");
  return n;
}
async function hyper(coin:Asset,start:number,end:number):Promise<Settlement[]>{
  const rows:Settlement[]=[];let cursor=start+1;
  for(let i=0;i<7&&cursor<=end+60000;i++){
    const data=await json("https://api.hyperliquid.xyz/info",{
      type:"fundingHistory",coin,startTime:cursor,endTime:end+60000});
    if(!Array.isArray(data)||data.length>500)throw Error("Invalid Hyperliquid page");
    if(!data.length)break;
    let last=cursor-1;
    for(const x of data){
      const t=parseTime(x.time);
      if(t<cursor||t<=last)throw Error("Unsorted Hyperliquid funding");
      rows.push({time:t,rate:parseRate(x.fundingRate)});last=t;
    }
    cursor=last+1;if(data.length<500)break;
  }
  return rows.filter(x=>x.time>start&&x.time<=end+60000);
}
async function binance(coin:Asset,start:number,end:number):Promise<Settlement[]>{
  const symbol=coin+"USDT",rows:Settlement[]=[];let cursor=start;
  for(let page=0;page<5&&cursor<=end;page++){
    const qs=new URLSearchParams({symbol,startTime:String(cursor),endTime:String(end),limit:"1000"});
    const data=await json("https://fapi.binance.com/fapi/v1/fundingRate?"+qs);
    if(!Array.isArray(data)||data.length>1000)throw Error("Invalid Binance funding");
    if(!data.length)break;
    let last=cursor-1;
    for(const x of data){
      const t=parseTime(x.fundingTime);
      if(t<cursor||t<=last)throw Error("Unsorted Binance funding");
      rows.push({time:t,rate:parseRate(x.fundingRate)});last=t;
    }
    cursor=last+1;if(data.length<1000)break;
  }
  return rows.filter(x=>x.time>start&&x.time<=end);
}
async function bybit(coin:Asset,start:number,end:number):Promise<Settlement[]>{
  const rows:Settlement[]=[];let cursor=end;
  for(let page=0;page<15&&cursor>=start;page++){
    const qs=new URLSearchParams({category:"linear",symbol:coin+"USDT",
      startTime:String(start),endTime:String(cursor),limit:"200"});
    const data=await json("https://api.bybit.com/v5/market/funding/history?"+qs);
    if(data?.retCode!==0||!Array.isArray(data?.result?.list))throw Error("Bybit funding unavailable");
    const batch=data.result.list;
    if(!batch.length)break;
    let oldest=cursor+1;
    for(const x of batch){
      const t=parseTime(x.fundingRateTimestamp);
      if(t>cursor||t>=oldest)throw Error("Unsorted Bybit funding");
      rows.push({time:t,rate:parseRate(x.fundingRate)});oldest=t;
    }
    cursor=oldest-1;if(batch.length<200)break;
  }
  return rows.filter(x=>x.time>start&&x.time<=end);
}
async function okx(coin:Asset,start:number,end:number):Promise<Settlement[]>{
  const rows:Settlement[]=[];let cursor=end+8*HOUR;
  for(let page=0;page<15&&cursor>start;page++){
    const qs=new URLSearchParams({instId:coin+"-USDT-SWAP",after:String(cursor),limit:"100"});
    const data=await json("https://www.okx.com/api/v5/public/funding-rate-history?"+qs);
    if(data?.code!=="0"||!Array.isArray(data.data))throw Error("OKX funding unavailable");
    const batch=data.data;if(!batch.length)break;
    let oldest=cursor;
    for(const x of batch){
      const t=parseTime(x.fundingTime);
      if(t>=cursor||t>=oldest)throw Error("Unsorted OKX funding");
      rows.push({time:t,rate:parseRate(x.realizedRate??x.fundingRate)});oldest=t;
    }
    cursor=oldest;if(batch.length<100)break;
  }
  return rows.filter(x=>x.time>start&&x.time<=end);
}
async function binanceCandle(symbol:string,kind:"spot"|"perp",time:number):Promise<number>{
  const base=kind==="spot"?"https://api.binance.com/api/v3/klines":
    "https://fapi.binance.com/fapi/v1/klines";
  const qs=new URLSearchParams({symbol,interval:"1h",startTime:String(time),
    endTime:String(time+HOUR-1),limit:"1"});
  const data=await json(base+"?"+qs);
  if(!Array.isArray(data)||data.length!==1||Number(data[0][0])!==time)
    throw Error("Binance historical candle missing");
  return parsePrice(data[0][1]); // same-hour open for both legs
}
async function bybitCandle(symbol:string,kind:"spot"|"perp",time:number):Promise<number>{
  const qs=new URLSearchParams({category:kind==="spot"?"spot":"linear",symbol,
    interval:"60",start:String(time),end:String(time+HOUR-1),limit:"1"});
  const data=await json("https://api.bybit.com/v5/market/kline?"+qs);
  const row=data?.result?.list?.[0];
  if(data?.retCode!==0||!row||Number(row[0])!==time)throw Error("Bybit historical candle missing");
  return parsePrice(row[1]);
}
async function okxCandle(instId:string,time:number):Promise<number>{
  // OKX history-candles 'after' pages earlier than the specified timestamp.
  const qs=new URLSearchParams({instId,bar:"1H",after:String(time+HOUR),limit:"2"});
  const data=await json("https://www.okx.com/api/v5/market/history-candles?"+qs);
  if(data?.code!=="0"||!Array.isArray(data.data))throw Error("OKX candle unavailable");
  const row=data.data.find((x:unknown)=>Array.isArray(x)&&Number(x[0])===time);
  if(!row)throw Error("OKX historical candle missing");
  return parsePrice(row[1]);
}
async function snapshot(venue:Venue,coin:Asset,time:number):Promise<SpotPerpSnapshot|null>{
  if(venue==="Hyperliquid"){
    // Hyperliquid FXRP is not native XRP, and spot symbols require separate
    // market metadata. Never silently treat a perp price as an executable spot price.
    return null;
  }
  const symbol=coin+"USDT";
  let spot:Promise<number>,perp:Promise<number>;
  if(venue==="Binance"){
    spot=binanceCandle(symbol,"spot",time);perp=binanceCandle(symbol,"perp",time);
  }else if(venue==="Bybit"){
    spot=bybitCandle(symbol,"spot",time);perp=bybitCandle(symbol,"perp",time);
  }else{
    spot=okxCandle(coin+"-USDT",time);perp=okxCandle(coin+"-USDT-SWAP",time);
  }
  const [s,p]=await Promise.all([spot,perp]);
  return {time,spot:s,perp:p};
}
async function venueResult(venue:Venue,coin:Asset,days:30|90,start:number,end:number,notional:number,
  spotFee:number,perpFee:number,slippage:number){
  try{
    const rows=await ({Hyperliquid:hyper,Binance:binance,Bybit:bybit,OKX:okx}[venue])(coin,start,end);
    // Basis snapshot failures must be visible, never silently assume spot == perp.
    let entry:SpotPerpSnapshot|null=null,exit:SpotPerpSnapshot|null=null,basisError:string|null=null;
    if(venue!=="Hyperliquid"){
      try{[entry,exit]=await Promise.all([snapshot(venue,coin,start),snapshot(venue,coin,end-HOUR)]);}
      catch{basisError="현물·선물 동시간대 과거 가격을 확인하지 못함";}
    }else basisError="현물·선물 실제 베이시스 미지원 (FXRP 포함 토큰별 검증 필요)";
    const value=evaluateVenue({venue,coin,days,start,end,notionalUsd:notional,
      spotFeeBps:spotFee,perpFeeBps:perpFee,slippageBps:slippage,funding:rows,entry,exit});
    return {...value,basis_warning:basisError};
  }catch{
    return {venue,coin,days,execution_mode:"paper" as const,live_allowed:false as const,
      status:"unavailable" as const,error:"정산 내역의 시간 범위·완전성 또는 공개 API를 검증하지 못했습니다. 수익률은 표시하지 않습니다."};
  }
}
function param(p:URLSearchParams,key:string,fallback:number,min:number,max:number):number|null{
  const raw=p.get(key);if(raw===null)return fallback;
  if(!/^\d+(?:\.\d+)?$/.test(raw))return null;
  const n=Number(raw);return Number.isFinite(n)&&n>=min&&n<=max?n:null;
}
export async function GET(req:NextRequest){
  const p=req.nextUrl.searchParams,coin=p.get("coin")??"XRP";
  const days=param(p,"days",30,30,90);
  const notional=param(p,"notional",10000,100,1e6);
  const spotFee=param(p,"spotFeeBps",fees.spot,0,100);
  const perpFee=param(p,"perpFeeBps",fees.perp,0,100);
  const slippage=param(p,"slippageBps",fees.slippage,0,100);
  if(!coinList.includes(coin as Asset)||(days!==30&&days!==90)||
    notional===null||spotFee===null||perpFee===null||slippage===null)
    return NextResponse.json({error:"유효 범위: BTC/ETH/XRP, 30·90일, $100–$1m, 0–100bps"},{status:400});
  const end=Math.floor(Date.now()/HOUR)*HOUR,start=end-days*86400000;
  const results=await Promise.all(providers.map(v=>venueResult(v,coin as Asset,days as 30|90,start,end,
    notional,spotFee,perpFee,slippage)));
  return NextResponse.json({
    execution_mode:"paper",live_allowed:false,coin,days,start_utc:new Date(start).toISOString(),
    end_utc:new Date(end).toISOString(),notional_usd:notional,
    venue_results:results,
    warning:"과거 펀딩비 및 동시간대 캔들 시가 기반 모의 계산. 실현손익·원화 생활비·청산 가격 아님."
  },{headers:{"Cache-Control":"public, s-maxage=300, stale-while-revalidate=60"}});
}
