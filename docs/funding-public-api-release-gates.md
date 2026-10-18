# Funding Lab public-API release gates

This is read-only public historical data research, not realized or assured income.
The new app-layer request guard is scoped to one warm Node.js process:
at most 8 valid calls/60 seconds and 2 concurrent calculations; excess calls
return 429 with Retry-After. This is NOT an IP, regional, or distributed rate
limit; cold starts and multiple functions have independent counters.

Before a public-production release, enable and verify a Vercel WAF rate-limit
rule for both /api/funding and /api/funding/venues, then monitor API request
volumes and server costs. The four-venue route is introduced by stacked Draft PR #2 and now has
a tighter 3 valid requests/60 seconds, 1 concurrent calculation per instance. No active WAF rule was confirmed.

The isolated localhost Next integration test intercepts only unauthenticated
Hyperliquid public-info reads, providing 720 synthetic hourly records and an
hour-12 perp candle high of 210 against a price of 100. HTTP 422 must omit all
held-to-expiry returns. Repeating eight valid requests must lead to HTTP 429;
31-day invalid input remains HTTP 400. The four-venue mock explicitly returns
unavailable upstream sources, allows three queries, then returns HTTP 429.
These fixture switches exist only in a
CI Node preloader, not in the production API.

Actual oracle-priced funding, real spot basis, fees, liquidity and exchange
liquidation details remain outside the original model; Draft PRs are not
approved for production merely because these tests pass. No trades or credentials.
