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
