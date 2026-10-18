/** E2E HTTP check against ONLY an isolated localhost Next process. */
import assert from "node:assert/strict";
const base=process.env.FUNDING_GUARD_HTTP_URL;
assert.equal(base,"http://127.0.0.1:3101","Refuse remote HTTP test target");
const url=base+"/api/funding?coin=XRP&days=30&notional=10000&spotFeeBps=10&perpFeeBps=4.5&slippageBps=5";
for(let i=0;i<8;i++){
  const r=await fetch(url,{signal:AbortSignal.timeout(15000)});
  const data=await r.json();
  assert.equal(r.status,422,"Model collateral breach must suppress PnL");
  assert.equal(data.execution_mode,"paper");
  assert.equal(data.live_allowed,false);
  assert.equal(data.margin_proxy_breach,true);
  assert.equal("hedged_net_usd" in data,false);
  assert.equal("curve" in data,false);
}
const limited=await fetch(url,{signal:AbortSignal.timeout(15000)});
assert.equal(limited.status,429,"Ninth valid request must be throttled");
const retry=Number(limited.headers.get("retry-after"));
assert.ok(Number.isSafeInteger(retry)&&retry>=1&&retry<=60);
const b=await limited.json();
assert.equal(b.execution_mode,"paper");assert.equal(b.live_allowed,false);
assert.equal("hedged_net_usd" in b,false);
const invalid=await fetch(base+"/api/funding?coin=XRP&days=31",{signal:AbortSignal.timeout(15000)});
assert.equal(invalid.status,400,"Invalid days must fail validation before quota");
console.log("FUNDING_HTTP_GUARD_OK "+JSON.stringify({
  test:"isolated Next HTTP with synthetic upstream",http422:422,http429:429,
  retryAfter:retry,http400:400,valid429After:8,realOrderCalls:0
}));
