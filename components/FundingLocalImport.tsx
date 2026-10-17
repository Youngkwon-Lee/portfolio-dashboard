"use client";
import {useState} from "react";
import {evaluateLocalBundle,type LocalResult} from "@/lib/funding-local-import";
const usd=(n:number|null|undefined)=>n==null?"—":new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:2}).format(n);
export default function FundingLocalImport(){
 const [value,setValue]=useState<LocalResult|null>(null);
 const [error,setError]=useState("");
 const [busy,setBusy]=useState(false);
 const [fees,setFees]=useState({spotFeeBps:10,perpFeeBps:5,slippageBps:5});
 const importFile=async(file:File|undefined)=>{
  setValue(null);setError("");
  if(!file)return;
  if(file.size>2_000_000||!file.name.toLowerCase().endsWith(".json")){
   setError("2MB 이하의 연구용 JSON 파일만 허용합니다.");return;
  }
  setBusy(true);
  try{
   const content=await file.text(); // browser memory only, no fetch, upload, storage
   const result=evaluateLocalBundle(content,fees);
   setValue(result);
  }catch(e){setError(e instanceof Error?e.message:"로컬 파일 검증 실패");}
  finally{setBusy(false);}
 };
 const changeFee=(key:keyof typeof fees,s:string)=>{
  const n=Number(s);
  setValue(null);setError("");
  setFees(p=>({...p,[key]:s.trim()!==""&&Number.isFinite(n)&&n>=0&&n<=100?n:NaN}));
 };
 const valid=Object.values(fees).every(x=>Number.isFinite(x)&&x>=0&&x<=100);
 return <section className="rounded-lg border p-4 space-y-3" style={{background:"var(--card)",borderColor:"var(--card-border)"}} aria-label="공식 아카이브 로컬 분석">
  <div>
   <h2 className="font-semibold">Binance·Bybit 로컬 연구 자료 분석</h2>
   <p className="mt-1 text-xs" style={{color:"var(--muted)"}}>
    서버가 HTTP 451·403으로 접근할 수 없는 거래소의 데이터를 우회 조회하지 않습니다.
    접근이 허용된 공식 자료를 직접 확보한 경우에만 표준화된 JSON을 브라우저 메모리에서 분석합니다.
   </p>
  </div>
  <div className="flex flex-wrap gap-3">
   {([["현물 수수료 bps","spotFeeBps"],["선물 수수료 bps","perpFeeBps"],["슬리피지 bps","slippageBps"]] as const).map(([label,key])=>
    <label key={key} className="flex flex-col gap-1 text-xs">{label}
     <input type="number" aria-label={"로컬 "+label} min="0" max="100" step="0.5"
      value={Number.isFinite(fees[key])?fees[key]:""} onChange={e=>changeFee(key,e.target.value)}
      className="rounded-md border p-2 w-28" style={{background:"var(--background)",borderColor:"var(--card-border)"}}/>
    </label>)}
  </div>
  <label className="flex flex-col gap-1 text-xs">로컬 JSON 연구 파일 (최대 2MB)
   <input aria-label="로컬 연구 파일" type="file" accept=".json,application/json" disabled={!valid||busy}
    onChange={e=>{void importFile(e.target.files?.[0]);e.target.value="";}}
    className="block w-full rounded-md border p-2 text-sm" style={{borderColor:"var(--card-border)"}}/>
  </label>
  <p className="text-xs" style={{color:"var(--muted)"}}>
   파일은 서버에 업로드하거나 저장하지 않습니다. 자료의 진위와 공식 출처는 자동 인증되지 않으며,
   검증된 라이브 거래소 데이터와 합산·순위 비교하지 않습니다.
  </p>
  {!valid&&<p role="alert" className="text-xs" style={{color:"#fa7676"}}>수수료는 0–100bps 범위로 설정하세요.</p>}
  {error&&<p role="alert" className="text-xs" style={{color:"#fa7676"}}>로컬 데이터 거부: {error}</p>}
  {busy&&<p className="text-xs">로컬 파일 검증 중…</p>}
  {value&&<div className="rounded-md border p-3 space-y-2" style={{borderColor:"var(--card-border)"}}>
   <strong className="text-sm">사용자 제공 데이터 · 독립 검증 전</strong>
   <p className="text-xs">{value.result.venue} {value.result.coin} · {value.result.days}일 · {value.result.settlement_count}건</p>
   <p className="text-xs">출처 주장: {value.sourceUrl} · 수집 시각: {value.downloadedAt}</p>
   <div className="grid gap-2 sm:grid-cols-3 text-sm">
    <div>펀딩비 합계: <strong>{value.result.funding_sum_pct.toFixed(4)}%</strong></div>
    <div>베이시스 손익: <strong>{usd(value.result.basis_pnl_usd)}</strong></div>
    <div>모의 순수익: <strong>{usd(value.result.estimated_net_usd)}</strong></div>
   </div>
   <p className="text-xs" style={{color:"var(--muted)"}}>
    현물·선물 동일 시각 시가를 가정한 모의 손익이며, 청산 경로·정산 명목금액·환율·세금은 제외됩니다.
    자료 진위 미확인 상태이므로 투자 판단이나 실거래에 사용하지 마세요.
   </p>
  </div>}
 </section>;
}
