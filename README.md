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

## Cloudflare Access origin gate

프런트엔드의 모든 경로는 유효한 Cloudflare Access JWT 헤더가 필요합니다.
직접 Vercel 주소와 로컬 개발도 예외가 없으며 쿠키만으로는 접근할 수 없습니다.
고정된 신뢰 설정, 검증 명령(`pnpm test:access`), 배포·로그인 검증 한계는
[origin authentication 문서](docs/cloudflare-access.md)를 참고하세요.

## 대시보드 데이터 표시 계약

포트폴리오·지수·차트는 로딩, 백엔드 응답, 확인 불가를 구분합니다. 백엔드 응답은 공급자 검증이나 실시간 시세 보장이 아닙니다. 요청 실패 시 이전 값을 숨기고, 차트를 임의의 샘플 캔들로 대체하지 않습니다. 고정 봇·체결 예시와 기본 AI 리스크 점수는 DEMO / 샘플로 표시합니다. 계좌 조회 차단 정책은 그대로 유지됩니다.

`pnpm test:provenance`는 네트워크 없이 표시 상태·종목/기간 격리·응답 검증 계약을 검사합니다. 실제 공급자 데이터나 배포 동작을 검증하는 명령은 아닙니다.

## Authenticated read-only public market data

`GET /api/market` supports `kind=quote&ticker=AAPL`, `kind=chart&ticker=005930&period=1M`, `kind=quotes&tickers=AAPL,005930`, and `kind=indices`. The existing Cloudflare Access proxy remains mandatory; the route repeats the JWT guard before parsing or reading its cache. Responses use private/no-store headers even though underlying prices are public. No keys, service tokens, policy changes, account access, orders, automatic trading, or additional paid service are used.

Sources are fixed server-side HTTPS Yahoo Finance daily chart and Upbit public KRW endpoints. No client cookies/authorization are forwarded. Redirects fail closed; requests time out at 8 seconds with a shared 18-second operation deadline, streamed JSON is capped at 1 MiB, concurrency is capped at three upstream calls, quote batches at ten unique symbols, and successful results use a 15-second/128-entry LRU cache. Failed refreshes never fall back to stored prices. Provider errors are generic. These are best-effort public data sources, not exchange-grade feeds or a real-time guarantee; delays, throttling, outages, and missing instruments are expected.

Only raw `005930` and `000660` explicitly map to `.KS`. Other Korean symbols require an explicit six-digit `.KS` or `.KQ` suffix; US symbols use a bounded uppercase format. The existing known crypto set uses Upbit KRW; unsupported listings fail visibly. Crypto USD requests are rejected. The legacy default `currency=krw` does not convert US stocks: Yahoo's native USD (or Korean KRW) is validated and displayed. No FX conversion is performed.

Each quote/chart shows source, provider symbol, native currency, provider `as_of` (last-trade timestamp for Upbit quotes), exchange timezone, and separate `fetched_at` receipt time. Yahoo daily dates use the exchange calendar; Upbit daily dates use its UTC candle field. Quotes compare against the previous daily close from a dedicated one-day request, not the start of a long chart window. Charts contain validated provider bars only, sorted and deduplicated, without synthetic candles. The actual covered dates are displayed; Upbit `1Y` is explicitly limited to at most 200 bars, **not** a full year. Indices are fixed KOSPI, KOSDAQ, S&P 500, NASDAQ, and BTC/KRW, with isolated per-item failures.

Market hooks do not depend on private-backend health. Existing balance/order/AI/backtest paths and paper-only/DEMO labels remain unchanged; private account unavailability is not replaced with mocks. `pnpm test:market` uses deterministic fixtures and mocked fetch, not live-provider or deployed end-to-end evidence. CI also retains Access, provenance, backend regression, typecheck and build checks.

## Phase 1: 수동 가상 포트폴리오 (실계좌 아님)

대시보드 왼쪽 요약과 종목 목록만 공유하는 수동 입력 기능입니다. 초기 상태는 빈 종목/0 현금이며 샘플이나 계좌 잔고를 가져오지 않습니다. 기존 실계좌 잔고, AI 분석, 주문, 자동매매 및 DEMO 경계는 변경하지 않습니다. 수동 데이터로 AI 유료 분석을 활성화하지 않습니다.

- **이 브라우저에만 저장 · 기기 간 동기화 안 됨.** 현재 origin의 `quant-lab:manual-paper-portfolio:v1` 키 하나에 암호화되지 않은 localStorage JSON을 저장합니다. 로그인 계정과 동기화하지 않으며 브라우저 데이터 삭제 시 사라집니다. 가상 장부용 수량·평균가·현금은 직접 입력할 수 있습니다. 공유 기기 사용에 주의하고 계좌번호·비밀번호·API 키는 입력하지 마세요. 같은 origin의 스크립트/브라우저 접근자는 평문을 읽을 수 있습니다.
- 최대 10종목, JSON 최대 16 KiB. 종목 ID 및 정규화된 종목 코드는 중복 불가입니다. `005930`, `000660`은 `.KS`로 정규화합니다. 6자리 `.KS`/`.KQ`, 제한된 대문자 미국 심볼, 기존 공개 시세 경로가 지원하는 KRW 가상자산만 허용합니다. 종목이 통화를 결정하며 USD 가상자산/환산은 없습니다.
- 수량·평균 매입단가·현금은 최대 소수 8자리의 정규 십진 문자열입니다. 수량은 0 초과 10억 이하, 단가는 0 초과 1조 이하, 통화별 현금은 0 이상 1조 이하입니다. 지수 표기, 음수, 비유한 값, 알 수 없는 필드/버전, 잘못된 통화는 거부합니다. 통화가 바뀌는 종목 편집은 평균 단가를 비워 재입력을 요구합니다.
- 현금은 사용자가 입력한 **잔여 현금**입니다. 종목 추가/편집/삭제가 현금을 자동 차감하거나 증가시키지 않습니다. 통화별 총 자산 = 완전한 보유 평가액 + 해당 통화의 잔여 현금. KRW와 USD는 합치지 않으며 환율을 적용하지 않습니다.
- BigInt 고정소수: 입력/시세는 10^8, 수량×단가와 수량×시세는 10^16 단위입니다. 반올림하지 않은 개별 곱을 먼저 합산하고 표시할 때만 KRW 0자리/USD 2자리로 **절댓값 절반 이상은 0에서 멀어지는 방향(round-half-away-from-zero)** 으로 반올림합니다. 음의 0은 표시하지 않습니다. 공급자 Number는 유한 양수/최대값을 검사한 뒤 최단 십진 표현(지수 표현 포함)을 정수 연산으로 소수 8자리 반올림합니다. 8자리 변환 후 0이 되는 시세는 거부합니다.
- 보유평가손익 = 평가액 − 원가, 보유수익률 = 보유평가손익/원가이며 현금은 수익률 분모에 없습니다. 현금만 있으면 총 자산은 유효하며 수익률은 해당 없음입니다. **미실현 평가손익**일 뿐 수수료·세금·배당·분할·실현손익을 자동 반영하지 않습니다.
- 시세/계산 결과는 저장하지 않습니다. 기존 same-origin `GET /api/market`에 `kind=quote`, 종목과 원래 통화만 전송합니다. 수량·평균가·현금·문서는 전송하지 않습니다. 최대 동시 2개, 한 회 전체 최대 19초, 완료 후 약 30초 간격이며 중첩 폴링하지 않습니다. 보유 종목 변경/언마운트 시 취소하고 이전 응답을 무시합니다. 출처·종목·통화·제공자 심볼·기준시각·수신시각을 검사하며 수신시각을 시장 기준시각으로 가장하지 않습니다. 휴장 중 과거 거래 기준시각 자체는 거부하지 않습니다.
- 시세를 다시 읽거나 실패하면 이전 시세를 유지하지 않습니다. 한 통화 그룹에 누락/조회 중/잘못된 시세가 하나라도 있으면 그 그룹의 평가액·손익·수익률·총 자산은 확인 불가입니다. 원가·현금 및 조회에 성공한 개별 종목은 구분해서 표시합니다. 부분 합계를 완전한 총액으로 표시하거나 파이 차트를 만들지 않습니다.
- 빈 키는 마운트 시 쓰지 않습니다. 저장 전 원본 문자열 비교와 저장 후 읽기 검증을 수행합니다. 다른 탭의 `storage` 이벤트를 동기화하며 변경 이전 편집은 저장을 거부합니다. localStorage는 **프로세스 간 원자적 compare-and-swap이 아니므로** 정확히 동시인 다중 탭 쓰기를 완벽히 방지할 수 없습니다. 한 탭에서 편집하세요.
- 저장 차단/할당량 초과는 성공으로 표시하지 않습니다. 손상되거나 지원하지 않는 버전의 원본은 덮어쓰지 않으며 편집을 차단합니다. 명시적인 확인 후 이 기능의 키 하나만 초기화할 수 있습니다. 다른 저장 키나 금융 기록을 읽지 않으며 `localStorage.clear()`를 사용하지 않습니다.

검증: `pnpm test:manual`은 네트워크/자격증명/추가 네이티브 패키지 없이 순수 TS를 컴파일하여 정밀 계산, 스키마/저장 실패/충돌, 시세 출처/취소/기한/부분 실패와 private AI 분리 wiring을 검사합니다. CI는 기존 access/provenance/market 150개, manual 테스트, 타입 검사, Next 빌드 및 기존 backend 검증을 유지합니다. 로컬 코드/테스트 통과는 배포나 실제 계좌 연동을 의미하지 않습니다.
