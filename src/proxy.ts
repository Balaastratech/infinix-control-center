// CSRF guard for the public demo (docs/assistant-design.md section 9). Session cookies are SameSite=Lax and bodies
// are JSON, and on top of that every state-changing /api request must come from our own origin. Webhooks are exempt:
// they come from other servers and carry their own X-Webhook-Secret.
import { NextResponse, type NextRequest } from "next/server";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return req.headers.get("sec-fetch-site") === "same-origin"; // browsers that omit Origin still send this
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  // Behind the Cloudflare tunnel the public host arrives as Host (or X-Forwarded-Host); APP_ORIGIN covers a tunnel
  // that rewrites Host (e.g. APP_ORIGIN=https://novaops.balaastratech.com).
  const appHost = process.env.APP_ORIGIN ? safeHost(process.env.APP_ORIGIN) : null;
  const allowed = [req.headers.get("host"), req.headers.get("x-forwarded-host"), new URL(req.url).host, appHost].filter(Boolean);
  return allowed.includes(host);
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (SAFE_METHODS.has(req.method) || pathname === "/api/webhooks" || sameOrigin(req)) return NextResponse.next();
  return NextResponse.json({ error: "cross-site request refused" }, { status: 403 });
}

export const config = { matcher: "/api/:path*" };
