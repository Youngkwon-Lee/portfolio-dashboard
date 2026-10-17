# PortfolioAI — paper-trading dashboard

Next.js 16 프런트엔드와 FastAPI 백엔드로 구성된 포트폴리오 분석·백테스트·paper-trading 대시보드입니다. 현재 제품 경계는 **PAPER ONLY**이며 KIS, Upbit, Binance 실계좌 인증과 주문 제출은 서버에서 fail-closed로 차단됩니다.

이 프로젝트는 투자 권유 서비스가 아니며 백테스트나 paper 결과는 미래 수익을 보장하지 않습니다.

## 현재 안전 경계

| 기능 | 상태 | 계약 |
| --- | --- | --- |
| 공개 시세·차트 | 허용 | 인증 없는 시장 데이터 조회 |
| 백테스트 | 허용 | 과거 데이터 시뮬레이션, 실제 주문 없음 |
| 자동매매 | paper만 허용 | 가상 체결 원장에만 반영 |
| KIS/Upbit/Binance 계좌 조회 | 차단 | API가 `403` 반환, 인증 클라이언트 미호출 |
| KIS/Upbit/Binance 주문 | 차단 | 실거래 모드와 주문 클라이언트 모두 hard block |
| API 자격 증명 입력 | 차단 | UI 미노출, 레거시 요청은 값 비노출 상태로 거부 |

Paper 봇에는 다음 방어선이 적용됩니다.

- 주문 idempotency key를 상태 변경 전에 영속화하고, 결정적 체결 ID의 SQLite 고유 제약을 최종 방어선으로 사용해 오래된 재전송도 차단합니다.
- 체결 원장 저장 결과가 불명확하면 메모리를 변경하지 않고 즉시 상태 대사 필요 상태로 전환합니다.
- 비정상 종료 후 이전 세션이 남아 있으면 명시적 상태 대사 전까지 재시작을 차단합니다.
- 총 현금이 아니라 평가자산 기준으로 일일 손실 2%와 최대 낙폭 10%를 검사합니다.
- 일일 손실 한도는 UTC 당일 영속 정지, 최대 낙폭과 수동 kill switch는 명시적 해제 전까지 영속 정지합니다.
- `backend/paper_trading_safety.json`은 `backend/portfolio.db`와 분리된 런타임 상태이며 Git에서 제외됩니다.

## 구조

```text
app/                         Next.js App Router 진입점과 전역 스타일
components/BotPage.tsx       paper 봇 제어·상태 UI
components/BacktestPage.tsx  과거 데이터 시뮬레이션 UI
components/SettingsPage.tsx  공개 지갑 주소만 허용하는 설정 UI
backend/main.py              FastAPI 계약과 차단 엔드포인트
backend/trading_bot.py       paper 실행 엔진
backend/trading_safety.py    영속 fail-closed 안전 정책
backend/paper_soak_runner.py 외부 연결 없는 wall-clock 안전 soak
backend/backtest_engine.py   백테스트 엔진
backend/tests/               안전 정책·API 회귀 및 가속 soak 테스트
```

## 로컬 실행

의존성 관리에는 `pnpm`과 `uv`를 사용합니다. 브로커·거래소 API 키는 입력하지 마세요.

프런트엔드:

```bash
pnpm install
pnpm dev
```

백엔드(별도 터미널):

```bash
cd backend
uv run --with-requirements requirements.txt uvicorn main:app --reload --port 8000
```

기본 주소는 프런트엔드 `http://localhost:3000`, 백엔드 `http://localhost:8000`입니다. `NEXT_PUBLIC_API_URL`을 지정하지 않으면 프런트엔드는 위 백엔드 주소를 사용합니다.

## 안전 API 계약

- `GET /health`: `execution_mode: "paper"`, `live_allowed: false`, `kis_environment: "vts"`
- `GET /api/trading/safety`: 리스크 한도, 차단 사유, 영속 안전 상태
- `POST /api/bot/start`: paper 설정만 수락
- `POST /api/bot/stop`: 정상 paper 세션 종료
- `POST /api/bot/kill-switch`: 즉시 정지 후 kill switch 영속화
- `POST /api/bot/reconcile`: 비정상 재시작 상태 대사(정확한 확인 문구 필요)
- `POST /api/bot/safety-reset`: 정지 상태의 kill switch 해제(정확한 확인 문구 필요)

알림은 Telegram과 Discord webhook을 선택적으로 지원합니다. Discord는 `DISCORD_WEBHOOK_URL`을 런타임 시크릿으로만 주입하면 `#paper-trading-alerts`에 paper 시작·정지·매수·매도·kill switch·일일 리포트를 best-effort 전송합니다. 환경 변수가 없으면 네트워크를 호출하지 않으며, 알림 실패가 paper 주문을 성공으로 바꾸거나 실거래를 활성화하지 않습니다. webhook URL과 Telegram 자격 증명은 저장소·`.env`·로그에 기록하지 않습니다.

`/api/order`, `/api/balance`, `/api/upbit/balance`, `/api/wallet/binance`는 현재 항상 차단됩니다. 실거래 활성화는 환경 변수 하나로 열 수 있는 기능이 아니며 별도의 법무·보안 설계와 승인 없이는 지원하지 않습니다.

## 백테스트 사용 범위

백테스트는 티커·기간(`1M`, `3M`, `6M`, `1Y`)·전략·초기자본을 검증한 뒤 공개 시세를 받아 과거 구간을 시뮬레이션합니다. 허용 전략 식별자는 `ensemble`, `bah`, `dual_mom`, `sma_cross`, `bollinger`, `rsi`이며 초기자본은 0보다 커야 합니다. 응답에는 `execution_mode: "paper"`, `live_allowed: false`가 포함되어 백테스트가 실거래 경로가 아님을 API 계약으로도 고정합니다. 데이터 조회 실패나 표본 부족은 일반화된 오류로 반환되고, 내부 예외·인증 정보는 응답에 노출하지 않습니다.

결과에는 수익률·MDD·승률·거래 수와 함께 데이터 출처(`source`) 및 조회 시각(`fetched_at`)이 표시됩니다. 기본 거래비용은 수수료 10bps와 슬리피지 5bps이며 UI/API에서 조정할 수 있습니다. 모든 결과에는 동일 비용 조건의 Buy & Hold 기준선이 포함되고, 최소 20개 캔들부터 시간순 홀드아웃(`chronological_holdout`) 70/30 검증(학습·검증 수익률, 검증 MDD·Sharpe·표본 수)이 함께 반환됩니다. 검증 표본이 30개 미만이면 API와 UI가 Sharpe 해석 주의 경고를 표시합니다. 180개 이상 캔들에서는 폴드당 최소 30개 검증 표본을 갖는 3개 확장 윈도우 워크포워드 결과(`walk_forward`)도 반환하며, 폴드별 평균 수익률·수익률 변동성·양수 폴드 비율·수익률 범위·일관성 판정을 함께 제공합니다. 짧은 표본에서는 실행하지 않고 이유를 명시합니다. 날짜가 ISO 형식이 아니거나 오름차순·고유성을 만족하지 않거나 timezone 형식이 서로 섞이거나 OHLC 값이 유한한 양수 범위를 벗어나거나 거래량이 음수이면 백테스트를 거부합니다. 이는 미래 성과 보장이 아닙니다. 결과는 지연·미래 데이터 편향을 완전히 재현하지 않으므로 실적 또는 수익률 보장으로 해석하면 안 됩니다. 차트 조회는 짧은 TTL 캐시를 사용하며, 캐시 실패 결과는 저장하지 않습니다.

워크포워드 결과에는 `promotion_gate`도 포함됩니다. 이는 실거래 승인이나 수익 보장이 아니라 paper 관찰 후보를 좁히는 보수적 필터입니다. 양수 폴드 2개 이상, 폴드당 검증 표본 30개 이상, 평균 폴드 수익률 양수를 모두 만족해야 `eligible_strategies`에 포함되며, 후보가 없으면 UI/API가 `HOLD 권고`를 표시합니다. 현재 gate는 백테스트 분석 계약이며 실거래 경로를 열지 않습니다.

## 검증

아래 백엔드 테스트는 임시 DB와 임시 안전 상태 파일만 사용하므로 `backend/portfolio.db`를 건드리지 않습니다.

```bash
safety_test_dir="$(mktemp -d /tmp/portfolio-safety-tests.XXXXXX)"
PORTFOLIO_DB_PATH="$safety_test_dir/portfolio-test.db" \
TRADING_SAFETY_STATE_PATH="$safety_test_dir/safety-test.json" \
uv run --with-requirements backend/requirements.txt \
python -m unittest discover -s backend/tests -v

pnpm typecheck
pnpm build
```

가속 paper soak만 별도로 반복하려면 다음 명령을 사용합니다.

```bash
soak_test_dir="$(mktemp -d /tmp/portfolio-paper-soak.XXXXXX)"
PORTFOLIO_DB_PATH="$soak_test_dir/import-guard.db" \
TRADING_SAFETY_STATE_PATH="$soak_test_dir/import-guard-safety.json" \
PAPER_SOAK_CYCLES=600 \
PAPER_SOAK_FAULT_CYCLES=50 \
PAPER_SOAK_KILL_CYCLES=100 \
uv run --with-requirements backend/requirements.txt \
python -m unittest backend.tests.test_paper_soak -v
```

기본 soak는 600회 왕복 체결(원장 1,200건), 중복 재전송 601회, 비정상 재연결 6회, 시세 장애 50회, kill switch 100회를 임시 저장소에서 검증합니다. 실제 인증 API나 외부 주문 엔드포인트는 호출하지 않습니다.

실제 24시간 동안 프로세스 생존성과 영속 안전장치를 관찰하려면 wall-clock soak를 실행합니다. 기본 실행 시간은 86,400초이며, 더 짧은 실행은 `--allow-short-duration`을 명시한 스모크 검증으로만 허용됩니다. 장시간 실행은 OS가 정리할 수 있는 `/tmp` 대신 고정된 사용자 Application Support 경로를 사용합니다.

```bash
wall_clock_root="$HOME/Library/Application Support/portfolio-dashboard-paper-soak"
mkdir -p "$wall_clock_root/run"
uv run --with-requirements backend/requirements.txt \
python backend/paper_soak_runner.py \
  --runtime-dir "$wall_clock_root/run" \
  --allow-durable-runtime \
  --duration-seconds 86400 \
  --tick-seconds 60
```

러너는 저장소 밖의 새 SQLite만 사용하고 Python 소켓 연결을 모두 차단합니다. 실제 `execute_order` 경로로 매 분 paper 왕복 체결과 중복 재전송을 확인하고, 시세 장애·비정상 재연결·kill switch를 주기적으로 주입합니다. 진행 및 최종 판정은 `$wall_clock_root/run/evidence.json`에 원자적으로 기록되며 `status: "passed"`는 24시간 경과, 원장 ID 유일성, paper-only 원장, 열린 포지션 없음, 네트워크 시도 0, 소스 및 `backend/portfolio.db` 지문 불변을 모두 만족할 때만 기록됩니다.

전체 안전 테스트는 paper 기본값, live fail-closed, 자격 증명 비노출 거부, 영구 원장 중복 차단, 원장 장애 시 fail-closed, 비정상 재연결, 일일 손실 한도, 최대 낙폭, kill switch, 손상된 상태 파일, 인증 엔드포인트의 downstream 미호출을 확인합니다.


## Funding Lab — 30/90-day hourly market-data research (PAPER ONLY)

Navigation: **펀딩비** (XRP / BTC / ETH). This new tab uses the unauthenticated
Hyperliquid public `fundingHistory` and `candleSnapshot` APIs via Next.js
`GET /api/funding`. No trading keys, wallet auth, live orders, or transfers
are created. Existing KIS/Upbit/Binance account/order endpoints remain blocked.

The analysis accepts exchange posting-time jitter within ±60 seconds of the UTC hourly settlement only. Aligned duplicates and missing hourly settlements fail closed without interpolation.\n\nThe analysis uses exactly **720** hourly settlements for 30 days, or **2160**
for 90 days. Missing/duplicated data or upstream failures produce HTTP 503,
not fabricated percentage returns. It compares (a) isolated 1x short with
USD-sized collateral to (b) synthetic same-asset spot long + 1x short with
**double initial committed capital**. Longs pay shorts on *positive* funding;
negative funding is a **cost** for the short. Entry/exit commission and
slippage are modeled separately. The account-margins path uses intrahour
perp highs as an indicative stress proxy, not actual liquidation logic.

**Scope limits:** Hyperliquid funding settlements use **oracle price**; perp candle close is only a proxy for the oracle price, and the hedged spot price is a *synthetic identical-price leg*;
real Binance XRP/USDT, Hyperliquid FXRP spot, basis, FXRP risk, FX/KRW,
gas, transfer, tax, partial fills, liquidity and true maintenance margin
are not included. USD values are simulations, not guaranteed KRW cash
income. Do not treat USDC, FXRP or collateral as KRW safety funds.

### $500 total-capital paper UI (stacked Draft)

The **모의 총자본 (USD)** input defaults to **$500 total**, split evenly into
**$250 synthetic spot** and **$250 collateral for an isolated 1x short**.
The `GET /api/funding` `notional` field is **per-leg**, not total capital;
if omitted, the API defaults to $250 per leg. Thus `notional=10000` in
the example below is an explicit **$20,000 total** benchmark, **not** the
$500 UI default. No real asset allocation or order is performed.

The UI separates **gross historical funding**, **round-trip spot/perp fees
plus both legs' slippage**, and **after-cost synthetic hedge net PnL**.
It plots funding/hedge PnL separately from directional **1x short PnL**
using distinct y-axes: curve heights are not cross-chart comparable.
The initial margin stress percentage is only an intrahour-high proxy,
not a real exchange liquidation or account margin check. Genuine spot/perp
basis, collateral movement, FX, tax and off-model costs remain excluded.

### Example read-only request

```text
GET /api/funding?coin=XRP&days=30&notional=10000&spotFeeBps=10&perpFeeBps=4.5&slippageBps=5
```

All parameters are validated and public requests are bounded. Supported
time windows: 30 or 90 days. Default fee assumptions are editable in UI
and must be verified for the user's exchange/tier before any conclusion.

Run the zero-network deterministic model tests with Node 22+:

```bash
npm run test:funding
```

Official information: [Info endpoint](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals),
[fees](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees).


## Funding Lab: 4-venue historical comparison (Draft / PAPER ONLY)

The Funding Lab tab now offers a separate **4개 거래소** panel for BTC/ETH/XRP,
30 or 90 days: Hyperliquid, Binance, Bybit and OKX. Its read-only route is
\`GET /api/funding/venues?coin=XRP&days=30&notional=10000&spotFeeBps=10&perpFeeBps=5&slippageBps=5\`.
All exchange calls use public historical data endpoints without keys. The
result always has \`execution_mode: "paper"\`, \`live_allowed: false\`.

- Funding uses **observed settlement timestamps and signed rates**, not a
  synthetic fixed 8-hour schedule. Gaps larger than a venue's maximum expected
  1/8-hour interval, duplicates, invalid values, or missing start/tail cause
  **unavailable**, never extrapolated APY.
- Binance: public USDⓈ-M \`/fapi/v1/fundingRate\`, Binance spot/perp \`klines\`.
- Bybit: V5 \`/v5/market/funding/history\`, V5 spot/linear \`kline\`.
- OKX: \`/api/v5/public/funding-rate-history\`, historical spot/swap \`history-candles\`.
- Hyperliquid: \`fundingHistory\`; **funding-only** because FXRP/wrapped spot
  and other spot symbols require separate validation. No synthetic equality
  between spot and perpetual is allowed.
- Observed **entry/exit basis** uses simultaneous hourly *open* candles on
  spot and perpetual. Quantity is equal across legs, based on initial perp
  notional. The total capital denominator is actual initial spot value plus
  full 1x perp margin. Fee/slippage assumptions are adjustable.
- Funding USD uses a **constant initial notional proxy**; the real hourly
  oracle/mark price, basis path, intra-period forced liquidation, market depth,
  borrow/financing, USDC/USDT/FXRP credit, FX, gas and tax are NOT measured.
  The output is therefore an **estimated historical simulation**, not
  realized net cash yield. The stress panel shows hypothetical +30/+50/+100%
  upside shocks, not exchange-specific liquidation prices.
- 90-day history is accepted **only** if the venue returns all required
  settlement coverage. An exchange may restrict lookback or public access;
  this is reported as unavailable, not silently filled from another venue.
- Server response never contains an account, balance, token, API key,
  trade instruction, order endpoint or transfer. No real trading or deployment
  is authorized by this feature.

Offline tests: \`npm run test:funding\`. GitHub Actions also checks type safety,
Next.js build, existing backend paper-only regression, and public-data smoke.
New code is in a **stacked Draft PR** on top of the original Funding Lab PR;
neither should be merged or deployed to production without independent review.


### Offline exchange archive review (no geoblock workaround)

If the Vercel deployment receives Binance HTTP 451 or Bybit HTTP 403,
the API **does not retry through proxies or alternate hostnames** and returns
\`unavailable\`. For research, a user who is independently authorized to
access the official archive can manually prepare an **offline** data bundle
for a local browser-only analysis. The application does not download, upload,
store, authenticate, or redistribute this file.

- Official Binance historical archive: https://data.binance.vision/
  and https://github.com/binance/binance-public-data
- Official Bybit historical data documentation:
  https://bybit-exchange.github.io/docs/v5/market/history-fund-rate
  and https://www.bybit.com/future-activity/developer
- Dataset licensing, user jurisdiction, market access and archive freshness
  must be reviewed before downloading. A user-entered source URL and SHA256
  are **not** independent proof of official provenance.

The browser accepts a maximum 2MB local JSON bundle with **exactly** this
schema (values below are placeholders, not historical prices/rates):

\`\`\`json
{
  "format": "quant-lab-funding-bundle-v1",
  "venue": "Binance",
  "coin": "XRP",
  "days": 30,
  "start": 1790006400000,
  "end": 1792598400000,
  "notionalUsd": 10000,
  "sourceUrl": "https://data.binance.vision/data/futures/um/",
  "downloadedAt": "2026-10-17T00:00:00Z",
  "funding": [{"time": 1790035200000, "rate": 0.0001}],
  "entry": {"time": 1790006400000, "spot": 1, "perp": 1},
  "exit": {"time": 1792598400000, "spot": 1, "perp": 1}
}
\`\`\`

**Important:** the example intentionally contains **incomplete** funding
history and should be **rejected** by the strict-coverage model. A valid file
must include all observed settlements over the requested 30/90-day window.
The start/end values must be exact UTC hour boundaries and exactly 30 or
90 days apart. Spot and perpetual prices must be independently observed
hourly opens at **the same** start and end timestamps. Data is not
automatically assumed to be equivalent across different wrapped assets.

An offline converter is available for already **normalized** CSV files.
It never connects to any network:

\`\`\`bash
node scripts/funding-build-local-bundle.mjs Binance XRP 30 \
  2026-09-17T04:00:00Z 2026-10-17T04:00:00Z \
  funding.csv spot.csv perp.csv \
  https://data.binance.vision/data/futures/um/ \
  ./xrp-local-research.json
\`\`\`

The converter requires strict numeric headers \`time,rate\` for funding and
\`time,open\` for each of spot/perp; time must be **Unix milliseconds**.
Raw exchange archives can have different column names, time units and
layouts. **Normalize them first** and independently verify against the
published official source before use. In particular Binance spot archive
timestamps from 2025 onward may be **microseconds** and must not be
mistaken for milliseconds.

The JSON is analyzed only in browser memory; the output is visibly marked
\`user_supplied_unverified\` and is not combined into the verified live
exchange ranking. It is **not** a validated investment return. No file,
credentials, or personal balances are sent to Quant Lab servers.


### Hourly path and isolated-margin stress (stacked Draft, PAPER ONLY)

The Funding Lab includes an additional **시간별 베이시스 · 1배 숏 증거금 경로**
panel. This research feature is **not** an exchange liquidation engine and does
not place orders, query accounts, transmit selected files or modify balances.

To use it, supply an independently authorized and verified source of
synchronized hourly spot and perpetual OHLC candles and actual funding
settlements for exactly **720 (30d)** or **2160 (90d)** contiguous UTC hours.
The **user-supplied** bundle has these keys:

\`\`\`json
{
  "format": "quant-lab-hourly-path-v1",
  "venue": "OKX",
  "coin": "XRP",
  "days": 30,
  "start": 1789617600000,
  "end": 1792209600000,
  "notionalUsd": 10000,
  "sourceUrl": "https://www.okx.com/",
  "funding": [{"time": 1789646400000, "rate": 0.0001}],
  "candles": [
    {"time":1789617600000,
     "spot":{"open":1,"high":1.01,"low":0.99,"close":1},
     "perp":{"open":1,"high":1.02,"low":0.98,"close":1}}
  ]
}
\`\`\`

**The snippet above is deliberately incomplete and MUST be rejected.** Full
data must include each UTC hour in the requested window, with correct
high/low and open/close. \`funding\` contains **observed** exchange
settlements; the model validates settlement continuity through the existing
venue-specific engine. Historical data from other tokens, wrapped FXRP or
different instruments must not be silently substituted.

A local offline converter can create this JSON from independently normalized
CSV inputs:

\`\`\`bash
node scripts/funding-build-hourly-path.mjs OKX XRP 30 \
  2026-09-17T04:00:00Z spot.csv perp.csv funding.csv \
  https://www.okx.com/ ./hourly-research.json
\`\`\`

Both spot and perp CSV files require exactly
\`time,open,high,low,close\` with **millisecond UTC** timestamps; funding
requires \`time,rate\`. The converter never downloads or uploads data.
It refuses to overwrite an existing output file. A source URL is a user claim,
not authenticated provenance; a SHA256 digest proves file integrity, not origin.

Model behavior:
- Same-quantity spot and isolated 1x short, **separate** spot capital and
  short collateral. The model uses observed spot/perp closes and historical
  signed funding rates to estimate daily basis, funding and net equity.
- The assumed maintenance margin rate is configurable **0–10%** and is
  **not** automatically derived from exchange-specific leverage brackets,
  risk tiers, fee/liquidation rules or cross/portfolio margin.
- For short risk, each hourly **perpetual high** is tested *before* that
  hour's funding is credited. This is a conservative stress proxy; OHLC does
  not reveal intrahour ordering, synchronized spot/perp extremes, true
  liquidation fills or funding mark/oracle prices.
- If any hour crosses the assumed maintenance margin buffer, the model
  marks a **possible breach** and suppresses the entire held-to-end return,
  rather than assuming the position survived. A positive buffer does **not**
  prove a trade would avoid liquidation.
- Real trade P&L, maximum possible loss, intrahour realized drawdown,
  maintenance tier transitions, financing, ADL, transfer latency, order
  book depth, stablecoin/FXRP risk, tax and KRW conversion are **not** verified.
- Browser File API parses the JSON entirely in memory and never sends it to
  the Quant Lab server. Results are labeled \`user_supplied_unverified\`.

Run offline regression with \`npm run test:funding\`. No live trading or
production deployment is authorized by this feature.


### OKX official public historical audit (read-only; non-blocking)

\`scripts/funding-okx-hourly-audit.mjs\` retrieves public **XRP-USDT spot**
and **XRP-USDT-SWAP** confirmed hourly OHLC candles plus **realized funding
settlements** using only documented OKX public GET endpoints:

- \`/api/v5/market/history-candles\` (100 rows/page; \`after\` means older)
- \`/api/v5/public/funding-rate-history\` (100 rows/page; \`after\` means older)

The bounded script checks **2160 consecutive closed hours**, validates funding
continuity, and produces **separate 30/90-day summaries** using the same UTC
end boundary. It runs in the existing non-blocking CI market-data job, without
creating a new runner. Maximum 70 public requests, 12s timeout per request,
100ms pacing, no credentials, wallet, trades, writes, or private data.

\`\`\`bash
OKX_AUDIT_COIN=XRP node --experimental-strip-types scripts/funding-okx-hourly-audit.mjs
\`\`\`

The printed \`OKX_HOURLY_AUDIT_RESULT\` includes a SHA256 hash of its JSON
summary, number of calls, source, time window, margin-buffer breach proxy,
and null net return if any assumed buffer breach occurs. **The summary
does not prove that hourly OHLC extremes were executable, the funding
mark/oracle was the candle close, the position could be maintained, or that
actual exchange liquidation tiers were modeled.** It is a retrospective
research stress proxy. The output is never merged into account balances,
automatic trading, or cash-flow projections.

Deterministic mocked API pagination tests are part of
\`npm run test:funding\`. If the OKX public endpoint is unavailable,
rate-limited or returns incomplete history, the live audit fails closed and
no 30/90-day result is asserted. It does not use proxy/geoblock bypass.


### OKX public mark-price and current position-tier scenario (Draft, paper only)

An optional \`OKX_MARK_AUDIT=1\` step in the existing non-blocking
market-data CI job reads three additional official **public GET** sources:
\`/api/v5/market/history-mark-price-candles\`,
\`/api/v5/public/position-tiers?instType=SWAP&tdMode=isolated&instFamily=XRP-USDT\`,
and \`/api/v5/public/instruments?instType=SWAP&instId=XRP-USDT-SWAP\`.
It does not call any \`/account\`, order, transfer, or private endpoint.
The public mark history is required to have **all 2,160 consecutive confirmed
hourly candles**; no missing mark is replaced with the trade price.

\`lib/funding-okx-mark-risk.ts\` uses the *current* public isolated position
tier snapshot (contract multiplier and contract value included) and a
**user-assumed liquidation taker fee reserve of 5bps**, and computes an
isolated 1x short margin-buffer stress from hourly **mark-price highs**,
before crediting each hour's funding. A breach is only a **possible buffer
breach**, not a confirmed exchange liquidation.

**Important:** a current tier is NOT proof of the maintenance tiers
applicable during the prior 30/90 days. OKX's actual fee tier, additional
liquidation clearance fees, intra-hour mark/funding ordering, tier changes,
partial reduction/ADL, wallet/cross-margin balances, and true liquidation
execution are not available. Consequently results are labeled
\`current_tier_retrospective_scenario_not_historical_tier\` and the output
always sets \`historical_liquidation_confirmed:false\` and
\`actual_liquidation_fee_verified:false\`.

If mark history, contract metadata or public tiers cannot be read and
validated, \`mark_overlay.status\` is \`unavailable\`, with a coarse
non-sensitive error code. The original 30/90d public funding and trade-OHLC
audit remains available and **no fallback mark prices or tiers are invented**.

Sources: https://app.okx.com/docs-v5/en/ (mark-price history, public instruments,
position tiers); https://www.okx.com/en-us/help/liquidation-faq and
https://www.okx.com/en-us/help/v-tiered-maintenance-margin-ratio-rules .


### Personal portfolio reserve analysis (private, paper only)

Funding Lab includes a **생활비 안전자금 · 크립토 투자 한도** panel.
There is **no connected personal balance**: \`lib/mockData.ts\` and
\`hooks/usePortfolio.ts\` contain synthetic stock/crypto holdings and
a synthetic ₩5,000,000 cash fallback; these values must NEVER be used
as real user assets or spending.

The new client-side-only module \`lib/funding-portfolio-reserve.ts\` accepts
a user-prepared JSON snapshot with **no account numbers, wallet addresses,
API keys or identifying data**. Example **illustrative only** (not actual holdings):

\`\`\`json
{
  "snapshotDate": "2026-10-17T05:00:00Z",
  "krwBankCash": 0,
  "krwBankDepositsAvailableWithin2Days": 0,
  "essentialMonthlyKrw": 2000000,
  "reserveMonths": 12,
  "nearTermObligationsKrw": 0,
  "fundingAllocationCapPct": 0,
  "holdings": [
    {"asset":"XRP","venue":"Example Exchange","category":"crypto",
     "valueKrw":0,"availableInDays":1,"encumbered":false}
  ]
}
\`\`\`

The example is **not a statement** of the user's spending, cash, holdings,
or investment allocation. Fill it from current bank and exchange statements
without including private identifiers.

- \`essentialMonthlyKrw\`: total **essential** monthly expenses, not the
  user's desired monthly income. \`reserveMonths\`: 3–24, user-selected.
  \`nearTermObligationsKrw\`: nonmonthly payments due during the reserve horizon.
- Only KRW bank cash and bank deposits accessible within 2 days count
  toward the safety reserve. Stablecoins and exchange balances are
  **not** counted as KRW bank cash, even if quickly tradeable.
- Unencumbered crypto/stablecoins available within 2 days form a separate
  **at-risk investment pool**. Locked, staked, DeFi-collateralized and
  withdrawal-delayed positions are excluded from the funding strategy budget.
- If the KRW safety reserve is below target, the proposed new funding
  allocation is **0**, irrespective of how much crypto is held. If covered,
  the user-chosen allocation cap (0–20%) limits *research-only* strategy
  capital. A 1x spot/short model splits that capital into separate spot
  and short collateral legs; this is not a live trading instruction.
- The client reads local files with \`File.text()\` and computes in memory;
  no server API, upload, persistence, order, or wallet access is used.
- Funding yield is never booked as guaranteed or predictable monthly
  living income. KRW prices, bank deposits, exchange availability and
  balances are entirely user-supplied and **unverified**.
