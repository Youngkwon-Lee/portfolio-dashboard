/**
 * Public market data only. No user balances, secrets, authenticated endpoints,
 * trade permissions, order execution, deposits or withdrawals.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  calculateFundingSimulation, fundingResultReportable, DAY_MS, HOUR_MS,
  normalizeSettlementHour, FUNDING_SETTLEMENT_TOLERANCE_MS,
  type FundingCoin, type FundingDays, type FundingRecord, type PerpCandle
} from "@/lib/funding-model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const URL = "https://api.hyperliquid.xyz/info";

async function queryInfo(body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(URL, {
    method:"POST",
    headers:{"Content-Type":"application/json",Accept:"application/json"},
    body:JSON.stringify(body),cache:"no-store",
    signal:AbortSignal.timeout(9000),
  });
  if (!response.ok) throw Error("Public exchange data unavailable");
  return response.json();
}
function validNumber(value:string|null, fallback:number, min:number, max:number):number|null {
  if (value===null) return fallback;
  if (!/^\d+(\.\d+)?$/.test(value)) return null;
  const n=Number(value);
  return Number.isFinite(n) && n>=min && n<=max ? n : null;
}
async function fetchFunding(coin:FundingCoin,start:number,end:number):Promise<FundingRecord[]> {
  const result:FundingRecord[]=[];
  let cursor=start+1;
  // Hyperliquid time-range endpoint caps pages at 500 records.
  for (let page=0;page<7 && cursor<=end;page++){
    const raw=await queryInfo({type:"fundingHistory",coin,startTime:cursor,
      endTime:end+FUNDING_SETTLEMENT_TOLERANCE_MS});
    if (!Array.isArray(raw) || raw.length>500) throw Error("Bad funding page");
    if (raw.length===0) break;
    let maxTime=cursor-1;
    for(const item of raw){
      if(!item || !Number.isSafeInteger(item.time) || item.time<cursor || item.time>end+FUNDING_SETTLEMENT_TOLERANCE_MS
        || !Number.isFinite(Number(item.fundingRate))) throw Error("Bad funding record");
      result.push({time:item.time,fundingRate:item.fundingRate});
      maxTime=Math.max(maxTime,item.time);
    }
    if (maxTime<cursor) throw Error("Funding cursor did not advance");
    cursor=maxTime+1;
    if(raw.length<500) break;
  }
  return result.filter(v=>{
    const settledHour=normalizeSettlementHour(v.time);
    return settledHour>start && settledHour<=end;
  });
}
async function fetchCandles(coin:FundingCoin,start:number,end:number):Promise<PerpCandle[]>{
  const raw=await queryInfo({type:"candleSnapshot",req:{
    coin,interval:"1h",startTime:start,endTime:end
  }});
  if(!Array.isArray(raw) || raw.length>5000) throw Error("Bad candle response");
  return raw.filter(x=>x && x.t>=start && x.t<end).map(x=>({
    t:x.t,T:x.T,o:x.o,h:x.h,l:x.l,c:x.c
  }));
}
export async function GET(req:NextRequest){
  const p=req.nextUrl.searchParams;
  const coin=p.get("coin")??"XRP";
  const days=validNumber(p.get("days"),30,30,90);
  const amount=validNumber(p.get("notional"),10000,100,1000000);
  const spotFee=validNumber(p.get("spotFeeBps"),10,0,100);
  const perpFee=validNumber(p.get("perpFeeBps"),4.5,0,100);
  const slip=validNumber(p.get("slippageBps"),5,0,100);
  if(!["BTC","ETH","XRP"].includes(coin) || (days!==30 && days!==90)
      || amount===null || spotFee===null || perpFee===null || slip===null) {
    return NextResponse.json({error:"유효 범위: BTC/ETH/XRP, 30·90일, 명목금액 $100–$1m, 수수료 0–100bps"},{status:400});
  }
  const end=Math.floor(Date.now()/HOUR_MS)*HOUR_MS;
  const start=end-days*DAY_MS;
  try{
    const [funding,candles]=await Promise.all([
      fetchFunding(coin as FundingCoin,start,end),
      fetchCandles(coin as FundingCoin,start,end)
    ]);
    const result=calculateFundingSimulation({
      coin:coin as FundingCoin,days:days as FundingDays,notionalUsd:amount,
      spotFeeBps:spotFee,perpFeeBps:perpFee,slippageBps:slip,
      startMs:start,endMs:end,funding,candles
    });
    // A price path that exhausts the model's isolated 1x short collateral
    // cannot support an assumed-held-to-expiry PnL. Suppress any return,
    // even if the raw funding sum happens to be positive.
    if (!fundingResultReportable(result)) {
      return NextResponse.json({
        error:"시간봉 고가 기준 가상 숏 담보가 소진된 경로입니다. 실제 청산이 더 일찍 발생할 수 있어 기간 전체의 모의 수익률을 표시하지 않습니다.",
        execution_mode:"paper", live_allowed:false,
        margin_proxy_breach:true
      },{status:422,headers:{"Cache-Control":"no-store"}});
    }
    return NextResponse.json(result,{headers:{"Cache-Control":"private, no-store"}});
  }catch{
    // Fail closed. Do not extrapolate an APY when hourly coverage or upstream data fails.
    return NextResponse.json({
      error:"시간별 펀딩비·가격 자료를 완전하게 확인하지 못했습니다. 추정 수익률을 표시하지 않습니다.",
      execution_mode:"paper",live_allowed:false
    },{status:503,headers:{"Cache-Control":"no-store"}});
  }
}
