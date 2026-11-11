'use client';
import { useState } from 'react';
import { useManualPortfolio } from './ManualPortfolioProvider';
import { money, percent, totals, type Currency } from '@/lib/manual/domain';
export default function PortfolioSummary() {
  const s=useManualPortfolio(); const [confirm,setConfirm]=useState<{raw:string|null}|null>(null);
  return <section className="p-3 rounded-lg text-xs space-y-3" style={{background:'var(--card)',border:'1px solid var(--card-border)'}} aria-label="수동 가상 포트폴리오 요약">
    <h2 className="font-semibold" style={{color:'var(--accent-blue)'}}>수동 가상 · 실계좌 아님</h2>
    <p>이 브라우저에만 저장 · 기기 간 동기화 안 됨</p><p style={{color:'var(--muted)'}}>암호화되지 않은 localStorage입니다. 브라우저 데이터 삭제 시 사라집니다. 공유 기기 사용에 주의하세요. 계좌번호·비밀번호·API 키는 입력하지 마세요.</p>
    {s.error && <p role="alert">{s.error}</p>}{s.notice && <p role="status">{s.notice}</p>}
    {!s.ready && !s.error && <p>로컬 데이터 불러오는 중</p>}
    {s.ready && !s.error && (['KRW','USD'] as Currency[]).map(c=>{const t=totals(s.p,s.quotes,c);return <div key={c} className="border-t pt-2 space-y-1" style={{borderColor:'var(--card-border)'}}>
      <h3 className="font-bold">{c} · 환산 없음</h3>
      <p>총 자산: {t.total===null?'확인 불가':money(t.total,c)}</p>
      <p>보유 평가액: {t.value===null?'확인 불가':money(t.value,c)}</p>
      <p>입력 보유 원가: {money(t.cost,c)}</p><p>입력 잔여 현금: {money(t.cash,c)}</p>
      <p>보유평가손익: {t.pnl===null?'확인 불가':money(t.pnl,c)}</p><p>보유수익률: {t.pnl===null?'확인 불가':percent(t.pnl,t.cost)}</p>
      {!t.complete && <p style={{color:'var(--accent-red)'}}>일부 시세 {s.loading?'조회 중':'누락'}. 부분 합계를 총액으로 표시하지 않습니다.</p>}
    </div>;})}
    <p style={{color:'var(--muted)'}}>통화별 표시 · 환율 환산 없음 · 수익률은 현금 제외. 미실현 손익입니다. 수수료·세금·배당·분할·실현손익은 자동 반영하지 않습니다.</p>
    <button type="button" className="underline" onClick={s.retry} disabled={s.loading}>시세 다시 조회</button>
    <p>공개 시세만 약 30초 간격 조회 · 실시간 보장 아님</p>
    <button type="button" className="underline" onClick={()=>setConfirm({raw:s.raw})}>로컬 데이터 초기화</button>
    {confirm && <div role="group" aria-label="초기화 확인" className="space-y-2"><p>이 브라우저의 수동 가상 종목과 현금을 모두 삭제할까요? 되돌릴 수 없습니다.</p><button autoFocus type="button" onClick={()=>{if(s.reset(confirm.raw))setConfirm(null);}}>삭제 확인</button>{' '}<button type="button" onClick={()=>setConfirm(null)}>취소</button></div>}
  </section>;
}
