#!/usr/bin/env node
/** Offline converter for normalized research CSV. No HTTP, credentials or trading. */
import {readFile,writeFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {resolve} from "node:path";
const usage=[
 "Usage: node scripts/funding-build-local-bundle.mjs Binance XRP 30 START_ISO END_ISO funding.csv spot.csv perp.csv source_url output.json",
 "Canonical funding.csv header: time,rate",
 "Canonical spot.csv/perp.csv header: time,open",
 "time = Unix milliseconds (NOT seconds/microseconds), UTC.",
 "Prices are the spot and perpetual hourly OPEN at START and END.",
 "Official archives have varying raw column orders/time units; normalize and",
 "check them before using this converter. Source URL is NOT authenticated."
].join("\n");
function fail(s){throw Error(s+"\n"+usage)}
function csvRows(text,columns){
 const rows=text.trim().replace(/^\uFEFF/,"").split(/\r?\n/);
 if(rows[0]!==columns.join(","))fail("Unexpected CSV header: "+rows[0]);
 if(rows.length<2||rows.length>5000)fail("Invalid CSV row count");
 return rows.slice(1).map((line,i)=>{
  const vals=line.split(",");if(vals.length!==columns.length)fail("Unexpected column count at row "+(i+2));
  const result={};
  for(let j=0;j<columns.length;j++){
   const value=vals[j].trim();
   if(!/^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value))
    fail("Non-numeric value at row "+(i+2));
   result[columns[j]]=Number(value);
  }
  if(!Number.isSafeInteger(result.time)||result.time<1e12||result.time>1e14)
   fail("Invalid millisecond timestamp at row "+(i+2));
  return result;
 });
}
const [venue,coin,daysStr,startIso,endIso,fundingFile,spotFile,perpFile,sourceUrl,output]=process.argv.slice(2);
if(!venue||!output)fail("Missing parameters");
const days=Number(daysStr),start=Date.parse(startIso),end=Date.parse(endIso);
if(!["Binance","Bybit"].includes(venue)||!["BTC","ETH","XRP"].includes(coin)||![30,90].includes(days)||
 !Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start%3600000||end%3600000||
 end-start!==days*86400000)fail("Invalid venue/coin/window");
if(typeof sourceUrl!=="string"||!sourceUrl.startsWith(venue==="Binance"?"https://data.binance.vision/":"https://www.bybit.com/"))
 fail("Use an official source URL; source authenticity is not verified");
const [f,s,p]=await Promise.all([fundingFile,spotFile,perpFile].map(x=>readFile(resolve(x),"utf8")));
const funding=csvRows(f,["time","rate"]);
const spot=csvRows(s,["time","open"]);
const perp=csvRows(p,["time","open"]);
function verifyOrdered(rows,label){
 let previous=-Infinity;
 for(const row of rows){
  if(row.time<=previous)fail(label+" must be strictly time-ordered without duplicates");
  previous=row.time;
 }
}
verifyOrdered(funding,"funding");
verifyOrdered(spot,"spot");
verifyOrdered(perp,"perp");
if(funding[0].time<=start||funding.at(-1).time>end)
 fail("Funding rows must be inside (start,end]");
const maxGap=8*3600000;
let previousFunding=start;
for(const row of funding){
 if(row.time-previousFunding>maxGap+60000)fail("Incomplete funding settlement coverage");
 if(!Number.isFinite(row.rate)||Math.abs(row.rate)>.04)
  fail("Invalid funding rate");
 previousFunding=row.time;
}
if(end-previousFunding>=maxGap)fail("Incomplete funding tail");
for(const row of [...spot,...perp]){
 if(!Number.isFinite(row.open)||row.open<=0)fail("Invalid spot/perp price");
}
const spotMap=new Map(spot.map(x=>[x.time,x.open])),perpMap=new Map(perp.map(x=>[x.time,x.open]));
function snapshot(time){
 const sp=spotMap.get(time),pp=perpMap.get(time);
 if(!Number.isFinite(sp)||sp<=0||!Number.isFinite(pp)||pp<=0)fail("Missing aligned spot/perp open at "+time);
 return {time,spot:sp,perp:pp};
}
const bundle={format:"quant-lab-funding-bundle-v1",venue,coin,days,start,end,notionalUsd:10000,
 sourceUrl,downloadedAt:new Date().toISOString(),funding,entry:snapshot(start),exit:snapshot(end)};
const json=JSON.stringify(bundle,null,2)+"\n";
if(Buffer.byteLength(json)>2_000_000)fail("Output exceeds 2MB limit");
await writeFile(resolve(output),json,{flag:"wx",mode:0o600});
const digest=createHash("sha256").update(json).digest("hex");
process.stdout.write(JSON.stringify({output,sha256:digest,records:funding.length,
 provenance:"user_supplied_unverified",execution_mode:"paper",live_allowed:false})+"\n");
