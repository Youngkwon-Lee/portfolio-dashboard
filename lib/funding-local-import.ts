/**
 * User-supplied, LOCAL-ONLY research bundle. No upload, network, credentials,
 * trade endpoints or persistence. Source URL is a claim, not authenticated.
 */
import {evaluateVenue,type VenueInput,type VenueComparison,type Venue,type Asset} from "./funding-venues.ts";
export type LocalBundle = {
  format:"quant-lab-funding-bundle-v1";
  venue:"Binance"|"Bybit";coin:Asset;days:30|90;
  start:number;end:number;notionalUsd:number;
  sourceUrl:string;downloadedAt:string;
  funding:Array<{time:number;rate:number}>;
  entry:{time:number;spot:number;perp:number};
  exit:{time:number;spot:number;perp:number};
};
export type LocalResult={provenance:"user_supplied_unverified";sourceUrl:string;downloadedAt:string;
  result:VenueComparison};
const LIMIT_BYTES=2_000_000,MAX_ROWS=2160;
const exact=(obj:Record<string,unknown>,keys:string[])=>{
 if(Object.keys(obj).some(k=>!keys.includes(k))||keys.some(k=>!(k in obj)))
  throw Error("Unexpected or missing bundle field");
};
const isObj=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
export function parseLocalBundle(text:string):LocalBundle{
 if(typeof text!=="string"||text.length>LIMIT_BYTES||!text.trim())throw Error("Bundle size/format invalid");
 let raw:unknown;
 try{raw=JSON.parse(text)}catch{throw Error("Invalid JSON bundle")}
 if(!isObj(raw))throw Error("Invalid bundle object");
 exact(raw,["format","venue","coin","days","start","end","notionalUsd","sourceUrl","downloadedAt","funding","entry","exit"]);
 if(raw.format!=="quant-lab-funding-bundle-v1"||
    (raw.venue!=="Binance"&&raw.venue!=="Bybit")||
    !["BTC","ETH","XRP"].includes(String(raw.coin))||
    (raw.days!==30&&raw.days!==90))throw Error("Unsupported local bundle");
 const allowed=raw.venue==="Binance"?["https://data.binance.vision/"]:
   ["https://www.bybit.com/","https://public.bybit.com/"];
 if(typeof raw.sourceUrl!=="string"||raw.sourceUrl.length>400||
    !allowed.some(p=>raw.sourceUrl.startsWith(p)))throw Error("Official source URL required");
 if(typeof raw.downloadedAt!=="string"||!/^20\d{2}-\d\d-\d\dT/.test(raw.downloadedAt)||
    !Number.isFinite(Date.parse(raw.downloadedAt)))throw Error("Invalid download timestamp");
 if(!Array.isArray(raw.funding)||!raw.funding.length||raw.funding.length>MAX_ROWS)
  throw Error("Invalid funding row count");
 for(const row of raw.funding){
  if(!isObj(row))throw Error("Invalid funding row");
  exact(row,["time","rate"]);
  if(!Number.isSafeInteger(row.time)||typeof row.rate!=="number"||!Number.isFinite(row.rate))
   throw Error("Invalid funding value");
 }
 for(const key of ["entry","exit"]){
  const row=raw[key];
  if(!isObj(row))throw Error("Missing price snapshot");
  exact(row,["time","spot","perp"]);
  if(!Number.isSafeInteger(row.time)||typeof row.spot!=="number"||typeof row.perp!=="number"||
    !Number.isFinite(row.spot)||!Number.isFinite(row.perp))throw Error("Invalid price snapshot");
 }
 // All values validated structurally; evaluateVenue performs settlement,
 // basis, fee and interval checks, and refuses incomplete history.
 return raw as unknown as LocalBundle;
}
export function evaluateLocalBundle(text:string,fee:{
  spotFeeBps:number;perpFeeBps:number;slippageBps:number
}):LocalResult{
 const x=parseLocalBundle(text);
 const input:VenueInput={
  venue:x.venue as Venue,coin:x.coin,days:x.days,start:x.start,end:x.end,
  notionalUsd:x.notionalUsd,spotFeeBps:fee.spotFeeBps,
  perpFeeBps:fee.perpFeeBps,slippageBps:fee.slippageBps,
  funding:x.funding,entry:x.entry,exit:x.exit
 };
 return {provenance:"user_supplied_unverified",sourceUrl:x.sourceUrl,
   downloadedAt:x.downloadedAt,result:evaluateVenue(input)};
}
