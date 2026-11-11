'use client';
import { useState, type FormEvent } from 'react';
import { useManualPortfolio } from './ManualPortfolioProvider';
import { decimal, instrument, money, percent, units, type Portfolio, type Position } from '@/lib/manual/domain';
import MarketSource from './MarketSource';
type Draft={raw:string|null;p:Portfolio;id:string;ticker:string;qty:string;avg:string;KRW:string;USD:string;cash:boolean};
const inputStyle={width:'100%',minWidth:0,padding:'7px',background:'var(--background)',border:'1px solid var(--card-border)',borderRadius:4};
export default function HoldingsTable() {
  const s=useManualPortfolio();const [draft,setDraft]=useState<Draft|null>(null),[error,setError]=useState('');
  function edit(h?:Position,cash=false) {setError('');setDraft({raw:s.raw,p:s.p,id:h?.id??'',ticker:h?.ticker??'',qty:h?.qty??'',avg:h?.avg??'',KRW:s.p.cash.KRW,USD:s.p.cash.USD,cash});}
  function submit(e:FormEvent) {e.preventDefault();if(!draft)return;setError('');try {
    let next:Portfolio;
    if(draft.cash) next={...draft.p,cash:{KRW:decimal(draft.KRW,'cash'),USD:decimal(draft.USD,'cash')}};
    else {const i=instrument(draft.ticker),p:Position={id:draft.id||crypto.randomUUID(),ticker:i.ticker,currency:i.currency,qty:decimal(draft.qty,'qty'),avg:decimal(draft.avg,'avg')};next={...draft.p,holdings:draft.id?draft.p.holdings.map(h=>h.id===draft.id?p:h):[...draft.p.holdings,p]};}
    if(s.save(next,draft.raw))setDraft(null);else setError('저장되지 않았습니다. 위 상태를 확인하고 편집을 다시 시작하세요.');
  }catch {setError('종목·통화·수량·단가를 확인하세요. 중복 종목/10개 초과 불가. 소수 8자리까지, 수량·단가는 0보다 커야 합니다.');}}
  const stale=draft && draft.raw!==s.raw;
  const draftCurrency=(()=>{try{return draft?instrument(draft.ticker).currency:null;}catch{return null;}})();
  return <section className="p-3 rounded-lg text-xs space-y-3" style={{background:'var(--card)',border:'1px solid var(--card-border)'}} aria-label="수동 가상 보유 종목">
    <h2 className="font-semibold">직접 입력한 보유 종목 ({s.p.holdings.length}/10)</h2>
    <p>종목 입력은 주문이 아닙니다. 잔여 현금은 자동 차감되지 않으므로 별도로 입력하세요.</p>
    <p style={{color:'var(--muted)'}}>KRX: 005930/000660 또는 6자리.KS/.KQ, 미국: 대문자 종목, 지원 가상자산: KRW만. 수량 최대 10억, 단가·현금 최대 1조, 소수 8자리. 통화는 종목으로 결정됩니다.</p>
    <div className="flex gap-3 flex-wrap"><button className="underline" disabled={!s.ready||!!s.error||s.p.holdings.length>=10} onClick={()=>edit()}>종목 추가</button><button className="underline" disabled={!s.ready||!!s.error} onClick={()=>edit(undefined,true)}>잔여 현금 편집</button></div>
    {draft && <form onSubmit={submit} className="space-y-2" aria-label={draft.cash?'잔여 현금 편집':'종목 편집'}>
      {stale && <p role="alert">다른 변경이 있습니다. 이 편집은 저장할 수 없습니다. 취소 후 다시 시작하세요.</p>}
      {(draft.cash?['KRW','USD'] as const:['ticker','qty','avg'] as const).map(field=><label key={field} className="block">{{KRW:'잔여 현금 KRW',USD:'잔여 현금 USD',ticker:'종목 코드 (대문자)',qty:'보유 수량',avg:`평균 매입단가 (${draftCurrency??'종목 확인 필요'})`}[field]}<input autoFocus={field===(draft.cash?'KRW':'ticker')} style={inputStyle} inputMode={field==='ticker'?'text':'decimal'} required maxLength={field==='ticker'?12:24} value={draft[field as keyof Pick<Draft,'KRW'|'USD'|'ticker'|'qty'|'avg'>]} onChange={e=>{const value=e.target.value; let resetAvg=false; if(field==='ticker'){try{resetAvg=instrument(value).currency!==instrument(draft.ticker).currency;}catch{resetAvg=true;}} setDraft({...draft,[field]:value,...(resetAvg?{avg:''}:{})});}}/></label>)}
      {error && <p role="alert">{error}</p>}<button type="submit" disabled={!!stale||!!s.error} className="underline">브라우저에 저장</button>{' '}<button type="button" className="underline" onClick={()=>setDraft(null)}>취소</button>
    </form>}
    {!s.p.holdings.length && <p>입력한 종목 없음 · 샘플 잔고를 만들지 않습니다.</p>}
    {s.p.holdings.map(h=>{const q=s.quotes[h.ticker],cost=units(h.qty)*units(h.avg),value=q?units(h.qty)*q.price:null;return <article key={h.id} className="border-t pt-3 space-y-1 break-words" style={{borderColor:'var(--card-border)'}}>
      <h3 className="font-bold">{h.ticker} · {h.currency}</h3><p>수량 {h.qty} · 평균 단가 {h.avg} {h.currency}</p><p>원가 {money(cost,h.currency)}</p><p>평가액 {value===null?(s.loading?'조회 중':'확인 불가'):money(value,h.currency)}</p><p>보유손익 {value===null?'확인 불가':money(value-cost,h.currency)} · {value===null?'확인 불가':percent(value-cost,cost)}</p>
      {q && <details><summary>시세 출처·기준시각</summary><MarketSource data={q}/></details>}
      <button className="underline" onClick={()=>edit(h)} disabled={!!s.error}>편집 {h.ticker}</button>{' '}<button className="underline" disabled={!!s.error} onClick={()=>{if(window.confirm(`${h.ticker} 수동 가상 종목을 삭제할까요?`))s.save({...s.p,holdings:s.p.holdings.filter(p=>p.id!==h.id)},s.raw);}}>삭제 {h.ticker}</button>
    </article>;})}
  </section>;
}
