"use client";
import {useRef,useState} from "react";
import type {Asset,VenueComparison} from "@/lib/funding-venues";
type Result=Omit<Partial<VenueComparison>,"venue"|"status">&{venue:string;status:"basis_verified"|"funding_only"|"unavailable";error?:string;basis_warning?:string};
const fmt=(n:number|null|undefined)=>n===null||n===undefined?"—":new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:2}).format(n);
const pct=(n:number|null|undefined)=>n===null||n===undefined?"—":(n>0?"+":"")+n.toFixed(3)+"%";
const panel={background:"var(--card)",borderColor:"var(--card-border)"};
export default function FundingVenueComparison(){
 const [coin,setCoin]=useState<Asset>("XRP"),[days,setDays]=useState<30|90>(30);
 const [notional,setNotional]=useState("10000"),[spotFee,setSpotFee]=useState("10"),
 [perpFee,setPerpFee]=useState("5"),[slip,setSlip]=useState("5");
 const [results,setResults]=useState<Result[]|null>(null),[loading,setLoading]=useState(false),
 [error,setError]=useState(""),[window,setWindow]=useState("");
 const sequence=useRef(0);
 const invalidate=()=>{sequence.current++;setResults(null);setLoading(false);setError("");};
 const values=[notional,spotFee,perpFee,slip].map(Number);
 const valid=[notional,spotFee,perpFee,slip].every(x=>x.trim()!==""&&/^\d+(?:\.\d+)?$/.test(x))&&
   values[0]>=100&&values[0]<=1e6&&values.slice(1).every(x=>x>=0&&x<=100);
 const run=async()=>{
  if(!valid||loading)return;
  const id=++sequence.current;setLoading(true);setError("");setResults(null);
  try{
   const q=new URLSearchParams({coin,days:String(days),notional,
     spotFeeBps:spotFee,perpFeeBps:perpFee,slippageBps:slip});
   const response=await fetch("/api/funding/venues?"+q,{cache:"no-store"});
   const data=await response.json();
   if(!response.ok||data?.execution_mode!=="paper"||data?.live_allowed!==false||
      !Array.isArray(data?.venue_results)||data.venue_results.length!==4)
     throw Error(data?.error??"공개 데이터 검증 실패");
   if(id===sequence.current){setResults(data.venue_results);setWindow(data.start_utc+" — "+data.end_utc);}
  }catch(e){if(id===sequence.current)setError(e instanceof Error?e.message:"데이터 조회 실패");}
  finally{if(id===sequence.current)setLoading(false);}
 };
 return <section className="rounded-lg border p-4 space-y-4" style={panel} aria-label="거래소별 펀딩비 및 실제 베이시스 비교">
  <div>
   <h2 className="font-semibold text-lg">4개 거래소 · 현물–선물 베이시스 비교</h2>
   <p className="text-xs mt-1" style={{color:"var(--muted)"}}>공개 정산 내역과 실제 현물·선물 시간봉 가격을 사용합니다. 가격 미확인 시 순수익을 표시하지 않습니다.</p>
  </div>
  <div className="flex flex-wrap gap-3 items-end">
   <label className="text-xs flex flex-col gap-1">코인
    <select aria-label="거래소 비교 코인" value={coin} onChange={e=>{setCoin(e.target.value as Asset);invalidate();}} className="rounded-md border p-2" style={panel}>
     {(["XRP","BTC","ETH"] as Asset[]).map(v=><option key={v}>{v}</option>)}
    </select></label>
   <label className="text-xs flex flex-col gap-1">기간
    <select aria-label="거래소 비교 기간" value={days} onChange={e=>{setDays(Number(e.target.value) as 30|90);invalidate();}} className="rounded-md border p-2" style={panel}>
     <option value={30}>30일</option><option value={90}>90일</option>
    </select></label>
   {([["명목금액 USD",notional,setNotional,100,1e6],["현물 수수료 bps",spotFee,setSpotFee,0,100],
     ["선물 수수료 bps",perpFee,setPerpFee,0,100],["슬리피지 bps",slip,setSlip,0,100]] as const).map(([label,value,set,min,max])=>
    <label key={label} className="text-xs flex flex-col gap-1">{label}
     <input aria-label={label} type="number" min={min} max={max} step="0.5" value={value}
      onChange={e=>{set(e.target.value);invalidate();}}
      className="w-28 rounded-md border p-2" style={panel}/></label>)}
   <button type="button" disabled={!valid||loading} onClick={run} className="rounded-md px-4 py-2 text-sm font-semibold disabled:opacity-50" style={{background:"#58a6ff",color:"#09121c"}}>
    {loading?"검증 중":"거래소 비교 조회"}</button>
  </div>
  {!valid&&<p role="alert" className="text-xs" style={{color:"#f5af55"}}>명목금액 $100–$1m, 수수료·슬리피지 0–100bps로 입력하세요.</p>}
  {error&&<p role="alert" className="text-sm" style={{color:"#fa7676"}}>{error}</p>}
  {results&&<>
   <p className="text-xs" style={{color:"var(--muted)"}}>조회 구간 UTC: {window} · 데이터가 없는 거래소는 비교에서 제외</p>
   <div className="overflow-x-auto">
    <table className="w-full min-w-[760px] text-sm text-left">
     <thead><tr className="border-b" style={{borderColor:"var(--card-border)"}}>
      <th className="p-2">거래소</th><th className="p-2">펀딩비 누적</th>
      <th className="p-2">실제 진입/종료 베이시스</th><th className="p-2">베이시스 손익</th>
      <th className="p-2">모의 순수익</th><th className="p-2">총자본 수익률</th><th className="p-2">검증</th>
     </tr></thead>
     <tbody>{results.map(x=><tr key={x.venue} className="border-b align-top" style={{borderColor:"var(--card-border)"}}>
      <td className="p-2 font-semibold">{x.venue}</td>
      <td className="p-2 tabular-nums">{x.status==="unavailable"?"—":pct(x.funding_sum_pct)}</td>
      <td className="p-2 tabular-nums">{x.status==="basis_verified"?pct(x.basis_entry_pct)+" → "+pct(x.basis_exit_pct):"—"}</td>
      <td className="p-2 tabular-nums">{fmt(x.basis_pnl_usd)}</td>
      <td className="p-2 tabular-nums">{fmt(x.estimated_net_usd)}</td>
      <td className="p-2 tabular-nums">{pct(x.return_on_total_capital_pct)}</td>
      <td className="p-2 text-xs">{x.status==="basis_verified"?"가격 시점 검증":
       x.status==="funding_only"?"펀딩비만 검증":"검증 불가"}
       {x.basis_warning&&<div className="mt-1" style={{color:"var(--muted)"}}>{x.basis_warning}</div>}
       {x.error&&<div className="mt-1" style={{color:"#f5af55"}}>{x.error}</div>}
      </td>
     </tr>)}</tbody>
    </table>
   </div>
   <p className="text-xs" style={{color:"var(--muted)"}}>수익률은 거래소별 수수료 등급을 자동 반영하지 않은 가정치입니다. 순위는 확정 수익이 아닌 과거 가격·펀딩비 기반 모의 비교입니다.</p>
   <div className="rounded-md border p-3 text-xs space-y-1" style={{borderColor:"var(--card-border)"}}>
    <strong>1배 숏 증거금 스트레스 (별도 USDT/USDC 담보 {fmt(values[0])} 가정)</strong>
    <p>가격 +30%: {fmt(values[0]*.7)} · +50%: {fmt(values[0]*.5)} · +100%: $0 (유지증거금 이전 청산 가능)</p>
    <p>실제 청산가·중간 최대 손실·마진 규칙·베이시스 경로는 아직 미검증입니다. 현물 헤지가 다른 거래소에 있다면 숏 청산을 방지하지 못합니다.</p>
   </div>
  </>}
  <p className="text-xs" style={{color:"var(--muted)"}}>PAPER ONLY · 공개 GET 데이터만 조회 · API 키·주문·자금 이동 없음 · 원화 생활비 안전자금 대체 불가</p>
 </section>;
}
