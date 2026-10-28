# PortfolioAI: TradingView + Jev 연구 워크플로 PRD

작성일: 2026-09-21. 상태: 구현 전 초안. 소유자: Youngkwon.

## 목적과 첫 완료 지점

기존 portfolio-dashboard에 TradingView 공식 MCP 데이터와 Jev 판단을 연결한다. 첫 완료 지점은 사용자가 선택한 종목 하나에 대해 시장 스냅샷을 수집하고 Jev 판단을 저장한 뒤 화면에서 입력과 결과를 확인하는 것이다. 초기 모드는 shadow: 기존 paper 매매에는 영향을 주지 않는다. 연결 가능성과 투자 성능은 별도로 검증한다.

## 기존 자산과 개발 위치

- 저장소: https://github.com/Youngkwon-Lee/portfolio-dashboard
- 로컬: /Users/youngkwon/projects/portfolio-dashboard
- 확인한 기준: 7649ad1, codex/preserve-dashboard-safety-20260913; 문서 작성 전 clean.
- Next.js 화면, FastAPI 백엔드, SQLite, 기존 backtest_engine.py, trading_bot.py, trading_safety.py를 활용한다.
- pnpm과 uv 사용. 기존 paper-only 경계, 손실 한도, kill switch, 중복 체결 방지를 보존한다.
- 구현 전에 브랜치·dirty 상태·다른 작업 소유권을 다시 확인한다. 보존 브랜치에서 바로 구현하지 말고 전용 브랜치/지속 가능한 worktree를 사용한다. 미커밋 PRD를 worktree에 명시적으로 전달한다.

## 선택한 구성

TradingView 공식 MCP → MarketDataProvider → 시점 스냅샷 → 기존 전략 신호 → JevDecisionProvider → 판단 기록 → 조회 화면.

MCP 클라이언트는 백엔드가 소유한다. Codex의 MCP 로그인과 앱의 OAuth 세션은 별개이며 자동 공유를 가정하지 않는다. Jev는 MCP를 호출하지 않고 정규화된 state와 typed questions를 입력받는다.

TradingView/JeV 서버 클론은 필요 없다. MCP 및 Jev 공식 SDK를 검토해 필요한 패키지만 버전을 고정한다. QuantDinger는 연동 참고 자료이며 전체 도입하지 않는다. PyPortfolioOpt/Qlib/다른 백테스트 엔진은 이번 범위에서 제외한다.

## 사용자 흐름

1. 연결 상태 화면에서 TradingView 인증과 Jev 설정 유무를 확인한다. 비밀 값은 표시하지 않는다.
2. 종목을 검색해 거래소 포함 식별자를 선택하고 일봉 기준 분석을 수동 실행한다.
3. 가격·거래량과 필요한 기술 지표를 수집하고 수집 시각/데이터 시각/완성 봉 여부를 검증한다.
4. 같은 스냅샷에서 기존 전략 신호와 Jev의 판단을 생성한다.
5. 화면에서 시각·출처, 신호, 각 질문의 선택값·분포·confidence, 보류 이유, 모델 버전·지연을 확인한다.
6. 이전 실행을 다시 열어 당시 입력과 응답을 확인한다. 재조회된 현재 데이터로 덮어쓰지 않는다.

## MVP 기능과 계약

### 데이터

MarketDataProvider에 종목 검색과 스냅샷 수집 계약을 정의하고 TradingView 및 fixture 구현을 둔다. 한 종목·일봉·수동 요청부터 시작한다. OAuth discovery/등록 가능 여부, 갱신, 계정 요금제, 실제 tool schema를 먼저 확인한다. 비공식 endpoint나 브라우저 세션 추출로 대체하지 않는다.

스냅샷은 symbol, exchange, currency, interval, source, observed_at, fetched_at, bar_closed, 지연 정보(미확인 가능), OHLCV, 지표, 품질 상태를 포함한다. 거래소 달력과 시장 휴장을 고려한 신선도 정책을 정의한다. 누락 값은 0으로 대체하지 않는다. 초기에는 뉴스/재무정보를 필수 입력으로 삼지 않고 후속 확장한다. 허용된 데이터 보관·외부 모델 전달 범위를 연결 단계에서 확인한다.

### 판단

DecisionProvider는 state와 버전 지정 questions를 받고 구조화된 결과를 반환한다. Jev 질문은 근거 충분성, 신호 일치, 시장 상황 적합성을 각각 평가한다. 금액·노출 한도 등 정확한 수치 규칙은 코드가 계산한다. confidence는 모델 분포의 확신도이며 거래 성공 확률로 표시하지 않는다.

결과는 evaluated/deferred/error 상태와 각 답변을 기록한다. 타임아웃·인증 실패·스키마 오류·데이터 부족은 보류로 처리한다. 다른 LLM으로 조용히 전환하지 않는다. shadow에서는 기존 paper 동작을 바꾸지 않는다. 추후 filter 모드에서는 보류 시 신규 진입을 막되 손절/청산에는 영향을 주지 않는다.

### 기록

기존 운영 DB를 실험 중 변경하지 않는다. 새 연구 저장소 또는 검토된 additive migration을 선택한다. snapshot_id, run_id, signal/strategy version, question version, 요청/응답 모델 버전, policy version, input hash, 답변, 지연, usage, 오류 분류를 저장한다. 비용은 확인된 가격이 있을 때만 계산하고 미확인은 null로 둔다. 비밀·OAuth 토큰은 기록하지 않는다. 동일 요청 키 재전송은 중복 판단 기록/불필요한 API 비용을 방지한다.

### 화면

종목 선택, 분석 실행, 연결 상태, 최근 실행 목록, 입력·판단 상세로 제한한다. fixture 결과는 데모로 명시하고 live처럼 표시하지 않는다. Jev가 제공하지 않은 서술 근거는 만들어내지 않고 구조화된 체크 결과와 연결된 입력을 제시한다. UI 작업 전 사용자 ui-design 지침과 프로젝트 Next.js 문서를 읽는다.

## 단계별 완료 조건

M0 — 연결 검증: 실제 공식 tool 목록과 한 종목 데이터 응답, Jev의 작은 유효 요청을 확인한다. 자격 증명/요금제 문제가 있으면 정확한 사용자 작업을 기록하고 fixture 작업은 계속 가능하다. 토큰을 채팅에 요청하지 않는다. 유료 플랜 가입이나 무제한 호출은 포함하지 않는다.

M1 — 오프라인 흐름: fixture → 정규화 → 전략 → mock Jev → 저장 → API 조회가 재현된다. 미래 시점/미완성 봉/누락 값, 잘못된 모델 응답, 재전송, 타임아웃 테스트가 통과한다.

M2 — 첫 수직 기능: 실제 한 종목 수동 실행을 화면에서 확인한다. 새로고침 후 같은 기록을 읽을 수 있다. 연결이 없으면 실연결 미검증임을 명시한다. 기존 paper 안전 회귀 테스트를 통과한다. 여기까지를 첫 구현 작업의 범위로 한다.

M3 — 별도 후속 범위: 동일 후보 신호를 기준으로 baseline/JeV-filter 가상 포트폴리오를 비교한다. 동일 초기 자본·비용·체결 모델·가격원을 사용하고 응답 지연 이후에만 체결 가능하게 한다. 순수익, 최대 낙폭, 회전율, 보류율, 제외된 손실·놓친 이익, API 지연·비용을 보고한다. 결과를 보고 임계값을 조정한 데이터와 최종 평가 데이터를 분리한다. 표본 부족은 우수 판정하지 않는다.

## 제외 범위와 실패 정책

실주문, 브로커 인증, 자동매매 권한 확대, SaaS/결제, 대규모 프레임워크 교체, 상시 스케줄, 배포는 포함하지 않는다. 인증/쿼터 오류는 관련 수정이나 새 근거 없이 반복하지 않는다. 사용자 인증이 필요한 경우 연결 준비와 오프라인 검증까지 완료하고 정확한 재개 단계만 남긴다. 향후 스케줄 도입은 automation registry의 최신 main 및 중복 소유권을 확인한 후 별도 범위로 진행한다.

## 근거와 아직 확인하지 않은 사항

2026-09-21 공식 문서 확인 기준이며 실제 인증 호출은 아직 수행하지 않았다.

- https://www.tradingview.com/mcp/docs — 공식 MCP, OAuth 2.1, Essential 이상(체험 제외), 도구와 제한. 앱 자체 OAuth 클라이언트 동작은 별도 검증 필요.
- https://www.tradingview.com/blog/en/tradingview-mcp-server-public-beta-60864/ — 공개 베타 발표.
- https://docs.typesafe.ai/introduction/quickstart — state/questions, POST /v1/systemone, SDK.
- https://docs.typesafe.ai/confidence — confidence 의미와 도메인별 평가 필요성.
- https://github.com/typesafe-ai/typesafe-sdk-python — Python SDK.
- https://github.com/OpenByteInc/QuantDinger/blob/main/backend_api_python/app/services/ai_decision_filter.py — 참고 구현. provider 실패 시 주문을 허용하는 정책은 채택하지 않는다.

미확인: 사용자 요금제/인증, TradingView 데이터 지연·사용권, Jev 실제 가격·지연·버전 고정 지원, 한국 종목 가용성, 투자 성과. 문서만으로 이 항목들을 검증 완료 처리하지 않는다.
