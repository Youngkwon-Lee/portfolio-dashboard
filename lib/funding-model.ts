/** Read-only, strict-coverage Hyperliquid perpetual funding research; never place orders. */
export const HOUR_MS = 3_600_000;
export const DAY_MS = HOUR_MS * 24;
export type FundingCoin = "BTC" | "ETH" | "XRP";
export type FundingDays = 30 | 90;
export interface FundingRecord { time: number; fundingRate: string | number }
export interface PerpCandle { t: number; T: number; o: string | number; h: string | number; l: string | number; c: string | number }
export interface FundingInputs {
  coin: FundingCoin; days: FundingDays; notionalUsd: number;
  spotFeeBps: number; perpFeeBps: number; slippageBps: number;
  startMs: number; endMs: number; funding: FundingRecord[]; candles: PerpCandle[];
}
export interface FundingCurvePoint {
  time: string; fundingUsd: number; shortNetUsd: number; hedgedNetUsd: number;
  shortMarginEquityUsd: number;
}
export interface FundingResult {
  execution_mode: "paper"; live_allowed: false;
  source: "Hyperliquid public fundingHistory + 1h perp candleSnapshot";
  coin: FundingCoin; days: FundingDays;
  notional_usd: number; combined_capital_usd: number;
  start_utc: string; end_utc: string; hourly_settlements: number;
  first_funding_utc: string; last_funding_utc: string;
  entry_price_proxy: number; exit_price_proxy: number; price_change_pct: number;
  funding_rate_sum_pct: number; funding_simple_annualized_pct: number;
  gross_funding_usd: number; spot_price_pnl_usd: number; short_price_pnl_usd: number;
  perp_fees_usd: number; spot_fees_usd: number; slippage_usd: number;
  short_net_usd: number; hedged_net_usd: number;
  short_return_pct: number; hedged_return_on_total_capital_pct: number;
  minimum_short_equity_pct: number; short_collateral_breach_in_proxy: boolean;
  short_margin_stress_warning: boolean;
  assumptions: string[]; curve: FundingCurvePoint[];
}
const r = (v: number, places = 4) => Number(v.toFixed(places));
function positive(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw Error("Invalid positive price");
  return n;
}
function bps(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 100) throw Error("Invalid basis points");
  return value / 10000;
}
function rateNumber(value: unknown): number {
  // Number(null), Number("") and Number(false) are zero: do not silently
  // manufacture a zero funding settlement when the source omitted a rate.
  if (typeof value !== "number" && typeof value !== "string") throw Error("Invalid funding rate");
  if (typeof value === "string" &&
      !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())) {
    throw Error("Invalid funding rate");
  }
  const n = Number(value);
  // Hyperliquid's documented hourly funding cap is 4%.
  if (!Number.isFinite(n) || Math.abs(n) > 0.04) throw Error("Invalid funding rate");
  return n;
}
export function calculateFundingSimulation(x: FundingInputs): FundingResult {
  if (!["BTC","ETH","XRP"].includes(x.coin) || ![30,90].includes(x.days)) throw Error("Unsupported market/window");
  if (!Number.isFinite(x.notionalUsd) || x.notionalUsd < 100 || x.notionalUsd > 1000000) throw Error("Invalid notional");
  if (!Number.isSafeInteger(x.startMs) || !Number.isSafeInteger(x.endMs)
    || x.startMs % HOUR_MS || x.endMs % HOUR_MS
    || x.endMs - x.startMs !== x.days * DAY_MS) throw Error("Invalid UTC window");
  const feeSpot = bps(x.spotFeeBps), feePerp = bps(x.perpFeeBps), slip = bps(x.slippageBps);
  const funding = new Map<number, number>();
  for (const f of x.funding) {
    if (!Number.isSafeInteger(f.time) || f.time % HOUR_MS || f.time <= x.startMs
      || f.time > x.endMs || funding.has(f.time)) throw Error("Bad or duplicate funding time");
    funding.set(f.time, rateNumber(f.fundingRate));
  }
  const candles = new Map<number, {o:number;c:number;h:number;l:number}>();
  for (const candle of x.candles) {
    if (!Number.isSafeInteger(candle.t) || candle.t % HOUR_MS || candle.t < x.startMs
      || candle.t >= x.endMs || candles.has(candle.t) || candle.T !== candle.t + HOUR_MS - 1) {
      throw Error("Bad or duplicate candle time");
    }
    const o=positive(candle.o), c=positive(candle.c), h=positive(candle.h), l=positive(candle.l);
    if (h < Math.max(o,c) || l > Math.min(o,c) || h < l) throw Error("Inconsistent candle OHLC");
    candles.set(candle.t,{o,c,h,l});
  }
  const hours = x.days * 24;
  if (funding.size !== hours || candles.size !== hours) throw Error("Incomplete hourly data coverage");
  const entry = candles.get(x.startMs)?.o;
  if (!entry) throw Error("Opening price unavailable");
  const quantity = x.notionalUsd / entry;
  const openPerpCost = x.notionalUsd * (feePerp + slip);
  const openSpotCost = x.notionalUsd * (feeSpot + slip);
  let funded = 0, rateSum = 0;
  let minShort = x.notionalUsd - openPerpCost;
  const curve: FundingCurvePoint[] = [{
    time: new Date(x.startMs).toISOString(), fundingUsd:0,
    shortNetUsd:r(-openPerpCost,2), hedgedNetUsd:r(-openPerpCost-openSpotCost,2),
    shortMarginEquityUsd:r(minShort,2)
  }];
  for (let i=0; i<hours; i++) {
    const candleStart = x.startMs + i*HOUR_MS;
    const c = candles.get(candleStart), rate = funding.get(candleStart + HOUR_MS);
    if (!c || rate === undefined) throw Error("Noncontiguous hourly data");
    const value = quantity*c.c;
    // Stress the intrahour high *before* crediting this hour's funding.
    // Assuming the funding arrived first can overstate a short's margin buffer.
    const collateralHigh = x.notionalUsd + quantity*(entry-c.h) + funded - openPerpCost;
    rateSum += rate;
    // Funding uses the oracle price; perp candle close is only a proxy for it.
    funded += value*rate;
    const pricePnl = quantity*(entry-c.c);
    const closePerp = value*(feePerp+slip), closeSpot=value*(feeSpot+slip);
    const collateralClose = x.notionalUsd + pricePnl + funded - openPerpCost;
    minShort = Math.min(minShort,collateralHigh,collateralClose);
    if ((i+1)%24===0 || i===hours-1) curve.push({
      time:new Date(candleStart+HOUR_MS).toISOString(),
      fundingUsd:r(funded,2),
      shortNetUsd:r(pricePnl+funded-openPerpCost-closePerp,2),
      hedgedNetUsd:r(funded-openPerpCost-openSpotCost-closePerp-closeSpot,2),
      shortMarginEquityUsd:r(collateralClose,2)
    });
  }
  const exit=candles.get(x.endMs-HOUR_MS)?.c;
  if (!exit) throw Error("Exit price unavailable");
  const notionalExit=quantity*exit;
  const feesPerp=(x.notionalUsd+notionalExit)*feePerp;
  const feesSpot=(x.notionalUsd+notionalExit)*feeSpot;
  const slippageOneLeg=(x.notionalUsd+notionalExit)*slip;
  const shortPrice=quantity*(entry-exit);
  const shortNet=shortPrice+funded-feesPerp-slippageOneLeg;
  const hedgedNet=funded-feesPerp-feesSpot-2*slippageOneLeg;
  return {
    execution_mode:"paper", live_allowed:false,
    source:"Hyperliquid public fundingHistory + 1h perp candleSnapshot",
    coin:x.coin, days:x.days, notional_usd:x.notionalUsd, combined_capital_usd:x.notionalUsd*2,
    start_utc:new Date(x.startMs).toISOString(),end_utc:new Date(x.endMs).toISOString(),
    hourly_settlements:hours,first_funding_utc:new Date(x.startMs+HOUR_MS).toISOString(),
    last_funding_utc:new Date(x.endMs).toISOString(),
    entry_price_proxy:r(entry,8),exit_price_proxy:r(exit,8),
    price_change_pct:r((exit/entry-1)*100), funding_rate_sum_pct:r(rateSum*100,6),
    funding_simple_annualized_pct:r(rateSum*(365/x.days)*100),
    gross_funding_usd:r(funded,2),spot_price_pnl_usd:r(-shortPrice,2),
    short_price_pnl_usd:r(shortPrice,2),perp_fees_usd:r(feesPerp,2),
    spot_fees_usd:r(feesSpot,2),slippage_usd:r(slippageOneLeg*2,2),
    short_net_usd:r(shortNet,2),hedged_net_usd:r(hedgedNet,2),
    short_return_pct:r(shortNet/x.notionalUsd*100),
    hedged_return_on_total_capital_pct:r(hedgedNet/(x.notionalUsd*2)*100),
    minimum_short_equity_pct:r(minShort/x.notionalUsd*100,2),
    short_collateral_breach_in_proxy:minShort<=0,
    short_margin_stress_warning:minShort<x.notionalUsd*0.15,
    assumptions:[
      "과거 펀딩비 부호를 그대로 적용: 양수는 숏 수취, 음수는 숏 지급.",
      "시간별 펀딩 정산 명목금액은 고정 코인 수량 × Hyperliquid 선물 시간봉 종가로 근사. 실제 오라클 가격 및 정산액과 다름.",
      "헤지용 현물은 동일한 가격의 가상 자산. 외부 거래소 현물 가격·FXRP/USDC·베이시스·디페그·상환 제한은 미반영.",
      "1배 숏에는 명목금액만큼 별도 USDC 담보, 가상 현물+숏에는 약 두 배의 총자본 필요.",
      "수수료와 슬리피지는 각 포지션 진입·청산 모두 반영. 환전·가스·브리지·세금은 제외.",
      "시간봉 고가 기반 증거금 여유는 실제 거래소 유지증거금·청산 엔진의 계산값이 아님.",
      "실제 포트폴리오 성과나 미래 수익을 보장하지 않는 읽기 전용 연구."
    ],
    curve
  };
}
