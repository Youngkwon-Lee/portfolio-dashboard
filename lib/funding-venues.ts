/** Paper-only, venue-agnostic comparison. No orders, credentials or wallet data. */
export type Venue = "Hyperliquid"|"Binance"|"Bybit"|"OKX";
export type Asset = "BTC"|"ETH"|"XRP";
export type WindowDays = 30|90;
export type Settlement = {time:number;rate:number};
export type SpotPerpSnapshot = {time:number;spot:number;perp:number};
export type VenueInput = {
  venue:Venue; coin:Asset; days:WindowDays; start:number; end:number;
  notionalUsd:number; spotFeeBps:number; perpFeeBps:number; slippageBps:number;
  funding:Settlement[]; entry?:SpotPerpSnapshot|null; exit?:SpotPerpSnapshot|null;
};
export type VenueComparison = {
  venue:Venue;coin:Asset;days:WindowDays;execution_mode:"paper";live_allowed:false;
  status:"basis_verified"|"funding_only";
  settlement_count:number;funding_sum_pct:number;annualized_funding_pct:number;
  funding_estimate_usd:number;basis_entry_pct:number|null;basis_exit_pct:number|null;
  basis_pnl_usd:number|null;fees_usd:number|null;slippage_usd:number|null;
  estimated_net_usd:number|null;total_capital_usd:number|null;
  return_on_total_capital_pct:number|null;
  stress_30pct_upside_margin_equity_usd:number;
  stress_50pct_upside_margin_equity_usd:number;
  stress_100pct_upside_margin_equity_usd:number;
  risks:string[];limitations:string[];
};
const HOUR=3600000,DAY=86400000;
const round=(n:number,d=4)=>Number(n.toFixed(d));
function bounded(n:number,min:number,max:number,name:string){
  if(!Number.isFinite(n)||n<min||n>max)throw Error("Invalid "+name);
  return n;
}
export function evaluateVenue(x:VenueInput):VenueComparison{
  if(!["Hyperliquid","Binance","Bybit","OKX"].includes(x.venue)||
     !["BTC","ETH","XRP"].includes(x.coin)||![30,90].includes(x.days))throw Error("Unsupported venue/asset/window");
  if(!Number.isSafeInteger(x.start)||!Number.isSafeInteger(x.end)||
     x.start%HOUR||x.end%HOUR||x.end-x.start!==x.days*DAY)throw Error("Invalid time window");
  const notional=bounded(x.notionalUsd,100,1e6,"notional");
  const sf=bounded(x.spotFeeBps,0,100,"spot fee")/1e4;
  const pf=bounded(x.perpFeeBps,0,100,"perp fee")/1e4;
  const slip=bounded(x.slippageBps,0,100,"slippage")/1e4;
  const maxGap=x.venue==="Hyperliquid"?HOUR:8*HOUR;
  if(!Array.isArray(x.funding)||!x.funding.length)throw Error("Funding history missing");
  const rows=[...x.funding].sort((a,b)=>a.time-b.time);
  let previous=x.start,rateSum=0;
  for(const row of rows){
    if(!Number.isSafeInteger(row.time)||row.time<=previous||row.time>x.end+60000||
       row.time-previous>maxGap+60000||!Number.isFinite(row.rate)||Math.abs(row.rate)>0.04)
      throw Error("Funding gap, duplicate or malformed settlement");
    previous=row.time;
    rateSum+=row.rate;
  }
  if(x.end-previous>=maxGap)throw Error("Funding tail missing");
  const funding=notional*rateSum;
  const limitations=[
    "Funding USD is constant-notional estimate; actual settlement mark/oracle price and position quantity vary.",
    "Funding schedules vary by venue; only observed settlements are summed, never multiplied by assumed 8h frequency.",
    "FX/KRW, tax, borrow, bridge, gas, execution depth and venue insolvency are excluded.",
    "Stress figures are hypothetical price shocks, not an exchange maintenance-margin liquidation price."
  ];
  const risks=[
    "Spot and perpetual balances/margin may be held on different accounts or venues.",
    "1x short can be liquidated on an upside spike despite a spot hedge.",
    "Fees are editable assumptions, not verified personal VIP tiers."
  ];
  const base={
    venue:x.venue,coin:x.coin,days:x.days,execution_mode:"paper" as const,live_allowed:false as const,
    settlement_count:rows.length,funding_sum_pct:round(rateSum*100,6),
    annualized_funding_pct:round(rateSum*365/x.days*100,4),
    funding_estimate_usd:round(funding,2),
    stress_30pct_upside_margin_equity_usd:round(notional*.7,2),
    stress_50pct_upside_margin_equity_usd:round(notional*.5,2),
    stress_100pct_upside_margin_equity_usd:0,risks,limitations
  };
  if(!x.entry||!x.exit) return {
    ...base,status:"funding_only" as const,
    basis_entry_pct:null,basis_exit_pct:null,basis_pnl_usd:null,fees_usd:null,
    slippage_usd:null,estimated_net_usd:null,total_capital_usd:null,
    return_on_total_capital_pct:null,
    risks:[...risks,"No synchronized spot/perp snapshots: do not interpret funding as hedged net return."]
  };
  const a=x.entry,b=x.exit;
  if(a.time!==x.start||b.time!==x.end)throw Error("Spot/perp snapshots not time-aligned");
  for(const v of [a.spot,a.perp,b.spot,b.perp])bounded(v,1e-8,1e9,"price");
  // Equal coin quantity eliminates directional delta; spot capital is not assumed equal to perp notional.
  const qty=notional/a.perp;
  const spotCapital=qty*a.spot;
  const totalCapital=spotCapital+notional; // isolated 1x USDC short collateral
  const entryBasis=a.spot-a.perp,exitBasis=b.spot-b.perp;
  const basisPnl=qty*(exitBasis-entryBasis);
  const spotFees=qty*(a.spot+b.spot)*sf;
  const perpFees=qty*(a.perp+b.perp)*pf;
  const slippage=qty*(a.spot+b.spot+a.perp+b.perp)*slip;
  const net=funding+basisPnl-spotFees-perpFees-slippage;
  return {
    ...base,status:"basis_verified",basis_entry_pct:round(entryBasis/a.perp*100,5),
    basis_exit_pct:round(exitBasis/b.perp*100,5),basis_pnl_usd:round(basisPnl,2),
    fees_usd:round(spotFees+perpFees,2),slippage_usd:round(slippage,2),
    estimated_net_usd:round(net,2),total_capital_usd:round(totalCapital,2),
    return_on_total_capital_pct:round(net/totalCapital*100,4),
    limitations:[...limitations,
      "Spot/perp OHLCV opening/closing prices are observed market candles, not guaranteed executable fills.",
      "Only entry/exit basis is measured. Intraperiod liquidation, price spikes, funding mark and fill sequencing remain unverified."]
  };
}
