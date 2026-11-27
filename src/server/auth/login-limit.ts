// Login rate limit (docs/assistant-design.md section 9): 5 failures per 15 min per (IP, email), 20 per 15 min per IP.
// There is no per-email limit on purpose: the demo logins are shared and their password is public, so a per-email
// lockout would only let one stranger lock everyone else out.
// ponytail: in-memory, per process, resets on restart. Fine for one node; a DB table if we ever run more than one.

const WINDOW_MS = 15 * 60 * 1000;
const PER_PAIR = 5;
const PER_IP = 20;
const failures = new Map<string, number[]>();

// The tunnel sets CF-Connecting-IP; the app is only reachable through it in production.
export function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
}

const recent = (key: string, now: number) => (failures.get(key) ?? []).filter((t) => now - t < WINDOW_MS);

// Seconds to wait, or null when a login attempt is allowed.
export function loginRetryAfter(ip: string, email: string, now = Date.now()): number | null {
  const pair = recent(`${ip}|${email}`, now);
  const byIp = recent(ip, now);
  const blocking = pair.length >= PER_PAIR ? pair : byIp.length >= PER_IP ? byIp : null;
  return blocking ? Math.ceil((blocking[0] + WINDOW_MS - now) / 1000) : null;
}

export function recordLoginFailure(ip: string, email: string, now = Date.now()): void {
  for (const key of [`${ip}|${email}`, ip]) failures.set(key, [...recent(key, now), now]);
}

export function recordLoginSuccess(ip: string, email: string): void {
  failures.delete(`${ip}|${email}`);
}

export const resetLoginLimits = () => failures.clear();
