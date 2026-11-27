import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { clientIp, loginRetryAfter, recordLoginFailure, recordLoginSuccess } from "@/server/auth/login-limit";
import { createSessionCookie } from "@/server/auth/session";
import { getDb } from "@/server/db";
import { users } from "@/server/db/schema";
import { jsonError, parseBody } from "@/server/http";
import { audit } from "@/server/services/audit";

const LoginBody = z.object({ email: z.string().trim().toLowerCase().email().max(200), password: z.string().min(1).max(200) }).strict();

// 200 logged in · 400 bad body · 401 wrong email or password · 429 too many failures (Retry-After header).
export async function POST(req: Request) {
  const body = await parseBody(req, LoginBody);
  if (body instanceof Response) return body;
  const ip = clientIp(req);

  const wait = loginRetryAfter(ip, body.email);
  if (wait !== null) {
    audit({ actorLabel: "anonymous", action: "auth.login", target: body.email, outcome: "rate_limited" });
    return Response.json({ error: "too many failed logins, try again later" }, { status: 429, headers: { "Retry-After": String(wait) } });
  }

  const user = getDb().select().from(users).where(eq(users.email, body.email)).get();
  // Same message for unknown email and wrong password.
  if (!user || !(await bcrypt.compare(body.password, user.passwordHash))) {
    recordLoginFailure(ip, body.email);
    audit({ actorLabel: "anonymous", action: "auth.login", target: body.email, outcome: "failed" });
    return jsonError(401, "invalid email or password");
  }
  recordLoginSuccess(ip, body.email);
  audit({ userId: user.id, actorLabel: user.email, role: user.role, action: "auth.login", target: user.email, outcome: "ok" });
  return Response.json(
    { user: { id: user.id, email: user.email, role: user.role } },
    { headers: { "Set-Cookie": await createSessionCookie(user.id) } },
  );
}
