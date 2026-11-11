import { instrument, SCALE, type Position, type Quote } from './domain';
// Convert the provider's shortest decimal Number representation (including exponent)
// to 8 decimal places using integer rounding, never binary floating multiplication.
export function quoteUnits(n: unknown): bigint {
  if(typeof n!=='number' || !Number.isFinite(n) || n<=0 || n>1e12) throw Error('잘못된 시세');
  const [mantissa, exponent='0']=String(n).toLowerCase().split('e'); const [a,b='']=mantissa.split('.');
  const digits=BigInt(a+b), shift=8+Number(exponent)-b.length;
  const result=shift>=0?digits*BigInt(10)**BigInt(shift):(digits+(BigInt(10)**BigInt(-shift))/BigInt(2))/(BigInt(10)**BigInt(-shift));
  if(result<=BigInt(0) || result>BigInt('1000000000000')*SCALE) throw Error('잘못된 시세'); return result;
}
export function validateQuote(raw: unknown, ticker: string, now=Date.now()): Quote {
  if(!raw || typeof raw!=='object') throw Error('시세 확인 불가');
  const p=raw as Record<string,unknown>, i=instrument(ticker);
  if(p.ticker!==ticker || p.currency!==i.currency || p.source!==i.source || p.providerSymbol!==i.providerSymbol || typeof p.exchange_timezone!=='string' || p.exchange_timezone.length>64) throw Error('시세 출처/통화 불일치');
  for(const k of ['as_of','fetched_at']) if(typeof p[k]!=='string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(p[k] as string) || !Number.isFinite(Date.parse(p[k] as string)) || new Date(p[k] as string).toISOString().slice(0,19)!==(p[k] as string).slice(0,19) || Date.parse(p[k] as string)>now+300000) throw Error('시세 시간 확인 불가');
  if(Date.parse(p.fetched_at as string)<now-120000 || Date.parse(p.as_of as string)>Date.parse(p.fetched_at as string)+300000) throw Error('시세 수신 시간 확인 불가');
  try {new Intl.DateTimeFormat('en',{timeZone:p.exchange_timezone});} catch {throw Error('시세 시간대 확인 불가');}
  return {price:quoteUnits(p.current_price), source:i.source,providerSymbol:i.providerSymbol,currency:i.currency,as_of:p.as_of as string,fetched_at:p.fetched_at as string,exchange_timezone:p.exchange_timezone};
}
export type QuoteResult={quotes:Record<string,Quote>;errors:Record<string,string>};
export async function loadQuotes(holdings: readonly Pick<Position,'ticker'|'currency'>[], signal: AbortSignal, fetcher: typeof fetch=fetch, timeoutMs=19000):Promise<QuoteResult> {
  if(holdings.length>10 || new Set(holdings.map(h=>h.ticker)).size!==holdings.length) throw Error('종목 한도');
  const controller=new AbortController(), abort=()=>controller.abort();
  signal.addEventListener('abort',abort,{once:true}); if(signal.aborted) abort();
  const timer=setTimeout(abort,Math.min(19000,timeoutMs)); const result:QuoteResult={quotes:{},errors:{}}; let cursor=0;
  async function worker() {while(cursor<holdings.length) {
    const h=holdings[cursor++];
    try {
      const i=instrument(h.ticker); if(i.ticker!==h.ticker || i.currency!==h.currency || controller.signal.aborted) throw Error('취소 또는 통화 불일치');
      // Only public instrument selectors leave the browser. No portfolio document.
      const url='/api/market?'+new URLSearchParams({kind:'quote',ticker:h.ticker,currency:h.currency.toLowerCase()});
      const aborted=new Promise<never>((_,reject)=>{if(controller.signal.aborted) reject(Error('취소')); else controller.signal.addEventListener('abort',()=>reject(Error('취소')),{once:true});});
      const q=await Promise.race([aborted,(async()=>{const r=await fetcher(url,{method:'GET',credentials:'same-origin',cache:'no-store',signal:controller.signal}); if(!r.ok) throw Error('시세 확인 불가'); return validateQuote(await r.json(),h.ticker);})()]);
      if(controller.signal.aborted) throw Error('취소'); result.quotes[h.ticker]=q;
    } catch {result.errors[h.ticker]='시세 확인 불가';}
  }}
  try {await Promise.all([worker(),worker()]); return result;} finally {clearTimeout(timer); signal.removeEventListener('abort',abort); controller.abort();}
}
