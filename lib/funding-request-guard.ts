/** Per-warm-process public API budget. NOT shared across Vercel instances;
 * configure WAF for an actual distributed limit before public deployment.
 */
export type FundingAdmission =
  | { allowed: true; release: () => void }
  | { allowed: false; reason: "busy" | "rate_limit"; retryAfterSeconds: number };
export function createFundingRequestGuard({
  maxRequests = 8, windowMs = 60_000, maxConcurrent = 2, clock = () => Date.now()
}: {
  maxRequests?: number; windowMs?: number; maxConcurrent?: number;
  clock?: () => number;
} = {}): { acquire: () => FundingAdmission } {
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 ||
      !Number.isSafeInteger(windowMs) || windowMs < 1 ||
      !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1)
    throw Error("Invalid funding request budget");
  let timestamps: number[] = [];
  let active = 0;
  return { acquire(): FundingAdmission {
    const now = clock();
    if (!Number.isFinite(now)) throw Error("Invalid rate-limit clock");
    timestamps = timestamps.filter(t => t > now - windowMs);
    if (active >= maxConcurrent)
      return {allowed:false,reason:"busy",retryAfterSeconds:1};
    if (timestamps.length >= maxRequests)
      return {allowed:false,reason:"rate_limit",
        retryAfterSeconds:Math.max(1,Math.ceil((timestamps[0]+windowMs-now)/1000))};
    timestamps.push(now);
    active++;
    let released = false;
    return {allowed:true,release:()=>{if(!released){released=true;active--;}}};
  }};
}
/** Different function bundles may not share this instance. */
export const fundingPublicRequestGuard=createFundingRequestGuard();
