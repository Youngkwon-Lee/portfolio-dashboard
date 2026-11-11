# Quant Lab origin authentication

## Boundary

`proxy.ts` protects **every Next.js path**, regardless of hostname or method,
including the canonical `quant-lab.kinelo.co.kr`, direct Vercel aliases, API paths,
RSC/prefetch, public files, image optimization and `_next/static` assets. There
are no matcher exclusions and no development, localhost, preview or production
bypasses. The existing application UI and FastAPI backend are unchanged.

Only `Cf-Access-Jwt-Assertion` is accepted. Cookies (including
`CF_Authorization`), identity headers, Host/forwarded headers and service-token
credentials do not authorize requests. A valid JWT is a bearer credential: a
stolen valid assertion can be replayed against the origin until expiry. This is
cryptographic identity protection, not proof that a request traversed Cloudflare.

`lib/access.ts` pins these **public**, server-side trust anchors:

- Issuer: `https://winter-star-c024.cloudflareaccess.com`
- Audience: `6b05d3d4707ab50953f0041529315c73235cc50507742d0e5318b1e949f43b66`
- Allowed email: `kwon3856@gmail.com` (exact match)
- JWKS: `https://winter-star-c024.cloudflareaccess.com/cdn-cgi/access/certs`

There are no authentication environment variables or configurable bypasses.
Absent/malformed request-derived configuration cannot replace these anchors.
Changing trust requires reviewed source changes and a new deployment. Never
substitute token `iss`, `jku`, `jwk`, request Host or a user-controlled JWKS URL.

`jose` verifies RS256 signatures, issuer, audience, required expiration,
issued-at, nonempty subject, email and `type: app`. Expiration is mandatory,
`nbf` is enforced when present, future `iat` and non-integer/inconsistent times
are rejected with zero clock tolerance. The exact user email, nonempty subject,
and exclusion of service claims are important: Cloudflare service tokens also
have `type: app`. Global-session (`org`) and other token types are rejected.

The remote JWK resolver is reused per instance with a ten-minute key cache,
thirty-second unknown-key cooldown and five-second retrieval timeout. Redirects
are not followed. Missing/stale keys and unavailable JWKS deny access; an
already-cached, unexpired key may still verify during an upstream outage. There
is no stale-cache override or decode-only fallback. Rotation may briefly deny
requests during cooldown; serverless instances each maintain their own cache.

All denials are generic non-cacheable 403 responses, with no redirects, claims,
tokens or upstream exception logging. Successful pass-through responses also
request private/no-store caching, including CDN-specific directives. Deployment
CDN rules must not override the authentication boundary or serve previously
public cached content ahead of proxy. Clear old public caches during rollout.

## Verification and operational limits

Run on Node 22.12+ (CI uses Node 22):

```sh
pnpm install --frozen-lockfile
pnpm test:access
pnpm typecheck
pnpm build
```

Tests use ephemeral local RSA keys and a fixed clock, plus injected mocked JWKS
fetches, never Cloudflare login, live keys, credentials or network. The runner
uses the existing TypeScript compiler and Node test runner, not native esbuild.
Next 16.2.7 bundles proxy documentation naming `unstable_doesProxyMatch`, but
actually exports `unstable_doesMiddlewareMatch`; tests use the installed export.
The existing release guard adds these tests without removing any prior gates.

These tests do **not** prove a real Cloudflare login, deployed route coverage,
provider cache behavior, actual JWT claim shape or token renewal. Before release,
the owner must verify a real allowed-user session and rejection of anonymous,
forged-header, malformed-token and cookie-only requests on both the canonical
hostname and each production Vercel alias, including assets/RSC/API. A direct
alias without a header must deny even when a copied authorization cookie exists.
Check GET/HEAD/POST/OPTIONS and attempted internal middleware-subrequest headers.
No parent-owned commit, push, PR, deployment or browser checks were performed here.

Prior deployments built from main `696ffd9` have no origin JWT gate. This code
cannot protect old immutable deployment URLs, other Vercel projects or any
separately exposed FastAPI service. Retire/protect old deployments separately
using provider controls. No brokerage or trading behavior is changed.

All paths intentionally require a fresh valid header. Cloudflare must inject it
for assets and browser navigation as well as HTML. Initial login/challenge and
renewal are Cloudflare responsibilities, not app redirects; XHR/RSC after session
expiry can fail rather than renew transparently. Verify full-page reauthentication
and challenge/renewal flows, ensure any future service worker cannot reuse old
public responses, and avoid adding auth-path exceptions without review. Future
Server Actions or separately deployed APIs need their own authorization checks.

### Local verification on 2026-11-11

- 54 deterministic Access tests passed; TypeScript check passed.
- Production build was attempted but blocked by host native-module restrictions:
  macOS refused the SWC native library, Next fell back to WASM, then Tailwind's
  Lightning CSS native binding was unavailable. No Gatekeeper/quarantine bypass
  was attempted. A successful full build remains a release requirement in CI or
  a normal trusted build environment.

## Sources

- Installed Next 16.2.7 `dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`
  (Node runtime, all-path matching, execution order and RSC behavior).
- https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
- https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/

Parent verification: a fresh Python 3.11 run executed 23 existing backend tests
successfully, but `test_api_safety` could not import macOS's policy-blocked native
`pydantic_core` library. The full backend suite is not claimed as passed locally;
the unchanged required CI job must run it in Linux. No platform protection was
removed or bypassed.
