# 포트폴리오 대시보드 백엔드

## 빠른 시작

### 1. KIS 모의투자 API 키 발급
https://apiportal.koreainvestment.com 접속 → 회원가입 → 앱 등록 (모의투자 선택)

### 2. 환경 변수 설정
```bash
cp .env.example .env
# .env 파일을 열고 KIS_APP_KEY, KIS_APP_SECRET, KIS_ACCOUNT_NO 입력
```

### 3. 패키지 설치 & 실행
```bash
cd backend
python -m venv venv
source venv/bin/activate      # Windows: venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

### 4. Next.js 실행 (별도 터미널)
```bash
cd ..    # portfolio-dashboard 루트
npm run dev
# → http://localhost:3000
```

## API 엔드포인트

| Method | Path | 설명 |
|--------|------|------|
| GET | /health | 서버 상태 |
| GET | /api/price/{ticker} | 국내 주식 현재가 |
| GET | /api/price/{ticker}/chart?period=1M | 일봉 차트 |
| GET | /api/prices?tickers=005930,000660 | 복수 현재가 |
| GET | /api/balance | 계좌 잔고 |
| POST | /api/order | 주문 실행 |
| GET | /api/indices | KOSPI/KOSDAQ 지수 |

## 모의투자 vs 실투자 전환
`.env`에서 `KIS_ENV=vts` → 모의투자, `KIS_ENV=real` → 실투자
