/** Local-only KRW safety reserve and paper funding allocation.
 * NEVER treat mockData, market watchlists, stables, or funding yield as actual cash.
 * No account fetch, wallet identifiers, API keys, order execution, or persistence.
 */
export type ReserveHolding={
  asset:string;venue:string;category:"crypto"|"stablecoin"|"staked"|"defi"|"locked";
  valueKrw:number;availableInDays:number;encumbered:boolean;
};
export type ReserveInput={
  snapshotDate:string;
  krwBankCash:number;krwBankDepositsAvailableWithin2Days:number;
  essentialMonthlyKrw:number;reserveMonths:number;nearTermObligationsKrw:number;
  fundingAllocationCapPct:number;
  holdings:ReserveHolding[];
};
export type ReserveResult={
  execution_mode:"paper";live_allowed:false;source:"user_supplied_unverified";
  safetyTargetKrw:number;eligibleCashKrw:number;safetyGapKrw:number;
  reserveCovered:boolean;reserveCoverageMonths:number|null;
  liquidCryptoKrw:number;illiquidOrEncumberedCryptoKrw:number;stablecoinExposureKrw:number;
  fundingStrategyBudgetKrw:number;spotLegBudgetKrw:number;shortCollateralBudgetKrw:number;
  deployableNow:false;notes:string[];
};
const amount=(v:number,name:string)=>{
 if(typeof v!=="number"||!Number.isFinite(v)||v<0||v>1e13)throw Error("Invalid "+name);
 return v;
};
const rounded=(v:number)=>Math.round(v);
export function evaluateReserve(x:ReserveInput):ReserveResult{
 if(!x||typeof x!=="object"||!Number.isFinite(Date.parse(x.snapshotDate))||
    x.reserveMonths<3||x.reserveMonths>24||!Number.isInteger(x.reserveMonths)||
    !Number.isFinite(x.fundingAllocationCapPct)||x.fundingAllocationCapPct<0||
    x.fundingAllocationCapPct>20||!Array.isArray(x.holdings)||x.holdings.length>100)
  throw Error("Invalid reserve snapshot");
 const cash=amount(x.krwBankCash,"bank cash")+
   amount(x.krwBankDepositsAvailableWithin2Days,"accessible deposits");
 const monthly=amount(x.essentialMonthlyKrw,"essential monthly expenses");
 if(monthly<=0)throw Error("Monthly essential spending must be provided");
 const obligations=amount(x.nearTermObligationsKrw,"near-term obligations");
 const target=monthly*x.reserveMonths+obligations;
 let liquid=0,locked=0,stables=0;
 for(const h of x.holdings){
  if(!h||typeof h.asset!=="string"||!/^[A-Za-z0-9._-]{1,24}$/.test(h.asset)||
     typeof h.venue!=="string"||h.venue.length>60||
     !["crypto","stablecoin","staked","defi","locked"].includes(h.category)||
     typeof h.encumbered!=="boolean"||!Number.isInteger(h.availableInDays)||
     h.availableInDays<0||h.availableInDays>3650)
    throw Error("Invalid holding metadata");
  const v=amount(h.valueKrw,"holding value");
  if(h.category==="stablecoin")stables+=v;
  if((h.category==="crypto"||h.category==="stablecoin")&&!h.encumbered&&h.availableInDays<=2)
    liquid+=v;
  else locked+=v;
 }
 const gap=Math.max(0,target-cash);
 // A portfolio that has not funded its bank-cash safety reserve is in HOLD,
 // even if it owns a large amount of immediately saleable crypto.
 const reserveCovered=gap===0;
 const budget=reserveCovered?liquid*x.fundingAllocationCapPct/100:0;
 return {
  execution_mode:"paper",live_allowed:false,source:"user_supplied_unverified",
  safetyTargetKrw:rounded(target),eligibleCashKrw:rounded(cash),
  safetyGapKrw:rounded(gap),reserveCovered,
  reserveCoverageMonths:monthly>0?Number((Math.max(0,cash-obligations)/monthly).toFixed(2)):null,
  liquidCryptoKrw:rounded(liquid),illiquidOrEncumberedCryptoKrw:rounded(locked),
  stablecoinExposureKrw:rounded(stables),
  fundingStrategyBudgetKrw:rounded(budget),
  spotLegBudgetKrw:rounded(budget/2),shortCollateralBudgetKrw:rounded(budget/2),
  deployableNow:false,
  notes:[
   "Only KRW bank cash and bank deposits available within two days count toward the living reserve.",
   "Stablecoins and exchange balances are not bank cash; depeg, custody, freezes, FX and tax risks remain.",
   "No allocation is proposed until the cash reserve covers the selected months plus near-term obligations.",
   "Funding strategy budget is a user-selected ceiling (0-20%) of liquid unencumbered crypto, not a recommendation.",
   "Equal KRW spot/short collateral budgets are illustrative only; execution prices, basis, FX and exchange margin requirements are unverified.",
   "No realized funding yield is booked as predictable monthly living income."
  ]
 };
}
export function parseReserveSnapshot(raw:string):ReserveInput{
 if(typeof raw!=="string"||raw.length>50000)throw Error("Snapshot too large");
 let x:unknown;try{x=JSON.parse(raw)}catch{throw Error("Invalid JSON")}
 if(!x||typeof x!=="object"||Array.isArray(x))throw Error("Invalid snapshot");
 const a=x as Record<string,unknown>;
 const keys=["snapshotDate","krwBankCash","krwBankDepositsAvailableWithin2Days",
 "essentialMonthlyKrw","reserveMonths","nearTermObligationsKrw","fundingAllocationCapPct","holdings"];
 if(Object.keys(a).some(k=>!keys.includes(k))||keys.some(k=>!(k in a)))
  throw Error("Missing or unexpected snapshot field (no account keys or personal identifiers)");
 if(!Array.isArray(a.holdings))throw Error("Invalid holdings");
 for(const h of a.holdings){
  if(!h||typeof h!=="object"||Array.isArray(h))throw Error("Invalid holding");
  const allowed=["asset","venue","category","valueKrw","availableInDays","encumbered"];
  if(Object.keys(h).some(k=>!allowed.includes(k))||allowed.some(k=>!(k in h)))
   throw Error("Unexpected holding field (no wallet address, account or API key)");
 }
 const result=a as unknown as ReserveInput;
 evaluateReserve(result);
 return result;
}
