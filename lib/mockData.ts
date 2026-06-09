export const portfolioSummary = {
  totalValue: 52_847_300,
  totalCost: 43_200_000,
  totalReturn: 9_647_300,
  totalReturnPct: 22.33,
  dailyPnl: -842_400,
  dailyPnlPct: -1.57,
};

export const holdings = [
  { ticker: "005930", name: "삼성전자", market: "KRX", qty: 200, avgCost: 68500, currentPrice: 74800, value: 14_960_000, returnPct: 9.20 },
  { ticker: "000660", name: "SK하이닉스", market: "KRX", qty: 50, avgCost: 178000, currentPrice: 195000, value: 9_750_000, returnPct: 9.55 },
  { ticker: "AAPL", name: "Apple", market: "NASDAQ", qty: 30, avgCost: 165.4, currentPrice: 213.7, value: 8_774_700, returnPct: 29.20 },
  { ticker: "NVDA", name: "NVIDIA", market: "NASDAQ", qty: 20, avgCost: 498.0, currentPrice: 875.3, value: 9_528_690, returnPct: 75.76 },
  { ticker: "QQQ", name: "Invesco QQQ", market: "ETF", qty: 25, avgCost: 420.0, currentPrice: 470.5, value: 6_445_375, returnPct: 12.02 },
  { ticker: "BTC", name: "Bitcoin", market: "CRYPTO", qty: 0.15, avgCost: 55_000_000, currentPrice: 93_500_000, value: 14_025_000, returnPct: 70.0 },
];

export const allocationData = [
  { name: "한국 주식", value: 24_710_000, color: "#58a6ff" },
  { name: "미국 주식", value: 18_303_390, color: "#3fb950" },
  { name: "ETF", value: 6_445_375, color: "#e3b341" },
  { name: "암호화폐", value: 14_025_000, color: "#bc8cff" },
];

// 60일치 삼성전자 mock candle data
export const samsungPriceData = (() => {
  const data = [];
  let price = 70000;
  const start = new Date("2024-03-01");
  for (let i = 0; i < 60; i++) {
    const date = new Date(start);
    date.setDate(start.getDate() + i);
    if (date.getDay() === 0 || date.getDay() === 6) continue;
    const change = (Math.random() - 0.48) * 2000;
    const open = price;
    const close = Math.round(price + change);
    const high = Math.round(Math.max(open, close) + Math.random() * 800);
    const low = Math.round(Math.min(open, close) - Math.random() * 800);
    data.push({ date: date.toISOString().slice(0, 10), open, high, low, close, volume: Math.round(8_000_000 + Math.random() * 5_000_000) });
    price = close;
  }
  return data;
})();

export const tradingBots = [
  { id: 1, name: "MA 크로스오버", ticker: "005930", status: "running", strategy: "골든크로스 20/60", pnl: +342_000, pnlPct: 2.34, trades: 8, winRate: 62.5, lastTrade: "매수 @74,800" },
  { id: 2, name: "RSI 역추세", ticker: "NVDA", status: "running", strategy: "RSI<30 매수, RSI>70 매도", pnl: +1_245_000, pnlPct: 15.2, trades: 12, winRate: 75.0, lastTrade: "보유 중" },
  { id: 3, name: "BTC 모멘텀", ticker: "BTC", status: "paused", strategy: "24h 모멘텀 + 볼린저밴드", pnl: -120_000, pnlPct: -0.85, trades: 5, winRate: 40.0, lastTrade: "매도 @91,200,000" },
];

export const recentOrders = [
  { time: "09:32", ticker: "005930", side: "buy", qty: 10, price: 74800, status: "체결" },
  { time: "10:15", ticker: "NVDA", side: "sell", qty: 2, price: 875.3, status: "체결" },
  { time: "11:02", ticker: "BTC", side: "sell", qty: 0.01, price: 91_200_000, status: "체결" },
  { time: "13:45", ticker: "AAPL", side: "buy", qty: 5, price: 213.7, status: "대기" },
];

export const aiInsights = {
  riskScore: 42,
  riskLevel: "보통",
  summary: "기술주 비중이 높아 변동성 리스크가 존재합니다. NVDA 비중 축소 또는 채권/배당 ETF 추가를 고려하세요.",
  strategies: [
    { name: "최고 수익", tag: "High", color: "#e3b341", desc: "NVDA 비중 확대, 모멘텀 극대화", alloc: [{ ticker: "NVDA", pct: 40 }, { ticker: "AAPL", pct: 35 }, { ticker: "BTC", pct: 25 }] },
    { name: "최저 리스크", tag: "Low", color: "#3fb950", desc: "채권 ETF + 배당주 중심 방어 포트폴리오", alloc: [{ ticker: "QQQ", pct: 50 }, { ticker: "005930", pct: 30 }, { ticker: "AAPL", pct: 20 }] },
    { name: "균형형", tag: "Mid", color: "#58a6ff", desc: "3자산 균등 배분으로 리스크/수익 균형", alloc: [{ ticker: "005930", pct: 33 }, { ticker: "NVDA", pct: 34 }, { ticker: "BTC", pct: 33 }] },
  ],
};

export const marketIndices = [
  { name: "KOSPI", value: 2683.45, change: -1.24 },
  { name: "KOSDAQ", value: 876.32, change: -0.87 },
  { name: "S&P 500", value: 5384.70, change: -0.52 },
  { name: "NASDAQ", value: 17203.12, change: -0.78 },
  { name: "BTC/KRW", value: 93_500_000, change: +2.14 },
];
