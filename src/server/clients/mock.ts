// The one HTTP client for the mock services (Commerce, Payment, Shipping). Never throws: every call returns ApiResult.
// Retries only network errors and 503 (3 attempts total, backoff); 400/404/409, 501 HTML etc. are final.
// Contract and quirks: docs/external-apis.md.
import { config } from "@/server/config";

export type ApiResult<T> = { ok: true; status: number; data: T } | { ok: false; status: number | null; error: string };

const TIMEOUT_MS = 5000;
const MAX_ATTEMPTS = 3;
export const BACKOFF_MS = [200, 400]; // wait before attempt 2 and attempt 3
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

export function isValidId(id: unknown): id is string {
  return typeof id === "string" && ID_RE.test(id);
}

// "/commerce/orders/" + "NC-1001" -> "/commerce/orders/NC-1001", or null when the id could reach the mock as garbage.
export function orderPath(prefix: string, id: unknown): string | null {
  return isValidId(id) ? prefix + encodeURIComponent(id) : null;
}

const SERVICE_NAMES: Record<string, string> = { commerce: "Commerce API", payments: "Payment API", shipping: "Shipping API" };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// retry=false for POSTs with no idempotency key (refunds): the caller checks upstream before any second attempt.
export async function request<T>(method: "GET" | "POST", path: string, body?: Record<string, unknown>, retry = true): Promise<ApiResult<T>> {
  // An array/object order_id crashes the mock with no reply, which would look like a network error and be retried.
  if (body && "order_id" in body && !isValidId(body.order_id)) {
    return { ok: false, status: null, error: "invalid order_id" };
  }
  let last: ApiResult<T> = { ok: false, status: null, error: "not attempted" };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep(BACKOFF_MS[attempt - 2]);
    last = await attemptOnce<T>(method, path, body);
    const retryable = retry && !last.ok && (last.status === null || last.status === 503);
    if (!retryable) return last;
  }
  return last;
}

async function attemptOnce<T>(method: string, path: string, body?: Record<string, unknown>): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(config.mockBaseUrl + path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    // Staff read this text: name the service, never the socket error (ECONNREFUSED, host:port).
    const service = SERVICE_NAMES[path.split("/")[1]] ?? "External service";
    const timedOut = (e as Error).name === "TimeoutError";
    return { ok: false, status: null, error: timedOut ? `${service} did not answer in time` : `${service} is unreachable` };
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    // e.g. the mock's 501 HTML for unsupported methods. Final, not retried (unless it is a 503).
    return { ok: false, status: res.status, error: `HTTP ${res.status}: non-JSON reply` };
  }
  if (res.ok) return { ok: true, status: res.status, data: data as T };
  const message = (data as { error?: unknown } | null)?.error;
  return { ok: false, status: res.status, error: typeof message === "string" ? message : `HTTP ${res.status}` };
}
