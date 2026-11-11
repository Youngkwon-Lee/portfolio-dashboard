import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

// Public trust anchors, deliberately pinned in server code. Never derive these
// from request headers, token claims, Host, cookies, or NEXT_PUBLIC_* variables.
export const ACCESS_TRUST = Object.freeze({
  issuer: "https://winter-star-c024.cloudflareaccess.com",
  audience: "6b05d3d4707ab50953f0041529315c73235cc50507742d0e5318b1e949f43b66",
  email: "kwon3856@gmail.com",
});
export const ACCESS_JWKS_URL = `${ACCESS_TRUST.issuer}/cdn-cgi/access/certs`;

// One resolver per server instance, not one per request. jose caches keys,
// refreshes for rotation, rate-limits unknown kids and never follows redirects.
const remoteKeys = createRemoteJWKSet(new URL(ACCESS_JWKS_URL), {
  timeoutDuration: 5_000,
  cooldownDuration: 30_000,
  cacheMaxAge: 600_000,
});

export const ACCESS_CACHE_HEADERS = Object.freeze({
  "Cache-Control": "private, no-store, max-age=0",
  "CDN-Cache-Control": "no-store",
  "Vercel-CDN-Cache-Control": "no-store",
});

// Dependency injection is only an in-process test seam, never request input.
export function createAccessGuard(keys: JWTVerifyGetKey = remoteKeys) {
  return async (headers: Headers, currentDate = new Date()): Promise<Response | null> => {
    const token = headers.get("Cf-Access-Jwt-Assertion");
    try {
      if (!token || token.length > 16_384 || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) {
        throw new Error("Invalid assertion");
      }
      const { payload } = await jwtVerify(token, keys, {
        algorithms: ["RS256"],
        issuer: ACCESS_TRUST.issuer,
        audience: ACCESS_TRUST.audience,
        requiredClaims: ["exp", "iat", "iss", "aud", "sub", "email", "type"],
        currentDate,
        clockTolerance: 0,
      });
      const now = Math.floor(currentDate.getTime() / 1_000);
      if (
        payload.email !== ACCESS_TRUST.email ||
        payload.type !== "app" ||
        typeof payload.sub !== "string" || !payload.sub.trim() ||
        !Number.isSafeInteger(payload.exp) || !Number.isSafeInteger(payload.iat) ||
        payload.iat! > now || payload.iat! >= payload.exp! ||
        // Service tokens use common_name and an empty sub, not user identity.
        "common_name" in payload || "service_token_id" in payload ||
        "service_token_status" in payload
      ) {
        throw new Error("Invalid identity");
      }
      return null;
    } catch {
      // Includes JWKS failures. No claims, token, upstream error, or identity logs.
      return new Response("Forbidden", {
        status: 403,
        headers: {
          ...ACCESS_CACHE_HEADERS,
          "Content-Type": "text/plain; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
  };
}

export const requireAccess = createAccessGuard();
