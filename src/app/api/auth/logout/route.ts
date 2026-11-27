import { getSessionUser } from "@/server/auth/require-role";
import { clearSessionCookie, getCookie, SESSION_COOKIE } from "@/server/auth/session";
import { audit } from "@/server/services/audit";

// Always clears the cookie. Audited only when a real session ended (an anonymous logout changes nothing).
export async function POST(req: Request) {
  const user = await getSessionUser(getCookie(req, SESSION_COOKIE));
  if (user) audit({ userId: user.id, actorLabel: user.email, role: user.role, action: "auth.logout", target: user.email, outcome: "ok" });
  return Response.json({ ok: true }, { headers: { "Set-Cookie": clearSessionCookie() } });
}
