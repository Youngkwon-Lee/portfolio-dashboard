/**
 * Run against a built, locally served Next.js Funding Lab on GitHub Actions.
 * Headless Chrome tests the real React UI. Screenshots bearing the "mock"
 * suffix contain deterministic fixture data, NOT live exchange results.
 * It also separately checks a genuine read-only public /api/funding request.
 */
import assert from "node:assert/strict";
import { mkdir, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";

const baseUrl=process.env.FUNDING_TEST_URL ?? "http://127.0.0.1:3100";
const screenshotDir="funding-ui-artifacts";
const executable=process.env.CHROME_BIN
  ?? ["/usr/bin/google-chrome","/usr/bin/chromium","/usr/bin/chromium-browser"]
      .find(p=>{try { return requirePath(p); }catch {return false;}});
function requirePath(p) {
  // Lightweight executable check without adding a CLI dependency.
  return existsSync(p);
}

function fakeResult(coin,days){
  const end=Date.parse("2026-10-16T09:00:00.000Z");
  const start=end-days*86400000;
  const net=coin==="XRP"?55.24:coin==="ETH"?35.92:28.77;
  return {
    execution_mode:"paper",live_allowed:false,
    source:"E2E FIXTURE (NOT LIVE)",
    coin,days,notional_usd:10000,combined_capital_usd:20000,
    start_utc:new Date(start).toISOString(),end_utc:new Date(end).toISOString(),
    hourly_settlements:days*24,first_funding_utc:new Date(start+3600000).toISOString(),
    last_funding_utc:new Date(end).toISOString(),entry_price_proxy:1,
    exit_price_proxy:1,price_change_pct:0,funding_rate_sum_pct:0.9,
    funding_simple_annualized_pct:11.1,gross_funding_usd:105.36,
    spot_price_pnl_usd:0,short_price_pnl_usd:0,perp_fees_usd:9,
    spot_fees_usd:20,slippage_usd:20,short_net_usd:86.36,
    hedged_net_usd:net,short_return_pct:0.8636,
    hedged_return_on_total_capital_pct:Number((net/200).toFixed(4)),
    minimum_short_equity_pct:86,short_collateral_breach_in_proxy:false,
    short_margin_stress_warning:false,
    assumptions:["Deterministic E2E browser test fixture — do not infer investment returns."],
    curve:Array.from({length:days+1},(_,i)=>({
      time:new Date(start+i*86400000).toISOString(),
      fundingUsd:Number((105.36*i/days).toFixed(2)),
      shortNetUsd:Number((86.36*i/days).toFixed(2)),
      hedgedNetUsd:Number((net*i/days).toFixed(2)),
      shortMarginEquityUsd:10000
    }))
  };
}
function labelScreenshot(page) {
  return page.evaluate(()=>{
    if (document.getElementById("funding-browser-fixture-watermark")) return;
    const el=document.createElement("div");
    el.id="funding-browser-fixture-watermark";
    el.textContent="BROWSER TEST FIXTURE · NOT LIVE INVESTMENT DATA";
    Object.assign(el.style,{
      position:"fixed",top:"4px",left:"8px",padding:"5px 9px",background:"#3b1d09",
      color:"#ffe0ad",font:"bold 11px sans-serif",borderRadius:"4px",
      zIndex:"99999",pointerEvents:"none"
    });
    document.body.appendChild(el);
  });
}
const browser=await chromium.launch({
  executablePath:executable,
  headless:true,args:["--no-sandbox","--disable-dev-shm-usage"]
});
await mkdir(screenshotDir,{recursive:true});
const page=await browser.newPage({viewport:{width:1320,height:1500},deviceScaleFactor:1});
let mockedRequests=0, mode="success";
const timeout=45_000;
try{
  await page.goto(baseUrl,{waitUntil:"domcontentloaded",timeout});
  await page.getByRole("button",{name:"펀딩비",exact:true}).click({timeout});
  await page.getByRole("heading",{name:"펀딩비 · 헤지 순수익 분석"}).waitFor({timeout});
  assert.equal(await page.getByText("PAPER ONLY · 실거래 차단").count(),1);
  assert.equal(await page.getByText("공개 데이터 기반 손익 비교").count(),1);
  await page.route("**/api/funding?**",async route=>{
    mockedRequests++;
    const reqUrl=new URL(route.request().url());
    if(mode==="error"){
      return route.fulfill({
        status:503,contentType:"application/json",
        body:JSON.stringify({error:"공개 데이터 불완전: 모의 에러 응답"})
      });
    }
    const coin=reqUrl.searchParams.get("coin");
    const days=Number(reqUrl.searchParams.get("days"));
    assert.ok(["BTC","ETH","XRP"].includes(coin));
    assert.ok([30,90].includes(days));
    return route.fulfill({
      status:200,contentType:"application/json",
      body:JSON.stringify(fakeResult(coin,days))
    });
  });
  const run=page.getByRole("button",{name:"공개 데이터로 계산"});
  await run.click();
  await page.getByText("720시간 정산",{exact:false}).waitFor({timeout});
  await page.getByText("$55.24",{exact:true}).waitFor({timeout});
  assert.ok(await page.getByRole("img",{name:"펀딩비와 숏·헤지 누적손익 그래프"}).isVisible());
  await labelScreenshot(page);
  await page.screenshot({path:screenshotDir+"/funding-desktop-MOCK.png",fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:screenshotDir+"/funding-mobile-MOCK.png",fullPage:true});
  const width=await page.evaluate(()=>({
    innerWidth:window.innerWidth,
    scrollWidth:document.documentElement.scrollWidth
  }));
  if(width.scrollWidth>width.innerWidth+12) console.warn("MOBILE_OVERFLOW="+JSON.stringify(width));

  // State mutations must invalidate results; 90d requests use real UI inputs.
  await page.getByRole("button",{name:"BTC",exact:true}).click();
  assert.equal(await page.getByText("$55.24",{exact:true}).count(),0);
  await page.getByRole("button",{name:"90일",exact:true}).click();
  await run.click();
  await page.getByText("2,160시간 정산",{exact:false}).waitFor({timeout});
  await page.getByText("$28.77",{exact:true}).waitFor({timeout});

  await page.locator("#fund-notional").fill("0");
  assert.ok(await run.isDisabled(),"Invalid notional should disable analysis");
  await page.locator("#fund-notional").fill("10000");

  mode="error";
  await run.click();
  await page.getByText("검증 불가",{exact:true}).waitFor({timeout});
  await page.getByText("공개 데이터 불완전: 모의 에러 응답").waitFor({timeout});
  assert.equal(await page.getByText("$28.77",{exact:true}).count(),0);
  assert.ok(mockedRequests>=3,"Expected valid, alternative, failure browser requests");
  await page.unroute("**/api/funding?**");
  await page.evaluate(()=>document.getElementById("funding-browser-fixture-watermark")?.remove());

  // This final request does NOT use a fixture. It exercises the actual Next
  // public route and the external Hyperliquid unauthenticated API.
  await page.setViewportSize({width:1320,height:1500});
  await page.getByRole("button",{name:"XRP",exact:true}).click();
  await page.getByRole("button",{name:"30일",exact:true}).click();
  const pending=page.waitForResponse(r=>r.url().includes("/api/funding?"),{timeout:75000});
  await run.click();
  const response=await pending;
  const live=await response.json();
  if(response.status()!==200){
    throw Error("LIVE_PUBLIC_API_FAILED status="+response.status()+
      " message="+String(live.error??"unknown"));
  }
  assert.equal(live.execution_mode,"paper");
  assert.equal(live.live_allowed,false);
  assert.equal(live.coin,"XRP");
  assert.equal(live.days,30);
  assert.equal(live.hourly_settlements,720);
  await page.getByText("720시간 정산",{exact:false}).waitFor({timeout});
  await page.getByRole("img",{name:"펀딩비와 숏·헤지 누적손익 그래프"}).waitFor({timeout});
  await page.screenshot({path:screenshotDir+"/funding-desktop-LIVE-PUBLIC.png",fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:screenshotDir+"/funding-mobile-LIVE-PUBLIC.png",fullPage:true});
  const fundingMain=page.locator("main").first();
  await fundingMain.evaluate(element=>{element.scrollTop=550;});
  await page.waitForTimeout(250);
  await page.screenshot({path:screenshotDir+"/funding-mobile-LIVE-PUBLIC-results.png",fullPage:true});
  console.log("FUNDING_UI_SMOKE_OK "+JSON.stringify({
    browser:"headless Chrome",screenshots:5,fixtures:mockedRequests,
    verified_live_exchange_hours:live.hourly_settlements,
    live_coin:live.coin,live_days:live.days,execution_mode:live.execution_mode,
    live_hedged_net_usd:live.hedged_net_usd,mobile_overflow:width
  }));
}catch(e){
  console.error("FUNDING_UI_SMOKE_FAILED "+String(e));
  try{await page.screenshot({path:screenshotDir+"/funding-failure.png",fullPage:true});}catch{}
  process.exitCode=1;
}finally{
  await browser.close();
}
