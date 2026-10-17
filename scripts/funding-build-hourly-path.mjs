#!/usr/bin/env node
/** Offline only. Convert user-normalized hourly spot/perp and funding CSV to research JSON. */
import {readFile,writeFile} from "node:fs/promises";
import {createHash} from "node:crypto";
const H=3600000,DAY=86400000;
function parseCSV(text,headers){
 const lines=text.trim().replace(/^\uFEFF/,"").split(/\r?\n/);
 if(lines.shift()!==headers.join(","))throw Error("CSV header mismatch: "+headers.join(","));
 const rows=lines.map(line=>{
  const values=line.split(",");
  if(values.length!==headers.length)throw Error("Invalid CSV columns");
  const out={};
  for(let i=0;i<headers.length;i++){
   if(!/^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(values[i].trim()))
    throw Error("Invalid numeric CSV field");
   out[headers[i]]=Number(values[i]);
  }
  if(!Number.isSafeInteger(out.time)||out.time<1e12||out.time>1e14)
   throw Error("Expected millisecond Unix timestamp");
  return out;
 });
 return rows;
}
const [venue,coin,daysRaw,startRaw,spotFile,perpFile,fundingFile,sourceUrl,outFile]=process.argv.slice(2);
const days=Number(daysRaw),start=Date.parse(startRaw);
if(!["Binance","Bybit","OKX"].includes(venue)||!["BTC","ETH","XRP"].includes(coin)||
 ![30,90].includes(days)||!Number.isSafeInteger(start)||start%H!==0||
 !outFile||typeof sourceUrl!=="string"||!sourceUrl.startsWith("https://"))
 throw Error("Usage: node scripts/funding-build-hourly-path.mjs OKX XRP 30 2026-09-17T04:00:00Z spot.csv perp.csv funding.csv https://official-source.example/path hourly.json");
const [spotText,perpText,fundingText]=await Promise.all(
 [spotFile,perpFile,fundingFile].map(p=>readFile(p,"utf8")));
const spot=parseCSV(spotText,["time","open","high","low","close"]);
const perp=parseCSV(perpText,["time","open","high","low","close"]);
const funding=parseCSV(fundingText,["time","rate"]);
const hours=days*24,end=start+days*DAY;
if(spot.length!==hours||perp.length!==hours||funding.length>2160||!funding.length)
 throw Error("Incomplete hourly path or funding history");
const candles=[];
for(let i=0;i<hours;i++){
 const time=start+i*H;
 if(spot[i].time!==time||perp[i].time!==time)
  throw Error("Missing, duplicated or out-of-order hourly candle");
 const {time:_,...spotOHLC}=spot[i];
 const {time:__,...perpOHLC}=perp[i];
 for(const item of [spotOHLC,perpOHLC]){
  const {open:o,high:h,low:l,close:c}=item;
  if(![o,h,l,c].every(v=>Number.isFinite(v)&&v>0)||h<Math.max(o,c)||l>Math.min(o,c))
   throw Error("Invalid OHLC candle");
 }
 candles.push({time,spot:spotOHLC,perp:perpOHLC});
}
let last=start;
for(const f of funding){
 if(!Number.isFinite(f.rate)||Math.abs(f.rate)>.04||f.time<=last||
   f.time>end+60000)throw Error("Invalid or unordered funding history");
 last=f.time;
}
const payload={format:"quant-lab-hourly-path-v1",venue,coin,days,start,end,
 notionalUsd:10000,sourceUrl,funding,candles};
const data=JSON.stringify(payload)+"\n";
if(Buffer.byteLength(data)>2_000_000)throw Error("Output > 2MB");
await writeFile(outFile,data,{flag:"wx",mode:0o600});
process.stdout.write(JSON.stringify({
 output:outFile,sha256:createHash("sha256").update(data).digest("hex"),
 hourlyCandles:hours,fundingRows:funding.length,
 provenance:"user_supplied_unverified",execution_mode:"paper",live_allowed:false
})+"\n");
