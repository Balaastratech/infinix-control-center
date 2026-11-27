// Public-demo hardening: login rate limit, CSRF origin check, security headers, cookie flags.
import { NextRequest } from "next/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import nextConfig from "../next.config";
import { POST as loginRoute } from "@/app/api/auth/login/route";
import { proxy } from "@/proxy";
import { ensureDevice } from "@/server/auth/device";
import { resetLoginLimits } from "@/server/auth/login-limit";
import { createSessionCookie } from "@/server/auth/session";
import { auditLog } from "@/server/db/schema";
import type { Db } from "@/server/db";
import { PASSWORD, setupTestDb } from "./helpers/db";

let db: Db;
beforeAll(() => {
  db = setupTestDb();
});
beforeEach(() => resetLoginLimits());
afterEach(() => vi.unstubAllEnvs());

const login = (email: string, password: string, ip = "203.0.113.7") =>
  loginRoute(new Request("http://localhost/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip }, body: JSON.stringify({ email, password }) }));

describe("login rate limit", () => {
  it("5 failures for one email from one IP -> 429 with Retry-After, even with the right password; failures are audited", async () => {
    for (let i = 0; i < 5; i++) expect((await login("operator@nova.test", "wrong")).status).toBe(401);
    const blocked = await login("operator@nova.test", PASSWORD);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    const rows = db.select().from(auditLog).all().filter((a) => a.action === "auth.login");
    expect(rows.filter((a) => a.outcome === "failed")).toHaveLength(5);
    expect(rows.at(-1)).toMatchObject({ outcome: "rate_limited", target: "operator@nova.test", actorLabel: "anonymous" });
  });

  it("a stranger on another IP can still log in to the same shared demo account", async () => {
    for (let i = 0; i < 5; i++) await login("operator@nova.test", "wrong", "198.51.100.1");
    expect((await login("operator@nova.test", PASSWORD, "198.51.100.2")).status).toBe(200);
  });

  it("20 failures from one IP across emails -> that IP is blocked", async () => {
    for (let i = 0; i < 20; i++) await login(`nobody${i}@nova.test`, "wrong");
    expect((await login("viewer@nova.test", PASSWORD)).status).toBe(429);
  });

  it("a success clears that email's failures", async () => {
    for (let i = 0; i < 4; i++) await login("viewer@nova.test", "wrong");
    expect((await login("viewer@nova.test", PASSWORD)).status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await login("viewer@nova.test", "wrong")).status).toBe(401);
  });
});

describe("CSRF: state-changing /api requests must come from our origin", () => {
  const call = (method: string, path: string, headers: Record<string, string>) =>
    proxy(new NextRequest(`http://localhost:3000${path}`, { method, headers: { host: "localhost:3000", ...headers } }));
  const passes = (res: Response) => res.headers.get("x-middleware-next") === "1";

  it("refuses a POST from another site or with no Origin (403)", async () => {
    const evil = call("POST", "/api/orders/NC-1005/cancel", { origin: "https://evil.example" });
    expect(evil.status).toBe(403);
    expect(await evil.json()).toEqual({ error: "cross-site request refused" });
    expect(call("DELETE", "/api/assistant/conversations/x", {}).status).toBe(403);
    expect(call("POST", "/api/auth/login", { origin: "null" }).status).toBe(403);
  });

  it("allows same-origin POSTs, the public host behind the tunnel, GETs, and webhooks (own secret)", () => {
    expect(passes(call("POST", "/api/orders/NC-1005/cancel", { origin: "http://localhost:3000" }))).toBe(true);
    expect(passes(call("POST", "/api/auth/login", { "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(passes(call("POST", "/api/sync", { origin: "https://novaops.balaastratech.com", "x-forwarded-host": "novaops.balaastratech.com" }))).toBe(true);
    expect(passes(call("GET", "/api/orders", { origin: "https://evil.example" }))).toBe(true);
    expect(passes(call("POST", "/api/webhooks", {}))).toBe(true);
  });

  it("APP_ORIGIN is allowed even when the tunnel rewrites Host to localhost", () => {
    expect(call("POST", "/api/sync", { origin: "https://novaops.balaastratech.com" }).status).toBe(403);
    vi.stubEnv("APP_ORIGIN", "https://novaops.balaastratech.com");
    expect(passes(call("POST", "/api/sync", { origin: "https://novaops.balaastratech.com" }))).toBe(true);
  });
});

describe("security headers and cookies", () => {
  it("every path gets CSP (no framing), nosniff, frame deny, referrer and permissions policy", async () => {
    const [rule] = await nextConfig.headers!();
    expect(rule.source).toBe("/:path*");
    const h = Object.fromEntries(rule.headers.map((x) => [x.key, x.value]));
    expect(h["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    expect(h["Content-Security-Policy"]).toContain("default-src 'self'");
    expect(h["Content-Security-Policy"]).toContain("object-src 'none'");
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["X-Frame-Options"]).toBe("DENY");
    expect(h["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(h["Permissions-Policy"]).toContain("camera=()");
    expect(nextConfig.poweredByHeader).toBe(false);
  });

  it("session and device cookies are HttpOnly + SameSite=Lax, and Secure in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const session = await createSessionCookie(1);
    expect(session).toMatch(/HttpOnly; SameSite=Lax; Max-Age=28800; Secure$/);
    expect(ensureDevice(new Request("http://x")).setCookie).toMatch(/HttpOnly; SameSite=Lax; Max-Age=604800; Secure$/);
    vi.stubEnv("NODE_ENV", "development");
    expect(await createSessionCookie(1)).not.toContain("Secure");
  });
});
