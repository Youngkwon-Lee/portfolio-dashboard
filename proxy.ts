import { NextRequest, NextResponse } from "next/server";

function configuredApiOrigin(): string | null {
  const configuredApiUrl = process.env.NEXT_PUBLIC_API_URL?.trim();
  if (!configuredApiUrl) {
    return process.env.NODE_ENV === "development" ? "http://localhost:8000" : null;
  }

  try {
    const apiUrl = new URL(configuredApiUrl);
    if (apiUrl.protocol !== "http:" && apiUrl.protocol !== "https:") return null;
    return apiUrl.origin;
  } catch {
    return null;
  }
}

function buildCsp(nonce: string): string {
  const apiOrigin = configuredApiOrigin();
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    `style-src 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: https:",
    `connect-src 'self'${apiOrigin ? ` ${apiOrigin}` : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const contentSecurityPolicy = buildCsp(nonce);
  const requestHeaders = new Headers(request.headers);

  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", contentSecurityPolicy);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });
  response.headers.set("Content-Security-Policy", contentSecurityPolicy);
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
