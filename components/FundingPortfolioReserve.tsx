"use client";
import {useState} from "react";
import {parseReserveSnapshot,evaluateReserve,type ReserveResult} from "@/lib/funding-portfolio-reserve";
const krw=(v:number)=>"₩"+Math.round(v).toLocaleString("ko-KR");
export default function FundingPortfolioReserve(){
 const [result,setResult]=useState<ReserveResult|null>(null);
 const [error,setError]=useState("");
 const [loading,setLoading]=useState(false);
 async function open(file:File|undefined){
  setResult(null);setError("");
  if(!file)return;
  if(!file.name.toLowerCase().endsWith(".json")||file.size>50000){
   setError("50KB 이하의 로컬 JSON 파일만 허용합니다.");return;
  }
  setLoading(true);
  try{
   const input=parseReserveSnapshot(await file.text());
   setResult(evaluateReserve(input));
  }catch(e){setError(e instanceof Error?e.message:"입력 오류");}
  finally{setLoading(false);}
 }
 return <section className="rounded-lg border p-4 space-y-3" style={{background:"var(--card)",borderColor:"var(--card-border)"}} aria-label="생활비 안전자금과 크립토 투자 한도">
  <h2 className="font-semibold">생활비 안전자금 · 크립토 투자 한도</h2>
  <p className="text-xs" style={{color:"var(--muted)"}}>
   실제 거래소·보유 수량·현금 정보는 아직 연결되지 않았습니다. 기존 화면의 모의 잔고를 실제 자산으로 사용하지 않습니다.
   은행 원화와 즉시 인출 가능한 예금만 생활비 안전자금으로 계산하며, 스테이블코인과 거래소 잔고는 제외합니다.
  </p>
  <label className="flex flex-col gap-1 text-xs">개인 포트폴리오 JSON (로컬 전용, 최대 50KB)
   <input type="file" accept=".json,application/json" aria-label="포트폴리오 로컬 파일"
    disabled={loading} onChange={e=>{void open(e.target.files?.[0]);e.target.value="";}}
    className="rounded-md border p-2 text-sm" style={{borderColor:"var(--card-border)"}}/>
  </label>
  <p className="text-xs" style={{color:"var(--muted)"}}>
   파일은 브라우저 메모리에서만 처리합니다. 업로드·저장·거래소 연결·주문이 없습니다.
   지갑 주소·계좌번호·API 키·개인식별정보를 파일에 포함하지 마세요.
  </p>
  {error&&<p role="alert" className="text-xs" style={{color:"#fa7676"}}>파일 검증 실패: {error}</p>}
  {result&&<div className="space-y-3" aria-live="polite">
   <p className="text-xs font-semibold" style={{color:"#e5b567"}}>사용자 제공 미검증 자료 · PAPER ONLY</p>
   <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
    <div><div className="text-xs" style={{color:"var(--muted)"}}>필요 안전자금</div><strong>{krw(result.safetyTargetKrw)}</strong></div>
    <div><div className="text-xs" style={{color:"var(--muted)"}}>사용 가능한 원화</div><strong>{krw(result.eligibleCashKrw)}</strong></div>
    <div><div className="text-xs" style={{color:"var(--muted)"}}>안전자금 부족액</div><strong>{krw(result.safetyGapKrw)}</strong></div>
    <div><div className="text-xs" style={{color:"var(--muted)"}}>모의 전략 배정 상한</div><strong>{krw(result.fundingStrategyBudgetKrw)}</strong></div>
   </div>
   {!result.reserveCovered?
    <p role="alert" className="text-sm" style={{color:"#fa7676"}}>
     원화 생활비 안전자금이 부족합니다. 펀딩비 전략 신규 배정 한도는 0원입니다.
    </p>:
    <p className="text-xs">입력한 안전자금 목표는 충족됐습니다. 전략 배정은 자동 승인되지 않습니다.</p>}
   <p className="text-xs">
    유동 크립토 {krw(result.liquidCryptoKrw)} · 잠금/담보/인출 지연 {krw(result.illiquidOrEncumberedCryptoKrw)} ·
    스테이블코인 노출 {krw(result.stablecoinExposureKrw)}
   </p>
   <p className="text-xs">
    가상 현물 예산 {krw(result.spotLegBudgetKrw)} · 별도 1배 숏 담보 {krw(result.shortCollateralBudgetKrw)}.
    실제 배정이나 주문은 수행되지 않습니다.
   </p>
  </div>}
 </section>;
}
