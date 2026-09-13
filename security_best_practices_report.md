# Portfolio Dashboard 보안·Paper 안전 감사 보고서

감사일: 2026-08-09

범위: `/Users/youngkwon/projects/portfolio-dashboard`
운영 경계: PAPER ONLY

## Executive summary

Paper 주문 경계, live fail-closed, 중복 주문 차단, 원장 장애 대사, 손실 한도, kill switch는 회귀 테스트와 paper soak에서 통과했다. production CSP·API 인증·요청 제한·보안 헤더도 코드와 원격 paper 서비스에서 검증했다. `quant-lab.kinelo.co.kr`은 Cloudflare DNS와 Vercel에서 연결·검증했고, `api-quant-lab.kinelo.co.kr`은 기존 Cloudflare Tunnel과 Zero Trust Access(Cloudflare 계정 멤버 허용)에 연결했다. 다중 worker edge rate limit과 알림 credential 회전은 별도 운영 작업으로 남아 있다. 원격 서비스의 secret key presence를 값 없이 확인한 결과 `PAPER_OPERATOR_TOKEN`과 Telegram 토큰은 미설정이며, Discord webhook만 설정되어 있다.

검증 결과:

- Python 전체 테스트: 57개 통과 (`uv run --with-requirements requirements.txt python -m unittest discover -s tests -v`, 47.147초)
- paper soak: 4개 통과 — 600회 주문 사이클, 601회 중복 재전송, 6회 재연결, 50회 시장 장애, 100회 kill-switch 반복
- TypeScript typecheck: 통과
- Next production build: 통과
- `pnpm audit --prod`: 알려진 취약점 없음
- 원격 `/health`: `execution_mode=paper`, `live_allowed=false`, `external_market_reads_allowed=false`

## Findings

### SEC-001 — High: 취약한 Next.js 및 transitive production dependencies

Status: **Fixed** — Next.js 16.2.11로 업데이트하고 `postcss 8.5.23`, `sharp 0.35.0` override를 적용했다.

- Location: `/Users/youngkwon/projects/portfolio-dashboard/package.json`
- Evidence: 초기 감사에서 Next.js 16.2.7 및 transitive advisory가 확인됐고, 현재는 `"next": "16.2.11"`과 관련 override가 적용되어 있다.
- Audit evidence: 현재 `pnpm audit --prod`는 알려진 취약점을 보고하지 않는다.
- Impact: 공개 서비스에서 알려진 SSRF, DoS, proxy bypass, 내부 endpoint disclosure 및 파일 정보 노출 취약점의 영향을 받을 수 있다.
- Fix: Next.js를 최소 16.2.11 이상으로 올리고 lockfile을 재생성한 뒤 audit, build, 전체 테스트를 다시 실행한다. `sharp`, `postcss`, `nanoid`의 해결 버전도 lockfile에서 확인한다.
- Mitigation: 현재 서비스가 local/private paper 환경이면 public exposure를 막고, 외부 공개 전에는 업데이트를 release gate로 둔다.
- False positive notes: 실제 exploitability는 사용 중인 Next 기능과 배포 경로에 따라 달라질 수 있지만, production dependency audit 자체는 현재 실패 상태다.

### SEC-002 — High if publicly reachable: paper 제어 API에 인증·인가가 없음

Status: **Fixed** — production에서 `PAPER_OPERATOR_TOKEN` 기반 Bearer 인증을 요구하고, 토큰 미구성도 fail-closed 처리한다. development에서는 로컬 사용성을 위해 인증을 요구하지 않는다.

- Location: `/Users/youngkwon/projects/portfolio-dashboard/backend/main.py:458-531`
- Evidence: 초기 감사에서 해당 endpoint에 인증 dependency가 없었고, 현재 production 경로에는 `PAPER_OPERATOR_TOKEN` Bearer 인증과 토큰 미구성 fail-closed가 적용되어 있다. Uvicorn은 원격 paper 환경에서 `127.0.0.1:8000`에만 바인딩된다.
- Additional evidence: `/Users/youngkwon/projects/portfolio-dashboard/backend/trading_safety.py:216-227`의 대사·kill-switch 해제 문구는 소스에 고정된 문자열이다.
- Impact: 공개 backend에 접근 가능한 제3자가 paper 봇을 시작·중지하고, kill switch를 걸거나 해제할 수 있다. 실자금 주문은 차단되지만 paper 원장·알림·운영 상태의 무결성이 훼손된다.
- Fix: 최소한 private network 또는 reverse proxy 인증을 적용하고, 상태 변경 endpoint에 서버 측 operator authentication/authorization을 추가한다. confirmation string만으로 권한을 대체하지 않는다.
- Mitigation: backend를 localhost/private network에만 노출하고 public frontend에서 직접 접근하지 못하게 한다.
- False positive notes: 완전한 로컬 단독 실행이라면 노출면은 낮다. Vercel/공개 호스팅에서 backend가 접근 가능하면 실제 High finding이다.

### SEC-003 — High conditional: 외부 차트 데이터가 raw `innerHTML`로 삽입됨

Status: **Fixed** — tooltip을 `textContent`/DOM node 생성 방식으로 변경했다.

- Location: `/Users/youngkwon/projects/portfolio-dashboard/components/CandlestickChart.tsx:161-168`
- Evidence: 초기 감사에서 `tooltip.innerHTML` 사용이 확인됐고, 현재는 `textContent`/DOM node 생성 방식으로 변경되어 raw HTML sink가 제거됐다.
- Impact: API/provider 응답 또는 배포된 API base가 조작되어 `param.time`에 HTML이 들어오면 브라우저 XSS가 발생할 수 있다. 숫자 가격 값은 현재 숫자형으로 사용되지만 `param.time`은 문자열 경계다.
- Fix: `textContent`와 DOM node 생성 또는 React 렌더링으로 tooltip을 구성한다. raw HTML이 불가피하면 검증된 sanitizer와 CSP를 함께 적용한다.
- Mitigation: API 응답의 날짜를 ISO date allowlist로 검증하고 CSP의 `script-src`/`frame-ancestors`를 배포 계층에 설정한다.
- False positive notes: 현재 정상 provider가 `YYYY-MM-DD`만 반환하면 즉시 exploit되지 않을 수 있으나, raw HTML sink는 제거하는 것이 안전하다.

### SEC-004 — Medium: production FastAPI/브라우저 hardening이 코드에 보이지 않음

Status: **Fixed with rollout caveat** — production docs 비활성화, Trusted Host, CORS 축소, FastAPI/Next 기본 보안 헤더와 request nonce 기반 enforced CSP를 추가했다. 원격 paper 서비스에도 `APP_ENV=production`과 docs/Host/CORS/operator 인증 hardening을 반영했고, 실제 응답에서 docs/OpenAPI `404`, 잘못된 Host `400`, 무인증 bot 제어 `503`을 확인했다. `script-src`와 `style-src`는 nonce 기반이며 React의 style 속성만 `style-src-attr 'unsafe-inline'`으로 제한된다. `NEXT_PUBLIC_API_URL`의 검증된 origin만 `connect-src`에 허용하고, production 설정 누락 시 외부 origin과 사용자 localhost 연결을 모두 허용하지 않는다. Vercel CLI에서 `quant-lab.kinelo.co.kr`의 DNS configuration과 domain ownership 검증은 통과했고, `api-quant-lab.kinelo.co.kr`은 HTTPS에서 Cloudflare Access `302`, CORS preflight `200`, 기존 Tunnel의 paper backend health 응답으로 확인했다. API 호스트는 Cloudflare 기본 인증서 범위에 맞춰 한 단계 subdomain으로 구성했다.

- Location: `/Users/youngkwon/projects/portfolio-dashboard/backend/main.py:45-63`, `next.config.ts:3-7`
- Evidence: 초기 감사에서 docs URL 제한, `TrustedHostMiddleware`, security headers, broad CORS가 확인됐고, 현재는 production 조건부 docs 비활성화, 허용 host/origin 제한, security headers, nonce CSP로 보완됐다.
- Impact: `/docs`, `/redoc`, `/openapi.json`이 공개될 수 있고 Host header 검증·clickjacking·MIME sniffing·CSP 방어가 배포 계층에 의존한다. 현재 인증 쿠키를 사용하지 않는데 credentialed broad CORS가 불필요하게 넓다.
- Fix: production 설정에서 docs를 비활성화하거나 보호하고, 허용 Host/origin/method/header를 명시적으로 제한한다. Next/edge에 CSP, `X-Content-Type-Options`, frame-ancestors 등 baseline headers를 추가한다.
- Mitigation: 원격 FastAPI fallback 제한은 배포됐고, 다중 worker/인스턴스 환경의 공유 rate limit은 reverse proxy/WAF에서 추가로 강제해야 한다.
- False positive notes: 외부 reverse proxy가 이미 적용 중일 수 있으므로 배포 설정과 실제 응답 headers를 함께 확인해야 한다.

### SEC-005 — Medium: 외부 provider fan-out 및 요청량 제한이 없음

Status: **Fixed with bounded defense** — prices/news/Upbit fan-out에 query 길이와 20개 항목 상한을 추가하고, FastAPI에 프로세스별 client rate limit(분당 120회), 1MiB body limit, 동시 요청 100개 fallback을 적용했다. 홈 데스크톱 paper service에서 120회 200 응답 후 121회째 429와 oversized body 413을 실제 확인했다. 다중 worker/인스턴스 공유 edge 적용은 여전히 `deploy/nginx/portfolio-api.conf.example` 배포 단계에 남아 있다.

- Location: `/Users/youngkwon/projects/portfolio-dashboard/backend/main.py:157-176`, `:325-348`
- Evidence: `tickers.split(",")`와 `markets.split(",")` 결과를 상한 없이 순회하며 외부 provider를 호출한다. route-level rate limit 또는 request-size limit이 보이지 않는다.
- Impact: 공격자가 매우 긴 ticker/market 목록으로 provider 호출을 증폭해 CPU, 연결 수, 외부 API quota를 소진시킬 수 있다.
- Fix: 입력 항목 수·문자열 길이·전체 request body를 제한하고, IP/operator 단위 rate limit과 provider timeout/circuit breaker를 둔다.
- Mitigation: reverse proxy에서 body size, request rate, concurrent connections를 제한한다.
- False positive notes: private/local deployment이면 위험도가 낮아진다. public API로 운영할 경우 검증이 필요하다.

### SEC-006 — Medium if publicly reachable: AI endpoint의 quota abuse 방어가 없음

Status: **Fixed with bounded defense** — production operator Bearer 인증과 client별 분당 20회 상한을 추가했다. 다중 worker/다중 인스턴스 환경에서는 edge rate limit도 함께 적용해야 한다.

- Location: `/Users/youngkwon/projects/portfolio-dashboard/backend/main.py:853-908`
- Evidence: `_check_api_key()`는 서버에 `OPENAI_API_KEY`가 있는지만 확인하며, 분석·채팅 endpoint에 사용자 인증이나 rate limit이 없다.
- Impact: 공개 endpoint가 서버의 OpenAI quota를 임의 사용자에게 소비시키거나 장시간 streaming 연결로 자원을 점유하게 할 수 있다.
- Fix: operator/user authentication, per-user rate limit, payload/token budget, streaming timeout을 추가한다. paper dashboard에서 필요하지 않으면 AI endpoint를 기본 비활성화한다.
- Mitigation: `OPENAI_API_KEY`를 설정하지 않은 private 환경에서만 사용하고 public reverse proxy에서 별도 보호한다.
- False positive notes: 서버에 AI key를 넣지 않는 환경에서는 quota impact가 없지만, endpoint 자체의 resource abuse 가능성은 남는다.

### SEC-007 — High: 알림 credential이 HTTP client INFO 로그에 노출될 수 있음

Status: **Fixed in code; credential rotation required** — notifier에서 `httpx/httpcore` 요청 URL 로그를 WARNING 이하로 낮췄다.

- Location: `/Users/youngkwon/projects/portfolio-dashboard/backend/notifier.py:28-33`, `:67-82`
- Evidence: Telegram bot token과 Discord webhook URL이 각각 요청 URL로 전달되며, HTTP client INFO 로깅이 활성화된 환경에서는 URL 전체가 로그에 포함될 수 있었다.
- Impact: 로그 접근자가 알림 채널 credential을 재사용해 메시지를 보내거나 webhook을 악용할 수 있다.
- Fix: 요청 URL 로그를 비활성화하고, 이미 노출된 credential은 provider에서 즉시 revoke/rotate한다.
- Mitigation: webhook/token을 로그·에러·audit artifact에 저장하지 않고, 알림 smoke test에서는 credential 환경 변수를 빈 값으로 명시한다.
- False positive notes: 이번 로컬 smoke에서 실제 outbound 알림 요청이 발생했으므로 단순 이론적 finding이 아니다. 값 자체는 이 보고서에 재현하지 않는다.

## 판정

현재 paper 안전 로직은 **기능 검증 PASS**다. SEC-001·002·003·006·007은 코드 수준에서 해결했고 SEC-004·005는 코드 및 원격 서비스/배포 템플릿 hardening을 적용했다. `quant-lab.kinelo.co.kr` 프론트와 `api-quant-lab.kinelo.co.kr` API edge의 DNS/HTTPS/Access/CORS 연결을 확인했다. 원격 operator token은 secret으로 주입하지 않아 보호 endpoint가 fail-closed 상태다. 원격에는 Discord webhook만 설정되어 있으므로, Live 전환 또는 운영 알림 재개 전 Discord에서 기존 webhook을 폐기하고 새 webhook을 발급해 교체해야 한다. Telegram은 현재 원격 서비스에 설정되어 있지 않다.
