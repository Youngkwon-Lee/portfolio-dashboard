// CI-only upstream fixture. Never export synthetic data via Production API.
if (process.env.CI !== "true" || process.env.FUNDING_ROUTE_FIXTURE_MODE !== "offline-422")
  throw Error("Synthetic exchange fixture requires isolated CI process");
const HOUR=3_600_000,originalFetch=globalThis.fetch;
if (typeof originalFetch!=="function") throw Error("Node fetch unavailable");
let intercepted=0;
globalThis.fetch=async function fundingRouteFixture(url,init){
  const href=typeof url==="string"?url:url instanceof URL?url.href:url?.url;
  if (href!=="https://api.hyperliquid.xyz/info") return originalFetch.call(this,url,init);
  if (!init||init.method!=="POST"||typeof init.body!=="string") throw Error("Unexpected public info request");
  const body=JSON.parse(init.body);
  let data;
  if(body.type==="fundingHistory"&&body.coin==="XRP"){
    const first=Math.ceil(body.startTime/HOUR)*HOUR,last=Math.floor(body.endTime/HOUR)*HOUR;
    data=[];
    for(let t=first;t<=last&&data.length<500;t+=HOUR)data.push({time:t,fundingRate:"0.0001"});
  }else if(body.type==="candleSnapshot"&&body.req?.coin==="XRP"&&body.req?.interval==="1h"){
    const {startTime,endTime}=body.req;
    if(!Number.isSafeInteger(startTime)||!Number.isSafeInteger(endTime)||
       (endTime-startTime)/HOUR!==720)throw Error("Unexpected synthetic window");
    data=Array.from({length:720},(_,i)=>{const t=startTime+i*HOUR;
      return {t,T:t+HOUR-1,o:"100",h:i===12?"210":"100",l:"100",c:"100"};});
  }else throw Error("Unexpected synthetic upstream request");
  intercepted++;
  if(intercepted===1)process.stderr.write("FUNDING_ROUTE_TEST_UPSTREAM_INTERCEPTED\n");
  return new Response(JSON.stringify(data),{status:200,headers:{"content-type":"application/json"}});
};
