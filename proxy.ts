import { NextResponse, type NextRequest } from "next/server";
import { ACCESS_CACHE_HEADERS, requireAccess } from "./lib/access";

export async function proxy(request: NextRequest) {
  const denial = await requireAccess(request.headers);
  if (denial) return denial;
  return NextResponse.next({ headers: ACCESS_CACHE_HEADERS });
}

// No host, method, prefetch, RSC, public-file, API or _next exemptions.
export const config = { matcher: "/:path*" };
