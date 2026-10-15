"use client";

import { useRef, useState, type ReactNode } from "react";
import { AlertTriangle, ArrowDownUp, BarChart3, FlaskConical, RefreshCcw, ShieldCheck, TrendingDown, Wallet } from "lucide-react";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { FundingCoin, FundingDays, FundingResult } from "@/lib/funding-model";

const BLUE = "#58a6ff";
const GREEN = "#3fb986";
const MUTED = "var(--muted)";
const PANEL = "rounded-lg border p-4";
const PANEL_STYLE = {borderColor:"var(--card-border)",background:"var(--card)"};
const usd = (n:number)=>new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:2}).format(n);
const percent=(n:number)=>(n>0?"+":"")+n.toFixed(3)+"%";

export default function FundingPage(){
  const [coin,setCoin]=useState<FundingCoin>("XRP");
  const [days,setDays]=useState<FundingDays>(30);
  const [notional,setNotional]=useState("10000");
  const [spotFee,setSpotFee]=useState("10");
  const [perpFee,setPerpFee]=useState("4.5");
  const [slippage,setSlippage]=useState("5");
  const [result,setResult]=useState<FundingResult|null>(null);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState("");
  const requestIdRef=useRef(0);
  const clear=()=>{requestIdRef.current++;setResult(null);setError("");setLoading(false);};
  const inputsValid=[notional,spotFee,perpFee,slippage].every(x=>x.trim()!=="" && Number.isFinite(Number(x)))
    && Number(notional)>=100 && Number(notional)<=1000000
    && [spotFee,perpFee,slippage].every(x=>Number(x)>=0 && Number(x)<=100);

  const analyze=async()=>{
    if(!inputsValid || loading)return;
    const requestId=++requestIdRef.current;
    setResult(null);setError("");setLoading(true);
    try{
      const query=new URLSearchParams({coin,days:String(days),notional,spotFeeBps:spotFee,perpFeeBps:perpFee,slippageBps:slippage});
      const response=await fetch("/api/funding?"+query.toString(),{cache:"no-store"});
      const data=await response.json();
      if(!response.ok) throw Error(typeof data?.error==="string"?data.error:"공개 데이터 조회 실패");
      if(data?.execution_mode!=="paper" || data?.live_allowed!==false || !Array.isArray(data?.curve))
        throw Error("읽기 전용 응답 형식 오류");
      if(requestId===requestIdRef.current) setResult(data as FundingResult);
    }catch(e){if(requestId===requestIdRef.current) setError(e instanceof Error?e.message:"공개 데이터 조회 실패");}
    finally{if(requestId===requestIdRef.current)setLoading(false);}
  };

  return <main className="h-full overflow-y-auto p-4 sm:p-6" style={{background:"var(--background)"}}>
    <div className="mx-auto max-w-6xl space-y-4 pb-12">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold tracking-widest" style={{color:BLUE}}><FlaskConical size={15}/> FUNDING LAB / READ ONLY</div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">펀딩비 · 헤지 순수익 분석</h1>
          <p className="mt-1 text-sm" style={{color:MUTED}}>Hyperliquid의 실제 시간별 펀딩 기록으로 1배 숏 단독과 가상 현물+숏을 비교합니다.</p>
        </div>
        <span className="flex items-center gap-2 rounded-md border px-3 py-2 text-xs font-semibold" style={{background:"#58a6ff16",borderColor:"#58a6ff55",color:BLUE}}>
          <ShieldCheck size={14}/> PAPER ONLY · 실거래 차단
        </span>
      </header>
      <div className="flex items-start gap-2 rounded-lg border p-3 text-sm" style={{borderColor:"#dca54770",background:"#dca54715"}}>
        <AlertTriangle size={17} className="mt-0.5 shrink-0" style={{color:"#eab361"}}/>
        <p><strong>생활비 안전자금은 별도 보관하세요.</strong> 본 연구는 실계좌를 조회하지 않으며, 원화 환전·세금·베이시스·실제 청산을 반영하지 않습니다.</p>
      </div>

      <section className={PANEL} style={PANEL_STYLE} aria-label="분석 설정">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="space-y-2">
            <div className="text-xs font-semibold" style={{color:MUTED}}>자산</div>
            <div className="flex gap-1" role="group" aria-label="자산 선택">
              {(["XRP","BTC","ETH"] as FundingCoin[]).map(value=><button type="button" key={value} aria-pressed={coin===value} onClick={()=>{setCoin(value);clear();}}
                className="rounded-md border px-4 py-2 text-sm font-semibold"
                style={{borderColor:coin===value?BLUE:"var(--card-border)",background:coin===value?"#58a6ff20":"transparent",color:coin===value?BLUE:"var(--foreground)"}}>{value}</button>)}
            </div>
          </div>
          <div className="space-y-2">
            <div className="text-xs font-semibold" style={{color:MUTED}}>기간</div>
            <div className="flex gap-1" role="group" aria-label="분석 기간">
              {([30,90] as FundingDays[]).map(value=><button type="button" key={value} aria-pressed={days===value} onClick={()=>{setDays(value);clear();}}
                className="rounded-md border px-4 py-2 text-sm"
                style={{borderColor:days===value?BLUE:"var(--card-border)",background:days===value?"#58a6ff20":"transparent"}}>{value}일</button>)}
            </div>
          </div>
          <NumberField label="한쪽 명목금액 (USD)" id="fund-notional" value={notional} setValue={v=>{setNotional(v);clear();}} min={100} max={1000000} step={100}/>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <NumberField label="현물 편도 수수료 (bps)" id="fund-spot-fee" value={spotFee} setValue={v=>{setSpotFee(v);clear();}} min={0} max={100} step={0.5}/>
          <NumberField label="선물 편도 수수료 (bps)" id="fund-perp-fee" value={perpFee} setValue={v=>{setPerpFee(v);clear();}} min={0} max={100} step={0.5}/>
          <NumberField label="각 주문 슬리피지 (bps)" id="fund-slippage" value={slippage} setValue={v=>{setSlippage(v);clear();}} min={0} max={100} step={0.5}/>
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs" style={{color:MUTED}}>1배 숏 담보 ≈ {inputsValid?usd(Number(notional)):"—"} · 헤지 총자본 ≈ {inputsValid?usd(Number(notional)*2):"—"}</span>
          <button type="button" onClick={analyze} disabled={loading||!inputsValid}
            className="flex items-center gap-2 rounded-md px-5 py-2.5 text-sm font-semibold disabled:opacity-40"
            style={{background:BLUE,color:"#09121c"}}><RefreshCcw size={15}/>{loading?"시간별 데이터 확인 중":"공개 데이터로 계산"}</button>
        </div>
        {!inputsValid&&<p className="mt-2 text-xs" role="alert" style={{color:"#f5af55"}}>명목금액 100~1,000,000 USD, 비용 0~100bps 범위로 입력하세요.</p>}
      </section>

      {error&&<div role="alert" className="rounded-lg border p-4 text-sm" style={{background:"#fa767614",borderColor:"#fa767666"}}>
        <strong>검증 불가</strong><p className="mt-1">{error}</p>
        <p className="mt-2 text-xs" style={{color:MUTED}}>조회 또는 시간별 데이터 완전성 검증 실패 시 수익률을 임의로 표시하지 않습니다.</p>
      </div>}
      {!result&&!loading&&!error&&<div className="rounded-lg border border-dashed px-4 py-10 text-center" style={{borderColor:"var(--card-border)"}}>
        <BarChart3 size={28} className="mx-auto" style={{color:BLUE}}/><p className="mt-3 font-medium">공개 데이터 기반 손익 비교</p>
        <p className="mt-2 text-sm" style={{color:MUTED}}>조회 버튼을 눌렀을 때만 분석하며 자산 이동이나 주문은 실행할 수 없습니다.</p>
      </div>}

      {result&&<div className="space-y-4" aria-live="polite">
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs" style={{color:MUTED}}>
          <span>{result.coin} / {result.days}일 / {result.hourly_settlements.toLocaleString("ko-KR")}시간 정산</span>
          <span>UTC {result.start_utc.slice(0,16)} — {result.end_utc.slice(0,16)}</span>
          <span>Hyperliquid 공개 API</span>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Kpi title="누적 펀딩비 (비용 전)" value={usd(result.gross_funding_usd)} detail={"단순 연환산 "+percent(result.funding_simple_annualized_pct)} icon={<Wallet size={17}/>} color={BLUE}/>
          <Kpi title={result.coin+" 1배 숏 단독"} value={usd(result.short_net_usd)} detail={percent(result.short_return_pct)+" · 숏 담보 기준"} icon={<TrendingDown size={17}/>} color={result.short_net_usd>=0?"#3fb986":"#fa7676"}/>
          <Kpi title="가상 현물 + 1배 숏" value={usd(result.hedged_net_usd)} detail={percent(result.hedged_return_on_total_capital_pct)+" · 총 투입자본 기준"} icon={<ArrowDownUp size={17}/>} color={result.hedged_net_usd>=0?"#3fb986":"#fa7676"}/>
        </div>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1.4fr_1fr]">
          <section className={PANEL} style={PANEL_STYLE}>
            <h2 className="font-semibold">누적 손익 (USD)</h2>
            <p className="mb-4 mt-1 text-xs" style={{color:MUTED}}>시간별 정산 기록을 일 단위로 집계한 가상 청산 손익</p>
            <div className="h-[270px] w-full" role="img" aria-label="펀딩비와 숏·헤지 누적손익 그래프">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={result.curve} margin={{top:10,right:10,left:10,bottom:5}}>
                  <CartesianGrid stroke="#ffffff15" vertical={false}/>
                  <XAxis dataKey="time" tickFormatter={(v:string)=>v.slice(5,10)} minTickGap={24} tick={{fill:"#a3a8b4",fontSize:11}}/>
                  <YAxis tickFormatter={(v:number)=>"$"+Math.round(v)} tick={{fill:"#a3a8b4",fontSize:11}} width={58}/>
                  <Tooltip formatter={value=>usd(Number(value??0))} labelFormatter={v=>String(v).slice(0,16)+" UTC"} contentStyle={{background:"#121923",border:"1px solid #30363d",borderRadius:8}}/>
                  <Legend wrapperStyle={{fontSize:12}}/>
                  <Line dataKey="fundingUsd" name="펀딩비" stroke={BLUE} dot={false} strokeWidth={2} isAnimationActive={false}/>
                  <Line dataKey="shortNetUsd" name="1배 숏 순손익" stroke="#fa9f69" dot={false} strokeWidth={2} isAnimationActive={false}/>
                  <Line dataKey="hedgedNetUsd" name="현물+숏 순손익" stroke="#3fb986" dot={false} strokeWidth={2} isAnimationActive={false}/>
                </LineChart>
              </ResponsiveContainer>
            </div>
          </section>
          <section className={PANEL} style={PANEL_STYLE}>
            <h2 className="mb-2 font-semibold">가격·비용·증거금</h2>
            <Metric name="가격 변화 (선물 종가 대용치)" value={percent(result.price_change_pct)}/>
            <Metric name="숏 가격 손익" value={usd(result.short_price_pnl_usd)}/>
            <Metric name="선물 왕복 수수료" value={"−"+usd(result.perp_fees_usd)}/>
            <Metric name="현물 왕복 수수료" value={"−"+usd(result.spot_fees_usd)}/>
            <Metric name="헤지 총 슬리피지" value={"−"+usd(result.slippage_usd)}/>
            <Metric name="숏 최저 가상 증거금 여유" value={result.minimum_short_equity_pct.toFixed(1)+"%"}/>
            <p className="mt-3 rounded-md p-3 text-xs" style={{color:result.short_margin_stress_warning?"#f5af55":MUTED,background:result.short_margin_stress_warning?"#f5af5514":"#58a6ff12"}}>
              {result.short_collateral_breach_in_proxy?"과거 가격 경로에서 숏 가상 담보가 소진됐습니다. 실제 포지션은 더 일찍 청산될 수 있습니다."
                :result.short_margin_stress_warning?"숏 담보 여유가 크게 감소했습니다. 실제 청산 여부는 모델링하지 않았습니다."
                :"시간봉 고가 기반의 과거 위험 근사값이며 실제 청산 가능성이 없다는 뜻은 아닙니다."}
            </p>
          </section>
        </div>
        <section className={PANEL} style={PANEL_STYLE}>
          <h2 className="mb-3 font-semibold">전제·제외한 위험</h2>
          <ul className="space-y-2 text-xs leading-relaxed" style={{color:MUTED}}>
            {result.assumptions.map((line,i)=><li key={i} className="flex gap-2"><span>•</span><span>{line}</span></li>)}
            {result.coin==="XRP"&&<li>• Hyperliquid FXRP는 XRP와 같지 않습니다. FXRP 발행·상환·유동성·디페그 위험은 미반영했습니다.</li>}
          </ul>
          <div className="mt-4 flex flex-wrap gap-4 text-xs">
            <a href="https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals" rel="noopener noreferrer" target="_blank" style={{color:BLUE}}>공식 펀딩 API ↗</a>
            <a href="https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees" rel="noopener noreferrer" target="_blank" style={{color:BLUE}}>공식 수수료 ↗</a>
          </div>
        </section>
      </div>}
    </div>
  </main>;
}
function NumberField({label,id,value,setValue,min,max,step}:{label:string;id:string;value:string;setValue:(x:string)=>void;min:number;max:number;step:number}){
  return <div className="flex min-w-[160px] flex-col gap-1.5">
    <label htmlFor={id} className="text-xs" style={{color:MUTED}}>{label}</label>
    <input id={id} type="number" min={min} max={max} step={step} value={value} onChange={e=>setValue(e.target.value)}
      className="w-full rounded-md border p-2 text-sm" style={{borderColor:"var(--card-border)",background:"var(--background)"}}/>
  </div>;
}
function Kpi({title,value,detail,icon,color}:{title:string;value:string;detail:string;icon:ReactNode;color:string}){
  return <section className={PANEL} style={PANEL_STYLE}>
    <div className="flex items-center gap-2 text-sm" style={{color:MUTED}}>{icon}{title}</div>
    <div className="mt-2 text-2xl font-bold tracking-tight tabular-nums" style={{color}}>{value}</div>
    <div className="mt-1 text-xs" style={{color:MUTED}}>{detail}</div>
  </section>;
}
function Metric({name,value}:{name:string;value:string}){
  return <div className="flex justify-between gap-3 border-b py-2 text-sm last:border-0" style={{borderColor:"var(--card-border)"}}>
    <span style={{color:MUTED}}>{name}</span><span className="text-right font-medium tabular-nums">{value}</span>
  </div>;
}
