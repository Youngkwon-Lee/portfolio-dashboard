import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {execFileSync} from "node:child_process";
const HOUR=3600000,START=Date.parse("2026-07-01T00:00:00Z"),END=START+30*24*HOUR;
const script=resolve("scripts/funding-build-local-bundle.mjs");
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),"quant-local-fixture-"));
 const funding=[["time","rate"],...Array.from({length:90},(_,i)=>
   [START+(i+1)*8*HOUR,"0.0001"])];
 const spot=[["time","open"],[START,"99"],[END,"104"]];
 const perp=[["time","open"],[START,"100"],[END,"106"]];
 for(const [name,rows] of [["funding",funding],["spot",spot],["perp",perp]])
  await writeFile(join(dir,name+".csv"),rows.map(r=>r.join(",")).join("\n")+"\n");
 return dir;
}
function args(dir,out="out.json"){
 return ["Binance","XRP","30",new Date(START).toISOString(),new Date(END).toISOString(),
  join(dir,"funding.csv"),join(dir,"spot.csv"),join(dir,"perp.csv"),
  "https://data.binance.vision/data/futures/um/",join(dir,out)];
}
test("offline converter creates a valid unverified research bundle and SHA256",async()=>{
 const dir=await fixture();
 try{
  const report=JSON.parse(execFileSync(process.execPath,[script,...args(dir)],{encoding:"utf8"}));
  assert.equal(report.execution_mode,"paper");
  assert.equal(report.live_allowed,false);
  assert.equal(report.records,90);
  assert.match(report.sha256,/^[a-f0-9]{64}$/);
  const bundle=JSON.parse(await readFile(join(dir,"out.json"),"utf8"));
  assert.equal(bundle.funding.length,90);
  assert.equal(bundle.entry.spot,99);
  assert.equal(bundle.exit.perp,106);
  assert.equal(bundle.format,"quant-lab-funding-bundle-v1");
 }finally{await rm(dir,{recursive:true,force:true});}
});
test("offline converter rejects incomplete settlement coverage and does not write file",async()=>{
 const dir=await fixture();
 try{
  const path=join(dir,"funding.csv");
  const lines=(await readFile(path,"utf8")).trim().split("\n");
  lines.splice(5,1);
  await writeFile(path,lines.join("\n")+"\n");
  assert.throws(()=>execFileSync(process.execPath,[script,...args(dir)],{stdio:"pipe"}),/Command failed/);
  await assert.rejects(()=>readFile(join(dir,"out.json"),"utf8"),{code:"ENOENT"});
 }finally{await rm(dir,{recursive:true,force:true});}
});
test("offline converter rejects duplicate timestamp and refuses to overwrite existing output",async()=>{
 const dir=await fixture();
 try{
  execFileSync(process.execPath,[script,...args(dir)],{stdio:"pipe"});
  assert.throws(()=>execFileSync(process.execPath,[script,...args(dir)],{stdio:"pipe"}));
  const path=join(dir,"funding.csv");
  const lines=(await readFile(path,"utf8")).trim().split("\n");
  lines.splice(3,0,lines[2]);
  await writeFile(path,lines.join("\n")+"\n");
  assert.throws(()=>execFileSync(process.execPath,[script,...args(dir,"dup.json")],{stdio:"pipe"}));
 }finally{await rm(dir,{recursive:true,force:true});}
});
