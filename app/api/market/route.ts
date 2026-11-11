import { requireAccess, ACCESS_CACHE_HEADERS } from "../../../lib/access";
import { createMarketHandler, createMarketService } from "../../../lib/server/publicMarket";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const handle = createMarketHandler(requireAccess, createMarketService(), ACCESS_CACHE_HEADERS);
// Authorization is repeated here before parsing, cache lookup or any provider call.
export const GET = handle;
// Explicitly deny HEAD (Next otherwise automatically delegates it to GET).
export const HEAD = handle;
