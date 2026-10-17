/** Read-only OKX mark-price risk overlay; current public tiers are NOT historical. */
export type MarkCandle={time:number;open:number;high:number;low:number;close:number};
export type TierSnapshot={instId:string;tdMode:"isolated";fetchedAt:string;ctVal:number;ctValCcy:string;ctMult:number;tiers:{tier:string;maxSz:number;mmr:number}[]};
export type MarkRiskInput={coin:"XRP"|"BTC"|"ETH";start:number;end:number;notionalUsd:number;entryPerp:number;markCandles:MarkCandle[];funding:{time:number;rate:number}[];tierSnapshot:TierSnapshot;assumedLiquidationTakerFeeRate:number};
const H=3600000,DAY=86400000,round=(x:number)=>Number(x.toFixed(2));
export function selectTier(s:TierSnapshot,coin:"XRP"|"BTC"|"ETH",qty:number){
 if(s.instId!==coin+"-USDT-SWAP"||s.tdMode!=="isolated"||s.ctValCcy!==coin||
  !(s.ctVal>0&&s.ctMult>0)||!Number.isFinite(Date.parse(s.fetchedAt))||
  !Array.isArray(s.tiers)||!s.tiers.length)throw Error("Unsupported isolated tier metadata");
 const contracts=qty/(s.ctVal*s.ctMult);
 let last=0;
 for(const t of s.tiers){
  if(!(t.maxSz>last&&t.mmr>0&&t.mmr<=.2))throw Error("Invalid tier");
  if(contracts<=t.maxSz)return {contracts,mmr:t.mmr,tier:t.tier};
  last=t.maxSz;
 }
 throw Error("Position exceeds tier snapshot");
}
export function evaluateMarkRisk(x:MarkRiskInput){
 if(!["XRP","BTC","ETH"].includes(x.coin)||!Number.isSafeInteger(x.start)||
    !Number.isSafeInteger(x.end)||x.start%H||x.end%H||
    ![30,90].includes((x.end-x.start)/DAY))throw Error("Invalid mark window");
 const hours=(x.end-x.start)/H;
 if(!Array.isArray(x.markCandles)||x.markCandles.length!==hours)throw Error("Incomplete mark candles");
 if(!Number.isFinite(x.notionalUsd)||x.notionalUsd<100||
    !Number.isFinite(x.entryPerp)||x.entryPerp<=0||
    !Number.isFinite(x.assumedLiquidationTakerFeeRate)||
    x.assumedLiquidationTakerFeeRate<0||x.assumedLiquidationTakerFeeRate>.01)
    throw Error("Invalid position or liquidation fee assumption");
 const qty=x.notionalUsd/x.entryPerp,tier=selectTier(x.tierSnapshot,x.coin,qty);
 if(!Array.isArray(x.funding)||!x.funding.length)throw Error("Missing funding");
 const rates=new Map<number,number>();let last=x.start;
 for(const row of [...x.funding].sort((a,b)=>a.time-b.time)){
  if(!Number.isSafeInteger(row.time)||row.time<=last||row.time>x.end||
    row.time-last>8*H+60000||!Number.isFinite(row.rate)||Math.abs(row.rate)>.04)
    throw Error("Invalid funding gap or rate");
  rates.set(row.time,row.rate);last=row.time;
 }
 if(x.end-last>=8*H)throw Error("Funding tail missing");
 let accrued=0,minBuffer=Infinity,firstBreach:string|null=null,maxMark=0;
 for(let i=0;i<hours;i++){
  const row=x.markCandles[i],time=x.start+i*H;
  if(!row||row.time!==time)throw Error("Missing or unordered mark candle");
  if(![row.open,row.high,row.low,row.close].every(n=>typeof n==="number"&&Number.isFinite(n)&&n>0)||
    row.high<Math.max(row.open,row.close)||row.low>Math.min(row.open,row.close))
    throw Error("Invalid mark OHLC");
  const high=row.high;maxMark=Math.max(maxMark,high);
  const equity=x.notionalUsd+qty*(x.entryPerp-high)+accrued;
  const reserve=qty*high*(tier.mmr+x.assumedLiquidationTakerFeeRate);
  const buffer=equity-reserve;
  minBuffer=Math.min(minBuffer,buffer);
  if(buffer<=0&&firstBreach===null)firstBreach=new Date(time+H).toISOString();
  accrued+=qty*row.close*(rates.get(time+H)??0);
 }
 return {execution_mode:"paper" as const,live_allowed:false as const,
  status:firstBreach?"mark_margin_buffer_breach_proxy" as const:"no_mark_buffer_breach_observed_proxy" as const,
  provenance:"current_tier_retrospective_scenario_not_historical_tier" as const,
  coin:x.coin,days:hours/24,hourly_mark_candles:hours,
  tier_fetched_at:x.tierSnapshot.fetchedAt,current_tier:tier.tier,
  contract_count:Number(tier.contracts.toFixed(6)),
  maintenance_rate_pct:Number((tier.mmr*100).toFixed(4)),
  assumed_liquidation_taker_fee_pct:Number((x.assumedLiquidationTakerFeeRate*100).toFixed(4)),
  first_possible_buffer_breach_utc:firstBreach,
  minimum_mark_based_margin_buffer_usd:round(minBuffer),
  maximum_observed_hourly_mark_high:maxMark,
  historical_liquidation_confirmed:false as const,
  actual_liquidation_fee_verified:false as const,
  warnings:[
   "Current tier applied retrospectively; historical maintenance tiers unverified.",
   "Hourly mark high is not a tick-level liquidation event or executable price.",
   "Actual account fee tier and clearance fees not known; taker liquidation fee assumed.",
   "Funding USD approximated from hourly mark close, not settlement mark.",
   "Positive margin buffer does not establish liquidation safety."
  ]};
}
