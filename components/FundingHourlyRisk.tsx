"use client";
import {useState} from "react";
import {evaluateHourlyPath,type HourlyPathInput,type HourlyRiskResult} from "@/lib/funding-hourly-risk";
const usd=(v:number|null)=>v===null?"검증 불가":new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:2}).format(v);
const pct=(v:number|null)=>v===null?"검증 불가":v.toFixed(3)+"%";
export default function FundingHourlyRisk(){
 const [result,setResult]=useState<HourlyRiskResult|null>(null);
 const [error,setError]=useState("");
 const [busy,setBusy]=useState(false);
 const [maintenance,setMaintenance]=useState("0.5");
 const [spotFee,setSpotFee]=useState("10"),[perpFee,setPerpFee]=useState("5"),[slip,setSlip]=useState("5");
 const numeric=[maintenance,spotFee,perpFee,slip].map(Number);
 const valid=[maintenance,spotFee,perpFee,slip].every(v=>v.trim()!==""&&/^\d+(?:\.\d+)?$/.test(v))&&
  numeric[0]>=0&&numeric[0]<=10&&numeric.slice(1).every(n=>n>=0&&n<=100);
 async function importFile(file:File|undefined){
  setResult(null);setError("");
  if(!file)return;
  if(!valid){setError("유지증거금 및 수수료 입력 범위를 확인하세요.");return;}
  if(!file.name.toLowerCase().endsWith(".json")||file.size>2_000_000){setError("2MB 이하 JSON만 허용합니다.");return;}
  setBusy(true);
  try{
   const parsed:unknown=JSON.parse(await file.text());
   if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))throw Error("JSON 객체 형식 오류");
   const o=parsed as Record<string,unknown>;
   const keys=["format","venue","coin","days","start","end","notionalUsd","funding","candles","sourceUrl"];
   if(Object.keys(o).some(k=>!keys.includes(k))||keys.some(k=>!(k in o)))
    throw Error("필수 필드 누락 또는 허용되지 않은 필드");
   if(o.format!=="quant-lab-hourly-path-v1")throw Error("시간별 연구자료 형식 오류");
   if(typeof o.sourceUrl!=="string"||o.sourceUrl.length>400||!o.sourceUrl.startsWith("https://"))
    throw Error("출처 URL 형식 오류");
   if(!Array.isArray(o.candles)||o.candles.length>2160||!Array.isArray(o.funding)||o.funding.length>2160)
    throw Error("시간별 데이터 건수 오류");
   const input={
    venue:o.venue,coin:o.coin,days:o.days,start:o.start,end:o.end,notionalUsd:o.notionalUsd,
    funding:o.funding,candles:o.candles,
    maintenanceMarginRate:Number(maintenance)/100,
    spotFeeBps:Number(spotFee),perpFeeBps:Number(perpFee),slippageBps:Number(slip)
   } as HourlyPathInput;
   setResult(evaluateHourlyPath(input));
  }catch(e){setError(e instanceof Error?e.message:"로컬 데이터 검증 실패");}
  finally{setBusy(false);}
 }
 return <section className="rounded-lg border p-4 space-y-3" style={{borderColor:"var(--card-border)",background:"var(--card)"}} aria-label="시간별 베이시스와 숏 증거금 위험">
  <h2 className="font-semibold">시간별 베이시스 · 1배 숏 증거금 경로</h2>
  <p className="text-xs" style={{color:"var(--muted)"}}>
   동일 시간의 현물·무기한 선물 OHLC와 실제 펀딩 정산 시각이 포함된 사용자 제공 연구 파일만 분석합니다.
   유지증거금률은 <strong>사용자 가정</strong>이며 거래소별 실제 청산 공식이 아닙니다.
  </p>
  <div className="flex flex-wrap gap-3">
   {([["가정 유지증거금률 %",maintenance,setMaintenance,10],
      ["현물 수수료 bps",spotFee,setSpotFee,100],
      ["선물 수수료 bps",perpFee,setPerpFee,100],
      ["슬리피지 bps",slip,setSlip,100]] as const).map(([label,value,set,max])=>
    <label key={label} className="flex flex-col gap-1 text-xs">{label}
     <input aria-label={label} type="number" min="0" max={max} step="0.1"
      value={value} onChange={e=>{set(e.target.value);setResult(null);setError("");}}
      className="w-32 rounded-md border p-2" style={{borderColor:"var(--card-border)",background:"var(--background)"}}/>
    </label>)}
  </div>
  <label className="flex flex-col gap-1 text-xs">시간별 연구 JSON (30일 720개 / 90일 2,160개)
   <input aria-label="시간별 위험 연구 파일" type="file" accept=".json,application/json" disabled={!valid||busy}
    onChange={e=>{void importFile(e.target.files?.[0]);e.target.value="";}}
    className="rounded-md border p-2 text-sm" style={{borderColor:"var(--card-border)"}}/>
  </label>
  {!valid&&<p role="alert" className="text-xs" style={{color:"#fa7676"}}>유지증거금률 0–10%, 비용 0–100bps만 허용합니다.</p>}
  {error&&<p role="alert" className="text-xs" style={{color:"#fa7676"}}>시간별 자료 거부: {error}</p>}
  {result&&<div className="space-y-3" aria-live="polite">
   <p className="text-xs font-semibold" style={{color:"#e5b567"}}>사용자 제공 자료 · 원본 진위 미확인 · PAPER ONLY</p>
   <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
    <div><div className="text-xs" style={{color:"var(--muted)"}}>시간봉/펀딩 건수</div><strong>{result.hourly_candles} / {result.funding_events}</strong></div>
    <div><div className="text-xs" style={{color:"var(--muted)"}}>최저 가상 마진 여유</div><strong>{usd(result.lowest_margin_buffer_usd)}</strong></div>
    <div><div className="text-xs" style={{color:"var(--muted)"}}>관측 경로 최대낙폭 근사</div><strong>{pct(result.max_portfolio_drawdown_pct)}</strong></div>
    <div><div className="text-xs" style={{color:"var(--muted)"}}>보유 종료 순수익 추정</div><strong>{usd(result.estimated_hold_to_end_net_usd)}</strong></div>
   </div>
   {result.status==="margin_buffer_breach_proxy"?
    <p role="alert" className="rounded-md border p-3 text-sm" style={{color:"#fa7676",borderColor:"#fa767655"}}>
     가정된 유지증거금 버퍼가 {result.first_breach_utc}에 소진될 가능성이 있습니다.
     실제 강제청산 체결은 모델링하지 않았으므로 이후 보유수익을 표시하지 않습니다.
    </p>:
    <p className="text-xs">관측 시간봉 고가에서 가정한 증거금 버퍼 소진은 확인되지 않았습니다. 실제 청산 위험이 없다는 뜻은 아닙니다.</p>}
   <div className="overflow-x-auto">
    <table className="w-full min-w-[560px] text-xs">
     <thead><tr><th className="p-2 text-left">일자 (UTC)</th><th className="p-2 text-right">베이시스</th><th className="p-2 text-right">펀딩 누적</th><th className="p-2 text-right">가상 마진 버퍼</th><th className="p-2 text-right">누적 손익</th></tr></thead>
     <tbody>{result.daily_curve.map(row=><tr key={row.time} className="border-t" style={{borderColor:"var(--card-border)"}}>
      <td className="p-2">{row.time.slice(0,10)}</td><td className="p-2 text-right">{pct(row.basisPct)}</td>
      <td className="p-2 text-right">{usd(row.fundingUsd)}</td><td className="p-2 text-right">{usd(row.marginBufferUsd)}</td>
      <td className="p-2 text-right">{result.status==="margin_buffer_breach_proxy"?"보유 지속 미확인":usd(row.hedgedNetUsd)}</td>
     </tr>)}</tbody>
    </table>
   </div>
   <p className="text-xs" style={{color:"var(--muted)"}}>{result.assumptions.join(" ")}</p>
  </div>}
  <p className="text-xs" style={{color:"var(--muted)"}}>
   브라우저 메모리에서만 계산하며 서버 전송·계좌 연결·주문은 하지 않습니다. 원화 생활비 안전자금과 별도입니다.
  </p>
 </section>;
}
