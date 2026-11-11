'use client';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { decode, emptyPortfolio, resetPortfolio, STORAGE_KEY, writePortfolio, type Portfolio } from '@/lib/manual/domain';
import { loadQuotes, type QuoteResult } from '@/lib/manual/quotes';
function useLocalPaper() {
  const [document,setDocument]=useState<{raw:string|null;p:Portfolio;ready:boolean;error:string}>({raw:null,p:emptyPortfolio(),ready:false,error:''});
  const [notice,setNotice]=useState('');
  function read() {try {const raw=window.localStorage.getItem(STORAGE_KEY); try {setDocument({raw,p:decode(raw),ready:true,error:''});} catch {setDocument({raw,p:emptyPortfolio(),ready:true,error:'저장 데이터가 손상되었거나 지원하지 않는 버전입니다. 원본을 보존하며 편집을 차단합니다.'});}} catch {setDocument({raw:null,p:emptyPortfolio(),ready:false,error:'브라우저 저장소를 사용할 수 없습니다. 저장되지 않았습니다.'});}}
  useEffect(()=>{read(); const onStorage=(e:StorageEvent)=>{if(e.key===STORAGE_KEY || e.key===null) {read();setNotice('다른 탭의 변경을 불러왔습니다. 열린 편집은 다시 시작하세요.');}}; window.addEventListener('storage',onStorage);return()=>window.removeEventListener('storage',onStorage);},[]);
  function save(p:Portfolio, expected:string|null) {setNotice('');try {if(!document.ready || document.error || expected!==document.raw) throw Error('최신 내용을 확인하고 편집을 다시 시작하세요.'); const raw=writePortfolio(window.localStorage,expected,p);setDocument({raw,p:decode(raw),ready:true,error:''});setNotice('이 브라우저에 저장했습니다.');return true;} catch(e) {read();setNotice(e instanceof Error?e.message:'저장 실패');return false;}}
  function reset(expected:string|null) {try {if(expected!==document.raw) throw Error('확인 후 다른 탭에서 변경되었습니다. 취소하고 최신 내용을 확인한 뒤 다시 초기화하세요.'); resetPortfolio(window.localStorage,expected);read();setNotice('이 브라우저의 수동 가상 데이터만 초기화했습니다.');return true;} catch(e) {read();setNotice(e instanceof Error?e.message:'초기화 실패');return false;}}
  const [retry,setRetry]=useState(0);
  const key=JSON.stringify(document.p.holdings.map(h=>({ticker:h.ticker,currency:h.currency})));
  const [result,setResult]=useState<{key:string;data:QuoteResult;loading:boolean}>({key:'',data:{quotes:{},errors:{}},loading:false});
  useEffect(()=>{let active=true; let timer:ReturnType<typeof setTimeout>; const controller=new AbortController();
    async function refresh() {setResult({key,data:{quotes:{},errors:{}},loading:true}); const data=await loadQuotes(JSON.parse(key),controller.signal);if(!active)return;setResult({key,data,loading:false});timer=setTimeout(refresh,30000);}
    void refresh(); return()=>{active=false;controller.abort();clearTimeout(timer);};
  },[key,retry]);
  const state=result.key===key?result:{key,data:{quotes:{},errors:{}},loading:true};
  return {...document,notice,save,reset,quotes:state.data.quotes,quoteErrors:state.data.errors,loading:state.loading,retry:()=>setRetry(n=>n+1)};
}
const Context=createContext<ReturnType<typeof useLocalPaper>|null>(null);
export function ManualPortfolioProvider({children}:{children:ReactNode}) {const value=useLocalPaper();return <Context.Provider value={value}>{children}</Context.Provider>;}
export function useManualPortfolio() {const value=useContext(Context);if(!value)throw Error('Manual provider missing');return value;}
