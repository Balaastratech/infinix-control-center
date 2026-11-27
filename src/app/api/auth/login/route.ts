import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { createSessionCookie } from "@/server/auth/session";
import { getDb } from "@/server/db";
import { users } from "@/server/db/schema";
import { jsonError, parseBody } from "@/server/http";

const LoginBody = z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1) });

export async function POST(req: Request) {
  const body = await parseBody(req, LoginBody);
  if (body instanceof Response) return body;

  const user = getDb().select().from(users).where(eq(users.email, body.email)).get();
  // Same message for unknown email and wrong password.
  if (!user || !(await bcrypt.compare(body.password, user.passwordHash))) {
    return jsonError(401, "invalid email or password");
  }
  return Response.json(
    { user: { id: user.id, email: user.email, role: user.role } },
    { headers: { "Set-Cookie": await createSessionCookie(user.id) } },
  );
}
