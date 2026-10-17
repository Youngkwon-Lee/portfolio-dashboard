import test from "node:test";
import assert from "node:assert/strict";
import {evaluateReserve,parseReserveSnapshot} from "../lib/funding-portfolio-reserve.ts";
function snapshot(overrides={}){
 return {
  snapshotDate:"2026-10-17T05:00:00Z",
  krwBankCash:1000000,krwBankDepositsAvailableWithin2Days:0,
  essentialMonthlyKrw:2000000,reserveMonths:12,nearTermObligationsKrw:1000000,
  fundingAllocationCapPct:10,
  holdings:[
   {asset:"XRP",venue:"Exchange A",category:"crypto",valueKrw:10000000,availableInDays:1,encumbered:false},
   {asset:"USDT",venue:"Exchange B",category:"stablecoin",valueKrw:5000000,availableInDays:1,encumbered:false},
   {asset:"ETH",venue:"DeFi",category:"defi",valueKrw:7000000,availableInDays:7,encumbered:true}
  ],...overrides
 };
}
test("missing KRW reserve blocks crypto allocation even with large liquid holdings",()=>{
 const x=evaluateReserve(snapshot());
 assert.equal(x.safetyTargetKrw,25000000);
 assert.equal(x.safetyGapKrw,24000000);
 assert.equal(x.fundingStrategyBudgetKrw,0);
 assert.equal(x.deployableNow,false);
 assert.equal(x.stablecoinExposureKrw,5000000);
});
test("fully covered KRW reserve permits only user-chosen cap of liquid crypto",()=>{
 const x=evaluateReserve(snapshot({krwBankCash:26000000}));
 assert.equal(x.reserveCovered,true);
 assert.equal(x.fundingStrategyBudgetKrw,1500000);
 assert.equal(x.spotLegBudgetKrw,750000);
 assert.equal(x.shortCollateralBudgetKrw,750000);
 assert.equal(x.illiquidOrEncumberedCryptoKrw,7000000);
});
test("locked and pledged crypto excluded from available trading funds",()=>{
 const x=snapshot({krwBankCash:26000000});
 x.holdings[0].encumbered=true;
 assert.equal(evaluateReserve(x).fundingStrategyBudgetKrw,500000);
});
test("no allocations when cap is zero and no implied yield",()=>{
 const x=evaluateReserve(snapshot({krwBankCash:30000000,fundingAllocationCapPct:0}));
 assert.equal(x.fundingStrategyBudgetKrw,0);
 assert.equal(x.execution_mode,"paper");
 assert.equal(x.live_allowed,false);
});
test("strict schema rejects account identifiers, credentials and wallet addresses",()=>{
 const x=snapshot();
 x.apiKey="secret";
 assert.throws(()=>parseReserveSnapshot(JSON.stringify(x)),/unexpected snapshot field/);
 const y=snapshot();
 y.holdings[0].walletAddress="0x123";
 assert.throws(()=>parseReserveSnapshot(JSON.stringify(y)),/Unexpected holding field/);
});
test("invalid values, missing spending and non-finite holdings fail closed",()=>{
 assert.throws(()=>evaluateReserve(snapshot({essentialMonthlyKrw:0})),/Monthly essential/);
 assert.throws(()=>evaluateReserve(snapshot({fundingAllocationCapPct:21})),/Invalid reserve/);
 const x=snapshot();x.holdings[0].valueKrw=-10;
 assert.throws(()=>evaluateReserve(x),/Invalid holding value/);
});
test("valid snapshot parses without persistence or account connection",()=>{
 const input=parseReserveSnapshot(JSON.stringify(snapshot()));
 assert.equal(input.holdings.length,3);
 assert.equal(evaluateReserve(input).source,"user_supplied_unverified");
});
