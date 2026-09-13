/**
 * UI 런타임 정책.
 *
 * 기본값은 false라서 paper 대시보드가 마운트될 때 외부 시세·인증 API를
 * 자동 조회하지 않는다. 사용자가 별도 환경에서 명시적으로 true를
 * 주입할 때만 실시간 읽기 경로를 연다. 주문·계좌 API와는 무관하다.
 */
export const EXTERNAL_MARKET_READS_ENABLED =
  process.env.NEXT_PUBLIC_ENABLE_EXTERNAL_MARKET_READS === "true";
