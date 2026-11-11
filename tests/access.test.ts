import assert from "node:assert/strict";
import { before, test } from "node:test";
import {
  SignJWT, createLocalJWKSet, createRemoteJWKSet, customFetch,
  exportJWK, generateKeyPair, type JWTPayload, type JWTVerifyGetKey,
} from "jose";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { ACCESS_TRUST, ACCESS_JWKS_URL, createAccessGuard } from "../lib/access";
import { config, proxy } from "../proxy";
import nextConfig from "../next.config";

const now = 1_800_000_000;
const date = new Date(now * 1_000);
let pair: Awaited<ReturnType<typeof generateKeyPair>>;
let other: Awaited<ReturnType<typeof generateKeyPair>>;
let keys: JWTVerifyGetKey;
const base: JWTPayload = {
  iss: ACCESS_TRUST.issuer, aud: [ACCESS_TRUST.audience],
  sub: "test-user", email: ACCESS_TRUST.email, type: "app",
  iat: now - 60, nbf: now - 60, exp: now + 300,
};
before(async () => {
  pair = await generateKeyPair("RS256");
  other = await generateKeyPair("RS256");
  keys = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: "local", alg: "RS256" }] });
});
async function token(changes: JWTPayload = {}, omit: string[] = []) {
  const claims = { ...base, ...changes };
  for (const key of omit) delete claims[key];
  return new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "local" }).sign(pair.privateKey);
}
async function check(value: string | undefined, resolver = keys, extra: Record<string, string> = {}) {
  const headers = new Headers(extra);
  if (value !== undefined) headers.set("Cf-Access-Jwt-Assertion", value);
  return createAccessGuard(resolver)(headers, date);
}
async function denied(response: Response | null) {
  assert.ok(response);
  assert.equal(response.status, 403);
  assert.equal(await response.text(), "Forbidden");
  assert.match(response.headers.get("cache-control")!, /no-store/);
  assert.equal(response.headers.get("cdn-cache-control"), "no-store");
  assert.equal(response.headers.get("vercel-cdn-cache-control"), "no-store");
  assert.equal(response.headers.get("location"), null);
  assert.equal(response.headers.get("set-cookie"), null);
}

test("accepts correctly signed identity application token with fixed clock", async () => {
  assert.equal(await check(await token()), null);
  assert.equal(await check(await token({ aud: ACCESS_TRUST.audience })), null);
});
test("missing header, cookie-only and spoofed identity headers fail closed", async () => {
  await denied(await check(undefined));
  await denied(await check(undefined, keys, {
    cookie: `CF_Authorization=${await token()}`,
    "Cf-Access-Authenticated-User-Email": ACCESS_TRUST.email,
    "X-Forwarded-User": ACCESS_TRUST.email,
    "X-Middleware-Subrequest": "proxy:proxy:proxy:proxy:proxy",
  }));
});
for (const value of ["", "garbage", "a.b.c", "a.b", "a.b.c.d", "a.b.c,a.b.c", "x".repeat(16_385)]) {
  test(`rejects malformed assertion (${value.length} bytes)`, async () => {
    await denied(await check(value));
  });
}
const badClaims: [string, JWTPayload][] = [
  ["wrong issuer", { iss: "https://attacker.example" }],
  ["wrong audience", { aud: "wrong" }],
  ["wrong email", { email: "attacker@example.com" }],
  ["email case differs", { email: "KWON3856@gmail.com" }],
  ["email is not a string", { email: [ACCESS_TRUST.email] }],
  ["org token", { type: "org" }],
  ["meta token", { type: "meta" }],
  ["empty subject service token", { sub: "" }],
  ["blank subject", { sub: " " }],
  ["service common_name even with forged user claims", { common_name: "service.access" }],
  ["service id", { service_token_id: "service" }],
  ["service status", { service_token_status: true }],
  ["expired", { exp: now - 1 }],
  ["expiration equals now", { exp: now }],
  ["not yet valid", { nbf: now + 1 }],
  ["future issued", { iat: now + 1 }],
  ["issued after expiration", { iat: now - 1, exp: now - 2 }],
  ["fractional expiration", { exp: now + 0.5 }],
  ["invalid not-before", { nbf: "yesterday" as unknown as number }],
  ["invalid issued-at", { iat: "yesterday" as unknown as number }],
];
for (const [label, changes] of badClaims) {
  test(`rejects ${label}`, async () => { await denied(await check(await token(changes))); });
}
for (const claim of ["exp", "iat", "aud", "iss", "sub", "email", "type"]) {
  test(`rejects missing required ${claim}`, async () => { await denied(await check(await token({}, [claim]))); });
}
test("valid optional nbf absent is accepted", async () => {
  assert.equal(await check(await token({}, ["nbf"])), null);
});
test("rejects different private key signature", async () => {
  await denied(await check(await new SignJWT(base).setProtectedHeader({ alg: "RS256", kid: "local" }).sign(other.privateKey)));
});
test("rejects untrusted key id and never consults token-provided jwks URL", async () => {
  const jwt = await new SignJWT(base).setProtectedHeader({ alg: "RS256", kid: "attacker", jku: "https://attacker.invalid/keys" }).sign(other.privateKey);
  await denied(await check(jwt));
});
test("rejects HS256 algorithm confusion and unsigned token", async () => {
  const jwt = await new SignJWT(base).setProtectedHeader({ alg: "HS256" }).sign(new Uint8Array(32));
  await denied(await check(jwt));
  await denied(await check(`${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(base)).toString('base64url')}.`));
});
test("JWKS outage fails closed without network or error disclosure", async () => {
  let calls = 0;
  const remote = createRemoteJWKSet(new URL(ACCESS_JWKS_URL), {
    [customFetch]: async (url, options) => {
      calls++;
      assert.equal(url, ACCESS_JWKS_URL);
      assert.equal(options.redirect, "manual");
      throw new Error("private upstream diagnostic");
    },
  });
  await denied(await check(await token(), remote));
  assert.equal(calls, 1);
});
test("remote resolver reuses cached public JWKS", async () => {
  let calls = 0;
  const remote = createRemoteJWKSet(new URL(ACCESS_JWKS_URL), {
    [customFetch]: async () => {
      calls++;
      return Response.json({ keys: [{ ...await exportJWK(pair.publicKey), kid: "local", alg: "RS256" }] });
    },
  });
  assert.equal(await check(await token(), remote), null);
  assert.equal(await check(await token(), remote), null);
  assert.equal(calls, 1);
});
const paths = ["/", "/dashboard", "/api", "/api/anything", "/favicon.ico", "/robots.txt", "/file.svg", "/_next/static/chunks/app.js", "/_next/image?url=%2Ffile.svg&w=64&q=75", "/_next/data/build/index.json", "/dashboard?_rsc=abc", "/missing/path/"];
for (const path of paths) {
  test(`matcher protects ${path}, including prefetch/RSC and all hosts`, async () => {
    for (const host of ["quant-lab.kinelo.co.kr", "production-alias.vercel.app", "localhost:3000"]) {
      const url = `https://${host}${path}`;
      assert.equal(unstable_doesMiddlewareMatch({ config, nextConfig, url, headers: { rsc: "1", purpose: "prefetch", "next-router-prefetch": "1" } }), true);
      for (const method of ["GET", "HEAD", "POST", "OPTIONS"]) {
        await denied(await proxy(new NextRequest(url, { method, headers: { "Cf-Access-Authenticated-User-Email": ACCESS_TRUST.email } })));
      }
    }
  });
}
