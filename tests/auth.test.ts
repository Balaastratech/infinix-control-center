import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { GET as me } from "@/app/api/me/route";
import { POST as syncNow } from "@/app/api/sync/route";
import type { Db } from "@/server/db";
import { auditLog, users } from "@/server/db/schema";
import { PASSWORD, setupTestDb } from "./helpers/db";

// These tests are about the role check, not sync: stub the sync itself (tested in sync.test.ts).
vi.mock("@/server/services/sync", () => ({ syncAll: vi.fn(async () => ({ services: [], pendingApplied: 0 })) }));

let db: Db;
beforeAll(() => {
  db = setupTestDb();
});

function req(url: string, init: { method?: string; cookie?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (init.cookie) headers.cookie = init.cookie;
  return new Request(`http://localhost${url}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body),
  });
}

// Logs in through the real login handler and returns the "name=value" part of Set-Cookie.
async function loginAs(email: string): Promise<string> {
  const res = await login(req("/api/auth/login", { method: "POST", body: { email, password: PASSWORD } }));
  expect(res.status).toBe(200);
  const setCookie = res.headers.get("set-cookie") ?? "";
  expect(setCookie).toMatch(/^nova_session=.+; Path=\/; HttpOnly; SameSite=Lax/);
  return setCookie.split(";")[0];
}

const sync = (cookie?: string) => syncNow(req("/api/sync", { method: "POST", cookie }));

describe("requireRole on a real write route (POST /api/sync, Operator+)", () => {
  it("returns 401 when not logged in", async () => {
    const res = await sync();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "not logged in" });
  });

  it("returns 401 for a forged or tampered session cookie", async () => {
    expect((await sync("nova_session=not-a-real-seal")).status).toBe(401);
    const real = await loginAs("operator@nova.test");
    expect((await sync(real.slice(0, -4) + "AAAA")).status).toBe(401);
  });

  it("returns 403 for a Viewer", async () => {
    const res = await sync(await loginAs("viewer@nova.test"));
    expect(res.status).toBe(403);
  });

  it("lets an Operator and a Manager through the role check", async () => {
    for (const email of ["operator@nova.test", "manager@nova.test"]) {
      const res = await sync(await loginAs(email));
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
      expect(res.status).toBe(200); // the route's own body
    }
  });

  it("reads the role from the DB on every request, not from the cookie", async () => {
    const [temp] = db
      .insert(users)
      .values({ email: "temp@nova.test", role: "operator", passwordHash: db.select().from(users).get()!.passwordHash })
      .returning()
      .all();
    const cookie = await loginAs("temp@nova.test");
    expect((await sync(cookie)).status).toBe(200);

    db.update(users).set({ role: "viewer" }).where(eq(users.id, temp.id)).run();
    expect((await sync(cookie)).status).toBe(403); // same cookie, demoted

    db.delete(auditLog).where(eq(auditLog.userId, temp.id)).run(); // its sync audit rows reference the user
    db.delete(users).where(eq(users.id, temp.id)).run();
    expect((await sync(cookie)).status).toBe(401); // same cookie, user gone
  });
});

describe("login / logout", () => {
  it("rejects a wrong password and an unknown email with the same 401", async () => {
    const wrong = await login(req("/api/auth/login", { method: "POST", body: { email: "manager@nova.test", password: "nope" } }));
    const unknown = await login(req("/api/auth/login", { method: "POST", body: { email: "x@nova.test", password: PASSWORD } }));
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.json()).toEqual(await unknown.json());
    expect(wrong.headers.get("set-cookie")).toBeNull();
  });

  it("returns 400 for a malformed body", async () => {
    expect((await login(req("/api/auth/login", { method: "POST", body: "{not json" }))).status).toBe(400);
    expect((await login(req("/api/auth/login", { method: "POST", body: { email: "not-an-email" } }))).status).toBe(400);
  });

  it("GET /api/me returns the user with the role from the DB", async () => {
    const res = await me(req("/api/me", { cookie: await loginAs("Manager2@nova.test") }));
    expect(res.status).toBe(200);
    expect((await res.json()).user).toMatchObject({ email: "manager2@nova.test", role: "manager" });
  });

  it("logout expires the cookie", async () => {
    const res = await logout(req("/api/auth/logout", { method: "POST" }));
    expect(res.headers.get("set-cookie")).toMatch(/^nova_session=; .*Max-Age=0/);
  });

  it("a successful login and a logout are audited with who and role", async () => {
    const lastAudit = (action: string) => db.select().from(auditLog).where(eq(auditLog.action, action)).all().at(-1);
    const cookie = await loginAs("operator@nova.test");
    expect(lastAudit("auth.login")).toMatchObject({ actorLabel: "operator@nova.test", role: "operator", outcome: "ok" });
    await logout(req("/api/auth/logout", { method: "POST", cookie }));
    expect(lastAudit("auth.logout")).toMatchObject({ actorLabel: "operator@nova.test", role: "operator", outcome: "ok" });
  });

  it("the session cookie is not Secure outside production", async () => {
    expect(await loginAs("viewer@nova.test")).toBeTruthy();
    const res = await login(req("/api/auth/login", { method: "POST", body: { email: "viewer@nova.test", password: PASSWORD } }));
    expect(res.headers.get("set-cookie")).not.toMatch(/Secure/);
  });
});

// Drizzle wraps driver errors ("Failed to run the query ..."); the SQLite message is in `cause`.
function sqliteError(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return String((e as { cause?: Error }).cause?.message ?? e);
  }
  return "no error";
}

describe("schema guards", () => {
  it("rejects a role outside viewer/operator/manager", () => {
    expect(sqliteError(() => db.run(sql`INSERT INTO users (email, password_hash, role) VALUES ('a@b.c', 'x', 'admin')`))).toMatch(/CHECK/);
  });

  it("does not allow a cancel to enter the approval path", () => {
    expect(sqliteError(() => db.run(sql`INSERT INTO operations (type, order_id, status, requested_by_label) VALUES ('cancel', 'NC-1004', 'pending_approval', 't')`))).toMatch(/CHECK/);
    expect(sqliteError(() => db.run(sql`INSERT INTO operations (type, order_id, status, requested_by_label) VALUES ('cancel', 'NC-1004', 'submitted', 't')`))).toBe("no error");
  });

  it("requires a positive amount on refunds", () => {
    expect(sqliteError(() => db.run(sql`INSERT INTO operations (type, order_id, amount_minor, requested_by_label) VALUES ('refund', 'NC-1003', 0, 't')`))).toMatch(/CHECK/);
  });

  it("rejects a duplicate webhook event_id", () => {
    const ins = sql`INSERT INTO webhook_events (event_id, type, occurred_at, payload, status) VALUES ('evt-x', 'order.cancelled', '2026-11-22T10:10:00Z', '{}', 'applied')`;
    db.run(ins);
    expect(sqliteError(() => db.run(ins))).toMatch(/UNIQUE/);
  });
});
