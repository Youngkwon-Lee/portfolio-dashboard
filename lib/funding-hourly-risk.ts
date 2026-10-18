/**
 * Read-only hourly path risk model.
 * Observed hourly candles are NOT executable prices or a venue liquidation engine.
 * If isolated margin crosses an assumed maintenance buffer, all subsequent
 * "held-to-end" returns are suppressed: no fictitious survival/forced fill.
 */
import {evaluateVenue,type VenueInput} from "./funding-venues.ts";
const HOUR=3600000,DAY=86400000;
export type HourCandle={
  time:number;
  spot:{open:number;high:number;low:number;close:number};
  perp:{open:number;high:number;low:number;close:number};
};
export type HourlyPathInput=Omit<VenueInput,"entry"|"exit"> & {
  maintenanceMarginRate:number; // assumption, decimal e.g. .005
  candles:HourCandle[];
};
export type HourlyPoint={
  time:string;spotClose:number;perpClose:number;basisPct:number;
  fundingUsd:number;isolatedMarginEquityUsd:number;
  maintenanceRequirementUsd:number;marginBufferUsd:number;
  hedgedEquityUsd:number;hedgedNetUsd:number;
};
export type HourlyRiskResult={
  execution_mode:"paper";live_allowed:false;provenance:"user_supplied_unverified";
  venue:string;coin:string;days:30|90;hourly_candles:number;funding_events:number;
  status:"margin_buffer_breach_proxy"|"no_breach_observed_proxy";
  first_breach_utc:string|null;lowest_margin_buffer_usd:number;
  min_isolated_margin_equity_usd:number;max_portfolio_drawdown_pct:number;
  funding_usd:number;basis_pnl_usd:number;estimated_hold_to_end_net_usd:number|null;
  estimated_hold_to_end_return_pct:number|null;capital_committed_usd:number;
  assumptions:string[];daily_curve:HourlyPoint[];
};
const finite=(x:number,name:string)=>{
 if(typeof x!=="number"||!Number.isFinite(x))throw Error("Invalid "+name);
 return x;
};
const positive=(x:number,name:string)=>{
 if(finite(x,name)<=0)throw Error("Invalid "+name);
 return x;
};
const money=(n:number)=>Number(n.toFixed(2));
const percent=(n:number)=>Number(n.toFixed(4));
function checkOHLC(x:HourCandle["spot"],label:string){
 const o=positive(x.open,label+" open"),c=positive(x.close,label+" close");
 const h=positive(x.high,label+" high"),l=positive(x.low,label+" low");
 if(h<Math.max(o,c)||l>Math.min(o,c)||h<l)throw Error("Inconsistent "+label+" OHLC");
}
export function evaluateHourlyPath(input:HourlyPathInput):HourlyRiskResult{
 const x=input;
 if(!["Binance","Bybit","OKX"].includes(x.venue))throw Error("Unsupported hourly venue");
 if(x.maintenanceMarginRate<0||x.maintenanceMarginRate>0.1||
    !Number.isFinite(x.maintenanceMarginRate))throw Error("Invalid assumed maintenance margin");
 const hours=x.days*24;
 if(![30,90].includes(x.days)||!Array.isArray(x.candles)||
    x.candles.length!==hours)throw Error("Incomplete hourly candle coverage");
 if(!Number.isSafeInteger(x.start)||!Number.isSafeInteger(x.end)||
    x.start%HOUR||x.end%HOUR||x.end-x.start!==hours*HOUR)
    throw Error("Invalid hourly UTC window");
 for(let i=0;i<hours;i++){
   const row=x.candles[i];
   if(!row||row.time!==x.start+i*HOUR)throw Error("Missing, duplicated or unordered hourly candle");
   if(!row.spot||!row.perp)throw Error("Missing spot/perp candle");
   checkOHLC(row.spot,"spot");checkOHLC(row.perp,"perp");
 }
 const first=x.candles[0],last=x.candles.at(-1)!;
 const entry={time:x.start,spot:first.spot.open,perp:first.perp.open};
 const exit={time:x.end,spot:last.spot.close,perp:last.perp.close};
 // Reuse existing strict settlement continuity and fee checks.
 const baseline=evaluateVenue({...x,entry,exit});
 if(baseline.status!=="basis_verified")throw Error("Basis unavailable");
 const qty=x.notionalUsd/first.perp.open;
 const spotCapital=qty*first.spot.open,marginCapital=x.notionalUsd;
 const capital=spotCapital+marginCapital;
 const feeSpot=x.spotFeeBps/10000,feePerp=x.perpFeeBps/10000,slip=x.slippageBps/10000;
 const openingCosts=qty*(first.spot.open*(feeSpot+slip)+first.perp.open*(feePerp+slip));
 const openingPerpCosts=qty*first.perp.open*(feePerp+slip);
 // Funding can post milliseconds after UTC boundary. Normalize only <=60s
 // after the exact hour, rejecting any other ambiguous timestamps.
 const events=new Map<number,number>();
 for(const row of x.funding){
   if(!Number.isSafeInteger(row.time)||!Number.isFinite(row.rate)||
      Math.abs(row.rate)>.04)throw Error("Invalid funding settlement");
   const floor=Math.floor(row.time/HOUR)*HOUR,lag=row.time-floor;
   const hour=lag===0?row.time:lag<=60000?floor:NaN;
   if(!Number.isFinite(hour)||hour<=x.start||hour>x.end||events.has(hour))
     throw Error("Ambiguous or duplicate funding settlement hour");
   events.set(hour,row.rate);
 }
 let fundingUsd=0,firstBreach:string|null=null,minimumBuffer=Infinity,minimumEquity=Infinity;
 let highWater=capital-openingCosts,maxDrawdown=0;
 const daily:HourlyPoint[]=[];
 for(let i=0;i<hours;i++){
   const row=x.candles[i],end=row.time+HOUR;
   const fundingBefore=fundingUsd;
   // Worst intrahour high occurs before that hour's funding settlement:
   // deliberately do not credit it early. This is a stress approximation.
   const adversePerp=row.perp.high;
   const shortEquityHigh=marginCapital+qty*(first.perp.open-adversePerp)+fundingBefore-openingPerpCosts;
   const maintenanceHigh=qty*adversePerp*x.maintenanceMarginRate;
   const bufferHigh=shortEquityHigh-maintenanceHigh;
   minimumBuffer=Math.min(minimumBuffer,bufferHigh);
   minimumEquity=Math.min(minimumEquity,shortEquityHigh);
   if(bufferHigh<=0&&firstBreach===null)firstBreach=new Date(end).toISOString();
   const rate=events.get(end)??0;
   // Mark/settlement oracle is unavailable: perp candle close is a proxy.
   fundingUsd+=qty*row.perp.close*rate;
   const shortPnl=qty*(first.perp.open-row.perp.close);
   const spotPnl=qty*(row.spot.close-first.spot.open);
   const closeCosts=qty*(row.spot.close*(feeSpot+slip)+row.perp.close*(feePerp+slip));
   const net=spotPnl+shortPnl+fundingUsd-openingCosts-closeCosts;
   const hedgedEquity=capital+net;
   highWater=Math.max(highWater,hedgedEquity);
   maxDrawdown=Math.max(maxDrawdown,(highWater-hedgedEquity)/highWater*100);
   if((i+1)%24===0){
     const shortEquityClose=marginCapital+shortPnl+fundingUsd-openingPerpCosts;
     daily.push({
       time:new Date(end).toISOString(),spotClose:row.spot.close,perpClose:row.perp.close,
       basisPct:percent((row.spot.close/row.perp.close-1)*100),
       fundingUsd:money(fundingUsd),isolatedMarginEquityUsd:money(shortEquityClose),
       maintenanceRequirementUsd:money(qty*row.perp.close*x.maintenanceMarginRate),
       marginBufferUsd:money(shortEquityClose-qty*row.perp.close*x.maintenanceMarginRate),
       hedgedEquityUsd:money(hedgedEquity),hedgedNetUsd:money(net)
     });
   }
 }
 const lastPoint=daily.at(-1)!;
 return {
   execution_mode:"paper",live_allowed:false,provenance:"user_supplied_unverified",
   venue:x.venue,coin:x.coin,days:x.days,hourly_candles:hours,funding_events:events.size,
   status:firstBreach?"margin_buffer_breach_proxy":"no_breach_observed_proxy",
   first_breach_utc:firstBreach,lowest_margin_buffer_usd:money(minimumBuffer),
   min_isolated_margin_equity_usd:money(minimumEquity),
   max_portfolio_drawdown_pct:percent(maxDrawdown),
   funding_usd:money(fundingUsd),
   basis_pnl_usd:money(qty*((last.spot.close-last.perp.close)-(first.spot.open-first.perp.open))),
   estimated_hold_to_end_net_usd:firstBreach?null:lastPoint.hedgedNetUsd,
   estimated_hold_to_end_return_pct:firstBreach?null:percent(lastPoint.hedgedNetUsd/capital*100),
   capital_committed_usd:money(capital),
   assumptions:[
     "Hourly spot/perp OHLC are user-supplied and not authenticated against an exchange.",
     "Intrahour spot/perp highs and lows are not synchronous; high-based isolated short margin stress is conservative, not exact liquidation.",
     "Maintenance margin rate is a user assumption, not a venue/risk-tier-specific liquidation formula.",
     "Isolated short collateral cannot automatically draw on off-venue spot gains.",
     "Funding USD uses perp candle close, not exchange oracle/mark settlement price; fees and slippage are assumed.",
     "If the assumed margin buffer is breached, held-to-end returns are hidden rather than assuming the short survived.",
     "Funding posts only at each settlement boundary; funding within an hour cannot protect against that hour's adverse high.",
     "Excludes insurance fund/ADL, borrow costs, transfer delays, stablecoin depeg, gas, FX/KRW, tax and true order-book liquidity."
   ],
   daily_curve:daily
 };
}
