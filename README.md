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

`/api/order`, `/api/balance`, `/api/upbit/balance`, `/api/wallet/binance`는 현재 항상 차단됩니다. 실거래 활성화는 환경 변수 하나로 열 수 있는 기능이 아니며 별도의 법무·보안 설계와 승인 없이는 지원하지 않습니다.

## 백테스트 사용 범위

백테스트는 티커·기간(`1M`, `3M`, `6M`, `1Y`)·전략·초기자본을 검증한 뒤 공개 시세를 받아 과거 구간을 시뮬레이션합니다. 허용 전략 식별자는 `ensemble`, `bah`, `dual_mom`, `sma_cross`, `bollinger`, `rsi`이며 초기자본은 0보다 커야 합니다. 응답에는 `execution_mode: "paper"`, `live_allowed: false`가 포함되어 백테스트가 실거래 경로가 아님을 API 계약으로도 고정합니다. 데이터 조회 실패나 표본 부족은 일반화된 오류로 반환되고, 내부 예외·인증 정보는 응답에 노출하지 않습니다.

결과에는 수익률·MDD·승률·거래 수와 함께 데이터 출처(`source`) 및 조회 시각(`fetched_at`)이 표시됩니다. 기본 거래비용은 수수료 10bps와 슬리피지 5bps이며 UI/API에서 조정할 수 있습니다. 모든 결과에는 동일 비용 조건의 Buy & Hold 기준선이 포함되고, 최소 20개 캔들부터 시간순 홀드아웃(`chronological_holdout`) 70/30 검증(학습·검증 수익률, 검증 MDD·Sharpe·표본 수)이 함께 반환됩니다. 검증 표본이 30개 미만이면 API와 UI가 Sharpe 해석 주의 경고를 표시합니다. 60개 이상 캔들에서는 3개 확장 윈도우 워크포워드 결과(`walk_forward`)도 반환하며, 짧은 표본에서는 실행하지 않고 이유를 명시합니다. 날짜가 ISO 형식이 아니거나 오름차순·고유성을 만족하지 않거나 timezone 형식이 서로 섞이거나 OHLC 값이 유한한 양수 범위를 벗어나거나 거래량이 음수이면 백테스트를 거부합니다. 이는 미래 성과 보장이 아닙니다. 결과는 지연·미래 데이터 편향을 완전히 재현하지 않으므로 실적 또는 수익률 보장으로 해석하면 안 됩니다. 차트 조회는 짧은 TTL 캐시를 사용하며, 캐시 실패 결과는 저장하지 않습니다.

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
