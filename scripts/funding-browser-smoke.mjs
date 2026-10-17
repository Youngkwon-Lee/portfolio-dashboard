/**
 * Run against a built, locally served Next.js Funding Lab on GitHub Actions.
 * Headless Chrome tests the real React UI. Screenshots bearing the "mock"
 * suffix contain deterministic fixture data, NOT live exchange results.
 * It also separately checks a genuine read-only public /api/funding request.
 */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
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

function fakeResult(coin,days,notional){
  // Values are synthetic and scale with the total-paper-capital control;
  // the 1x short receives the same notional as the spot leg.
  const end=Date.parse("2026-10-16T09:00:00.000Z");
  const start=end-days*86400000;
  const scale=notional/10000;
  const round=n=>Number(n.toFixed(2));
  const baseNet=coin==="XRP"?55.24:coin==="ETH"?35.92:28.77;
  const funding=round((baseNet+49)*scale);
  const shortNet=round((baseNet+30)*scale);
  const net=round(baseNet*scale);
  return {
    execution_mode:"paper",live_allowed:false,
    source:"E2E FIXTURE (NOT LIVE)",
    coin,days,notional_usd:notional,combined_capital_usd:notional*2,
    start_utc:new Date(start).toISOString(),end_utc:new Date(end).toISOString(),
    hourly_settlements:days*24,first_funding_utc:new Date(start+3600000).toISOString(),
    last_funding_utc:new Date(end).toISOString(),entry_price_proxy:1,
    exit_price_proxy:1,price_change_pct:0,funding_rate_sum_pct:0.9,
    funding_simple_annualized_pct:11.1,gross_funding_usd:funding,
    spot_price_pnl_usd:0,short_price_pnl_usd:0,perp_fees_usd:round(9*scale),
    spot_fees_usd:round(20*scale),slippage_usd:round(20*scale),
    short_net_usd:shortNet,hedged_net_usd:net,short_return_pct:Number((shortNet/notional*100).toFixed(4)),
    hedged_return_on_total_capital_pct:Number((net/(notional*2)*100).toFixed(4)),
    minimum_short_equity_pct:86,short_collateral_breach_in_proxy:false,
    short_margin_stress_warning:false,
    assumptions:["Deterministic E2E browser test fixture — do not infer investment returns."],
    curve:Array.from({length:days+1},(_,i)=>({
      time:new Date(start+i*86400000).toISOString(),
      fundingUsd:round(funding*i/days),
      shortNetUsd:round(shortNet*i/days),
      hedgedNetUsd:round(net*i/days),
      shortMarginEquityUsd:round(notional*.86)
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
  assert.equal(await page.locator("#fund-total-capital").inputValue(),"500",
    "The default is $500 TOTAL paper capital, not per-leg notional");
  assert.ok(await page.getByText("가상 현물 ≈ $250.00",{exact:false}).count()>0);
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
    assert.equal(reqUrl.searchParams.get("notional"),"250",
      "UI must transmit half of the $500 total budget to the single-leg API");
    return route.fulfill({
      status:200,contentType:"application/json",
      body:JSON.stringify(fakeResult(coin,days,250))
    });
  });
  const run=page.getByRole("button",{name:"공개 데이터로 계산"});
  await run.click();
  await page.getByText("720시간 정산",{exact:false}).waitFor({timeout});
  await page.getByText("$1.38",{exact:true}).waitFor({timeout});
  assert.ok(await page.getByRole("img",{name:"1배 숏 단독 순손익 그래프"}).isVisible());
  assert.ok(await page.getByRole("img",{name:"펀딩비와 헤지 순손익 그래프"}).isVisible());
  await labelScreenshot(page);
  const responsiveChecks=[];
  // Regress 4 layout widths, including narrow phones and tablet.
  for (const widthPx of [320,390,768,1440]) {
    await page.setViewportSize({width:widthPx,height:900});
    await page.waitForTimeout(350); // allow chart resize observer to settle
    // On 320px screens the results are below an INNER scrolling <main>.
    // Explicitly scroll the real chart into view before asserting rendering.
    const hedgeChart=page.getByRole("img",{name:"펀딩비와 헤지 순손익 그래프"});
    const shortChart=page.getByRole("img",{name:"1배 숏 단독 순손익 그래프"});
    await hedgeChart.scrollIntoViewIfNeeded({timeout});
    await shortChart.scrollIntoViewIfNeeded({timeout});
    await page.waitForTimeout(450);
    const bounds=await page.evaluate(()=>{
      const main=document.querySelector("main");
      // TopBar also contains a small Recharts sparkline (14px on phones).
      // Never measure the first Recharts SVG globally: scope to Funding Lab.
      const chartElements=[
        document.querySelector('[role="img"][aria-label="펀딩비와 헤지 순손익 그래프"]'),
        document.querySelector('[role="img"][aria-label="1배 숏 단독 순손익 그래프"]')
      ];
      const responsiveWidths=chartElements.map(el=>el?.querySelector(".recharts-responsive-container")?.getBoundingClientRect().width??0);
      const chartWidths=chartElements.map(el=>el?.getBoundingClientRect().width??0);
      const chartHeights=chartElements.map(el=>el?.getBoundingClientRect().height??0);
      const lineCurves=chartElements.map(el=>[...(el?.querySelectorAll("path.recharts-line-curve")??[])]
        .filter(path=>(path.getAttribute("d")??"").length>10));
      const flatLines=lineCurves.flat();
      return {
        viewport:window.innerWidth,
        pageScrollWidth:document.documentElement.scrollWidth,
        mainClientWidth:main?.clientWidth??0,
        mainScrollWidth:main?.scrollWidth??0,
        responsiveWidth:Math.min(...responsiveWidths),
        chartContainerWidth:Math.min(...chartWidths),
        chartHeight:Math.min(...chartHeights),
        hedgeCurveCount:lineCurves[0].length,
        shortCurveCount:lineCurves[1].length,
        renderedCurveCount:flatLines.length,
        widestCurve:Math.max(0,...flatLines.map(path=>path.getBoundingClientRect().width)),
        mainScrollTop:main?.scrollTop??0,
      };
    });
    console.log("FUNDING_RESPONSIVE_CHECK="+JSON.stringify(bounds));
    assert.equal(bounds.viewport,widthPx);
    assert.ok(bounds.pageScrollWidth<=widthPx+2,
      "Document overflows horizontally at "+widthPx+"px: "+JSON.stringify(bounds));
    assert.ok(bounds.mainScrollWidth<=bounds.mainClientWidth+2,
      "Funding page overflows horizontally at "+widthPx+"px: "+JSON.stringify(bounds));
    assert.ok(bounds.chartContainerWidth>170 && bounds.responsiveWidth>170,
      "Funding chart container missing at "+widthPx+"px: "+JSON.stringify(bounds));
    assert.ok(bounds.hedgeCurveCount===2 && bounds.shortCurveCount===1 && bounds.renderedCurveCount===3 && bounds.widestCurve>70,
      "Funding chart data curves not rendered at "+widthPx+"px: "+JSON.stringify(bounds));
    assert.ok(await run.isVisible(),"Analyze button hidden at "+widthPx+"px");
    await page.screenshot({
      path:screenshotDir+"/funding-responsive-"+widthPx+"-MOCK.png",fullPage:true
    });
    responsiveChecks.push(bounds);
  }

  // Changing any input must invalidate stale KPI and graph results.
  await page.getByRole("button",{name:"BTC",exact:true}).click();
  assert.equal(await page.getByText("$1.38",{exact:true}).count(),0);
  // Exercise the real React state + chart for every coin and both windows.
  // Market responses in this loop are clearly-labeled synthetic E2E fixtures.
  const caseResults=[];
  for (const coin of ["XRP","BTC","ETH"]) {
    await page.getByRole("button",{name:coin,exact:true}).click();
    for (const days of [30,90]) {
      await page.getByRole("button",{name:days+"일",exact:true}).click();
      assert.equal(await page.getByRole("button",{name:coin,exact:true}).getAttribute("aria-pressed"),"true");
      assert.equal(await page.getByRole("button",{name:days+"일",exact:true}).getAttribute("aria-pressed"),"true");
      await run.click();
      const count=(days*24).toLocaleString("en-US");
      await page.getByText(count+"시간 정산",{exact:false}).waitFor({timeout});
      const expected=coin==="XRP"?"$1.38":coin==="BTC"?"$0.72":"$0.90";
      await page.getByText(expected,{exact:true}).waitFor({timeout});
      assert.ok(await page.getByRole("img",{name:"펀딩비와 헤지 순손익 그래프"}).isVisible());
      caseResults.push({coin,days,records:days*24,fixture:true});
    }
  }

  await page.locator("#fund-total-capital").fill("0");
  assert.ok(await run.isDisabled(),"Invalid notional should disable analysis");
  await page.locator("#fund-total-capital").fill("500");

  mode="error";
  await run.click();
  await page.getByText("검증 불가",{exact:true}).waitFor({timeout});
  await page.getByText("공개 데이터 불완전: 모의 에러 응답").waitFor({timeout});
  assert.equal(await page.getByText("$0.90",{exact:true}).count(),0);
  assert.ok(mockedRequests>=8,"Expected 6 combinations, initial success and failure requests");
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
  await page.getByRole("img",{name:"펀딩비와 헤지 순손익 그래프"}).waitFor({timeout});
  await page.getByRole("img",{name:"1배 숏 단독 순손익 그래프"}).waitFor({timeout});
  await page.screenshot({path:screenshotDir+"/funding-desktop-LIVE-PUBLIC.png",fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:screenshotDir+"/funding-mobile-LIVE-PUBLIC.png",fullPage:true});
  const fundingMain=page.locator("main").first();
  await fundingMain.evaluate(element=>{element.scrollTop=550;});
  await page.waitForTimeout(250);
  await page.screenshot({path:screenshotDir+"/funding-mobile-LIVE-PUBLIC-results.png",fullPage:true});
  // Offline research upload-free test: browser File.text() only, not a network request.
  // This is synthetic input, NOT historical exchange data.
  const localStart=Date.parse("2026-07-01T00:00:00.000Z");
  const localEnd=localStart+30*24*3600000;
  const localFixture={
    format:"quant-lab-funding-bundle-v1",venue:"Binance",coin:"XRP",days:30,
    start:localStart,end:localEnd,notionalUsd:10000,
    sourceUrl:"https://data.binance.vision/data/futures/um/",
    downloadedAt:"2026-10-17T04:00:00Z",
    funding:Array.from({length:90},(_,i)=>({
      time:localStart+(i+1)*8*3600000,rate:0.0001
    })),
    entry:{time:localStart,spot:99,perp:100},
    exit:{time:localEnd,spot:104,perp:106}
  };
  const fileControl=page.getByLabel("로컬 연구 파일");
  await fileControl.scrollIntoViewIfNeeded({timeout});
  let localUploadRequests=0;
  const uploadWatch=req=>{
    if(req.method()!=="GET" && !req.url().includes("api.hyperliquid.xyz"))
      localUploadRequests++;
  };
  page.on("request",uploadWatch);
  await fileControl.setInputFiles({
    name:"LOCAL-SYNTHETIC-FIXTURE.json",mimeType:"application/json",
    buffer:Buffer.from(JSON.stringify(localFixture))
  });
  await page.getByText("사용자 제공 데이터 · 독립 검증 전").waitFor({timeout});
  await page.getByText("Binance XRP · 30일 · 90건").waitFor({timeout});
  assert.equal(localUploadRequests,0,"Local file unexpectedly caused non-GET request");
  await labelScreenshot(page);
  await page.screenshot({path:screenshotDir+"/funding-local-file-SYNTHETIC-MOCK.png",fullPage:true});
  await fileControl.setInputFiles({
    name:"LOCAL-INVALID.json",mimeType:"application/json",
    buffer:Buffer.from(JSON.stringify({...localFixture,apiKey:"must-not-be-accepted"}))
  });
  await page.getByText("로컬 데이터 거부:",{exact:false}).waitFor({timeout});
  assert.equal(await page.getByText("사용자 제공 데이터 · 독립 검증 전").count(),0);
  assert.equal(localUploadRequests,0,"Invalid local file unexpectedly caused network request");
  page.removeListener("request",uploadWatch);
  await page.evaluate(()=>document.getElementById("funding-browser-fixture-watermark")?.remove());
  // New hourly margin-risk panel: synthetic 720-hour OHLC input, no upload.
  const hourMs=3600000,firstHour=Date.parse("2026-07-01T00:00:00Z");
  const riskBundle={
    format:"quant-lab-hourly-path-v1",venue:"OKX",coin:"XRP",days:30,
    start:firstHour,end:firstHour+720*hourMs,notionalUsd:10000,
    sourceUrl:"https://www.okx.com/",
    funding:Array.from({length:90},(_,i)=>({time:firstHour+(i+1)*8*hourMs,rate:.0001})),
    candles:Array.from({length:720},(_,i)=>({
      time:firstHour+i*hourMs,
      spot:{open:100,high:100,low:100,close:100},
      perp:{open:100,high:100,low:100,close:100}
    }))
  };
  const riskFile=page.getByLabel("시간별 위험 연구 파일");
  await riskFile.scrollIntoViewIfNeeded({timeout});
  let riskNonGet=0;
  const riskListener=req=>{if(req.method()!=="GET")riskNonGet++;};
  page.on("request",riskListener);
  await riskFile.setInputFiles({
    name:"SYNTHETIC-hourly-720.json",mimeType:"application/json",
    buffer:Buffer.from(JSON.stringify(riskBundle))
  });
  await page.getByText("사용자 제공 자료 · 원본 진위 미확인 · PAPER ONLY").waitFor({timeout});
  await page.getByText("관측 시간봉 고가에서 가정한 증거금 버퍼 소진은 확인되지 않았습니다.",{exact:false}).waitFor({timeout});
  assert.equal(riskNonGet,0,"Hourly local file generated a network write");
  await labelScreenshot(page);
  await page.screenshot({path:screenshotDir+"/funding-hourly-SYNTHETIC-MOCK.png",fullPage:true});
  riskBundle.candles[4].perp.high=210;
  await riskFile.setInputFiles({
    name:"SYNTHETIC-hourly-breach.json",mimeType:"application/json",
    buffer:Buffer.from(JSON.stringify(riskBundle))
  });
  await page.getByText("가정된 유지증거금 버퍼가",{exact:false}).waitFor({timeout});
  await page.getByText("검증 불가",{exact:true}).first().waitFor({timeout});
  assert.equal(riskNonGet,0,"Hourly breach file generated a network write");
  page.removeListener("request",riskListener);
  await page.evaluate(()=>document.getElementById("funding-browser-fixture-watermark")?.remove());
  // Private KRW reserve UI: synthetic local-only data, NEVER personal assets.
  // Confirm HOLD when bank cash falls short despite large exchange holdings.
  await page.setViewportSize({width:390,height:844});
  const reservePanel=page.getByRole("region",{name:"생활비 안전자금과 크립토 투자 한도"});
  const reserveInput=page.getByLabel("포트폴리오 로컬 파일");
  await reserveInput.scrollIntoViewIfNeeded({timeout});
  const sampleReserve={
    snapshotDate:"2026-10-17T05:00:00Z",
    krwBankCash:1_000_000,krwBankDepositsAvailableWithin2Days:0,
    essentialMonthlyKrw:2_000_000,reserveMonths:12,
    nearTermObligationsKrw:1_000_000,fundingAllocationCapPct:10,
    holdings:[
      {asset:"XRP",venue:"Fixture A",category:"crypto",valueKrw:10_000_000,availableInDays:1,encumbered:false},
      {asset:"USDT",venue:"Fixture B",category:"stablecoin",valueKrw:5_000_000,availableInDays:1,encumbered:false},
      {asset:"ETH",venue:"Fixture C",category:"defi",valueKrw:7_000_000,availableInDays:7,encumbered:true}
    ]
  };
  let reserveWriteRequests=0;
  const watchReserve=req=>{if(req.method()!=="GET")reserveWriteRequests++;};
  page.on("request",watchReserve);
  await reserveInput.setInputFiles({
    name:"SYNTHETIC-UNFUNDED-KRW.json",mimeType:"application/json",
    buffer:Buffer.from(JSON.stringify(sampleReserve))
  });
  await reservePanel.getByText("사용자 제공 미검증 자료 · PAPER ONLY").waitFor({timeout});
  await reservePanel.getByText("원화 생활비 안전자금이 부족합니다.",{exact:false}).waitFor({timeout});
  await reservePanel.getByText("₩24,000,000",{exact:true}).waitFor({timeout});
  assert.equal(reserveWriteRequests,0,"Private reserve file attempted network write");
  await labelScreenshot(page);
  await reserveInput.scrollIntoViewIfNeeded({timeout});
  await page.screenshot({
    path:screenshotDir+"/funding-reserve-HOLD-SYNTHETIC-MOCK.png",fullPage:true
  });
  await reserveInput.setInputFiles({
    name:"SYNTHETIC-FUNDED-KRW.json",mimeType:"application/json",
    buffer:Buffer.from(JSON.stringify({...sampleReserve,krwBankCash:26_000_000}))
  });
  await reservePanel.getByText("입력한 안전자금 목표는 충족됐습니다.",{exact:false}).waitFor({timeout});
  await reservePanel.getByText("₩1,500,000",{exact:true}).waitFor({timeout});
  assert.equal(await reservePanel.getByText("원화 생활비 안전자금이 부족합니다.",{exact:false}).count(),0);
  assert.equal(reserveWriteRequests,0,"Covered reserve file attempted network write");
  await reserveInput.scrollIntoViewIfNeeded({timeout});
  await page.screenshot({
    path:screenshotDir+"/funding-reserve-COVERED-SYNTHETIC-MOCK.png",fullPage:true
  });
  await reserveInput.setInputFiles({
    name:"SYNTHETIC-REJECTED-CREDENTIAL.json",mimeType:"application/json",
    buffer:Buffer.from(JSON.stringify({...sampleReserve,apiKey:"fixture-not-a-real-key"}))
  });
  await reservePanel.getByText("파일 검증 실패:",{exact:false}).waitFor({timeout});
  assert.equal(await reservePanel.getByText("사용자 제공 미검증 자료 · PAPER ONLY").count(),0,
    "Private input failure displayed stale allocation");
  assert.equal(reserveWriteRequests,0,"Invalid reserve file attempted network write");
  page.removeListener("request",watchReserve);
  await page.evaluate(()=>document.getElementById("funding-browser-fixture-watermark")?.remove());
  console.log("FUNDING_UI_SMOKE_OK "+JSON.stringify({
    browser:"headless Chrome",screenshots:11,fixtures:mockedRequests,
    reserve_hold_synthetic:true,reserve_covered_synthetic:true,
    reserve_sensitive_field_rejected:true,reserve_upload_requests:reserveWriteRequests,
    hourly_synthetic_file:true,hourly_breach_suppressed:true,hourly_upload_requests:riskNonGet,
    local_file_synthetic_fixture:true,local_file_invalid_rejected:true,local_upload_requests:localUploadRequests,
    mock_ui_cases:caseResults,responsive_checks:responsiveChecks,
    verified_live_exchange_hours:live.hourly_settlements,
    live_coin:live.coin,live_days:live.days,execution_mode:live.execution_mode,
    live_hedged_net_usd:live.hedged_net_usd
  }));
}catch(e){
  console.error("FUNDING_UI_SMOKE_FAILED "+String(e));
  try{await page.screenshot({path:screenshotDir+"/funding-failure.png",fullPage:true});}catch{}
  process.exitCode=1;
}finally{
  await browser.close();
}
