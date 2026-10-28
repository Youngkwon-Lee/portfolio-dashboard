# PortfolioAI FastAPI backend

현재 백엔드는 **paper-trading MVP**입니다. 공개 시장 데이터와 백테스트는 제공하지만 KIS, Upbit, Binance의 인증 계좌 조회 및 모든 주문 제출은 차단합니다. 브로커·거래소 API 키를 입력하거나 `.env`에 추가할 필요가 없습니다.

## 실행

저장소 루트에서:

```bash
cd backend
uv run --with-requirements requirements.txt uvicorn main:app --reload --port 8000
```

## 주요 모듈

- `main.py`: FastAPI 라우트와 paper-only API 계약
- `trading_bot.py`: 원장 선기록 후 메모리를 변경하는 가상 체결 봇과 평가자산 기반 리스크 계산
- `trading_safety.py`: 중복 주문, 재연결 대사, 손실 한도, kill switch의 영속 정책
- `database.py`: paper 체결·상태 SQLite 저장소
- `paper_soak_runner.py`: 외부 연결을 차단한 24시간 wall-clock 안전 soak
- `backtest_engine.py`: 과거 데이터 백테스트 엔진
- `research_workflow.py`: paper 원장과 분리된 shadow 스냅샷·전략 신호·JeV-shaped 판단 기록 흐름
- `tests/`: 네트워크·실계좌 호출 없는 안전 회귀 및 가속 soak 테스트

`PORTFOLIO_DB_PATH`와 `TRADING_SAFETY_STATE_PATH`로 테스트 저장 위치를 분리할 수 있습니다. 기본 `portfolio.db`는 사용자 데이터이므로 검증 작업에서 삭제·초기화·되돌리지 마세요.

## 허용·차단 API

| Method | Path | 상태 |
| --- | --- | --- |
| GET | `/health` | paper-only 계약 반환 |
| GET | `/api/trading/safety` | 영속 안전 상태 반환 |
| POST | `/api/backtest` | 과거 데이터 시뮬레이션 |
| POST | `/api/bot/start` | paper만 허용 |
| POST | `/api/bot/stop` | paper 세션 정상 종료 |
| POST | `/api/bot/kill-switch` | 즉시 정지·영속 차단 |
| GET | `/api/balance` | `403` 차단 |
| POST | `/api/order` | `403` 차단 |
| GET | `/api/upbit/balance` | `403` 차단 |
| GET/POST | `/api/wallet/binance` | `403` 차단 |

## Shadow research

연구실 탭은 기본적으로 deterministic fixture와 mock JeV를 사용합니다. 결과는 `RESEARCH_DB_PATH`로 지정할 수 있는 별도 SQLite에 저장되며 `portfolio.db`의 paper 체결 원장과 섞이지 않습니다.

| Method | Path | 상태 |
| --- | --- | --- |
| GET | `/api/research/status` | shadow 모드와 backend 인증 설정 상태만 반환; 비밀 값은 반환하지 않음 |
| GET | `/api/research/instruments` | fixture 또는 Yahoo public 종목 검색 |
| POST | `/api/research/runs` | fixture/mock, Yahoo public/mock, 또는 미구성 live 요청의 보류 기록 |
| GET | `/api/research/runs` | 최근 연구 실행 목록 |
| GET | `/api/research/runs/{run_id}` | 저장 당시 snapshot·signal·decision 상세 |

TradingView MCP와 Jev 자격 증명은 Codex MCP 세션이나 `PAPER_OPERATOR_TOKEN`과 공유하지 않습니다. 백엔드 전용 runtime secret 이름은 `TRADINGVIEW_MCP_ACCESS_TOKEN`(공식 OAuth 2.1로 발급된 access token), 선택적 `TRADINGVIEW_MCP_URL`, `TYPESAFE_API_KEY`(호환 별칭 `JEV_API_KEY`), 선택적 `JEV_API_URL`, `JEV_MODEL`입니다. 토큰이 있어도 실제 tool 응답·bar completeness·Jev schema 검증 전에는 상태가 `configured_unverified`이며, live provider 실패는 외부 fallback 없이 `deferred`로 닫힙니다. fixture 응답은 화면에서 `FIXTURE / DEMO`로 표시됩니다.

M0 read-only 검증은 저장소 루트에서 실행합니다. secret 값은 채팅이나 로그에 붙여넣지 말고 backend runtime에만 주입하세요.

```bash
cd backend
uv run --with-requirements requirements.txt python research_m0_probe.py --query AAPL
```

자격 증명이 없으면 probe는 외부 호출 없이 종료 코드 `2`와 누락된 환경 변수 이름만 출력합니다. 두 provider가 모두 성공하고 snapshot 품질이 통과한 경우에만 Jev 요청을 이어서 보내며, 결과에는 토큰이 포함되지 않습니다.

무료 경로인 `yahoo_public`은 기존 yfinance wrapper를 재사용합니다. 주식과 함께 `BTC-USD`, `ETH-USD`, `SOL-USD`, `BNB-USD`, `XRP-USD`, `ADA-USD`, `DOGE-USD`를 지원합니다. 이는 TradingView MCP와 다른 데이터 출처이며, 화면에 `YAHOO / PUBLIC`으로 표시하고 지연·사용권·bar completeness를 별도로 검증합니다.

## 안전 테스트

저장소 루트에서:

```bash
safety_test_dir="$(mktemp -d /tmp/portfolio-safety-tests.XXXXXX)"
PORTFOLIO_DB_PATH="$safety_test_dir/portfolio-test.db" \
TRADING_SAFETY_STATE_PATH="$safety_test_dir/safety-test.json" \
uv run --with-requirements backend/requirements.txt \
python -m unittest discover -s backend/tests -v
```

가속 soak만 실행:

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

기본 soak는 임시 SQLite와 안전 상태 파일에서 원장 1,200건, 중복 재전송 601회, 비정상 재연결 6회, 시세 장애 50회, kill switch 100회를 검증합니다. 테스트는 실제 인증 API나 주문 엔드포인트를 호출하지 않으며 downstream 클라이언트가 호출되지 않았음을 mock으로 검증합니다.

백테스트의 `promotion_gate`는 워크포워드 양수 폴드 2개 이상, 폴드당 검증 표본 30개 이상, 평균 수익률 양수인 전략만 paper 관찰 후보로 표시합니다. 후보가 없으면 `HOLD`를 권고하며, 이 계약은 실거래를 활성화하지 않습니다.

응답의 `robustness`에는 전략 선택 편향 진단도 포함됩니다. 여러 고정 규칙 전략이 함께 실행될 때 연속 시간 블록을 조합하는 CSCV 방식으로 PBO(Probability of Backtest Overfitting)를 근사하고, 각 전략에는 시도 횟수 보정 Deflated Sharpe 확률을 계산합니다. 현재 전략은 미래 라벨을 학습하지 않는 고정 규칙이므로 label purge/embargo를 적용하지 않았으며, `purge_applied: false`가 명시됩니다. 표본이 짧으면 억지로 숫자를 만들지 않고 `available: false`를 반환합니다. 이 진단은 paper 분석 전용이며 승격이나 실거래를 자동 승인하지 않습니다.

`/api/indices`는 `PAPER_EXTERNAL_MARKET_READS=true`를 명시하지 않으면 빈 결과를 반환하며 KIS·Binance·Yahoo/CoinGecko를 호출하지 않습니다. 프런트엔드의 `NEXT_PUBLIC_ENABLE_EXTERNAL_MARKET_READS` 게이트와 별개로 동작하는 이중 안전장치입니다.

시장·지갑 provider 예외는 502와 일반화된 메시지로 닫히며 내부 예외 문자열이나 인증 정보는 API 응답에 노출하지 않습니다.

`POST /api/optimize`도 기본적으로 외부 시장 데이터 읽기를 차단하고 403을 반환합니다. 명시적 paper 게이트가 열린 경우에만 최적화하며, 결과는 고정 seed로 재현 가능하고 `execution_mode: "paper"`, `live_allowed: false`, `methodology.paper_only: true`를 반환합니다.

24시간 wall-clock soak는 OS 정리 대상인 `/tmp`가 아닌 Application Support 경로에 증거를 남깁니다.

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

이 러너는 저장소 밖의 새 DB만 사용하고 모든 소켓 연결을 차단합니다. `$wall_clock_root/run/evidence.json`의 `status`가 `passed`가 되려면 실제 24시간 경과, 충분한 실행 주기, 영구 원장 중복 차단, 시세 장애·재연결·kill switch 차단, paper-only 원장, 네트워크 시도 0, 소스 및 사용자 `portfolio.db` 지문 불변을 모두 만족해야 합니다. 24시간 미만 실행은 `--allow-short-duration`을 명시한 로컬 스모크에만 허용됩니다.
