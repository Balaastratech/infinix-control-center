import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { request } from "@/server/clients/mock";
import { BASE, server } from "./helpers/mock-server";

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// Replies with the given responses in order (the last one repeats) and counts the calls.
function sequence(method: "get" | "post", path: string, replies: (() => Response)[]) {
  const calls = { n: 0 };
  server.use(http[method](`${BASE}${path}`, () => replies[Math.min(calls.n++, replies.length - 1)]()));
  return calls;
}
const unavailable = () => HttpResponse.json({ error: "carrier temporarily unavailable" }, { status: 503 });

describe("mock HTTP client", () => {
  it("retries a 503 and returns the success that follows", async () => {
    const calls = sequence("get", "/shipping/shipments/NC-1012", [unavailable, () => HttpResponse.json({ id: "S-012" })]);
    const res = await request("GET", "/shipping/shipments/NC-1012");
    expect(res).toEqual({ ok: true, status: 200, data: { id: "S-012" } });
    expect(calls.n).toBe(2);
  });

  it("fails after exactly 3 attempts when every reply is 503", async () => {
    const calls = sequence("get", "/shipping/shipments/NC-1012", [unavailable]);
    const res = await request("GET", "/shipping/shipments/NC-1012");
    expect(res).toEqual({ ok: false, status: 503, error: "carrier temporarily unavailable" });
    expect(calls.n).toBe(3);
  });

  it("retries network errors, also 3 attempts in total", async () => {
    const calls = sequence("get", "/commerce/orders", [() => HttpResponse.error()]);
    const res = await request("GET", "/commerce/orders");
    expect(res.ok).toBe(false);
    expect(res.status).toBeNull();
    expect(calls.n).toBe(3);
  });

  it("does not retry a 404", async () => {
    const calls = sequence("get", "/commerce/orders/NC-9999", [() => HttpResponse.json({ error: "not found" }, { status: 404 })]);
    expect(await request("GET", "/commerce/orders/NC-9999")).toEqual({ ok: false, status: 404, error: "not found" });
    expect(calls.n).toBe(1);
  });

  it("does not retry a 409", async () => {
    const calls = sequence("post", "/payments/refunds", [() => HttpResponse.json({ error: "ineligible refund" }, { status: 409 })]);
    const res = await request("POST", "/payments/refunds", { order_id: "NC-1004", amount_minor: 100 });
    expect(res).toEqual({ ok: false, status: 409, error: "ineligible refund" });
    expect(calls.n).toBe(1);
  });

  it("treats a 501 HTML reply as a final error", async () => {
    const calls = sequence("post", "/commerce/orders/NC-1001/cancel", [
      () => new HttpResponse("<html>501 Unsupported method</html>", { status: 501, headers: { "Content-Type": "text/html" } }),
    ]);
    expect(await request("POST", "/commerce/orders/NC-1001/cancel", {})).toEqual({
      ok: false,
      status: 501,
      error: "HTTP 501: non-JSON reply",
    });
    expect(calls.n).toBe(1);
  });

  it("never sends an array or object order_id (it crashes the mock)", async () => {
    const calls = sequence("post", "/payments/refunds", [() => HttpResponse.json({}, { status: 201 })]);
    for (const bad of [["NC-1001"], { id: "NC-1001" }, "NC 1001", 1001]) {
      expect(await request("POST", "/payments/refunds", { order_id: bad, amount_minor: 100 })).toEqual({
        ok: false,
        status: null,
        error: "invalid order_id",
      });
    }
    expect(calls.n).toBe(0);
  });
});
