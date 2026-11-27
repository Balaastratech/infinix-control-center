import { eq } from "drizzle-orm";
import { getDb } from "@/server/db";
import { users, type Role } from "@/server/db/schema";
import { jsonError } from "@/server/http";
import { getCookie, readSessionUserId, SESSION_COOKIE } from "./session";

export interface AuthUser {
  id: number;
  email: string;
  role: Role;
}

export const ANY_ROLE: readonly Role[] = ["viewer", "operator", "manager"];
export const CAN_OPERATE: readonly Role[] = ["operator", "manager"];
export const MANAGER_ONLY: readonly Role[] = ["manager"];

// The session cookie only says who you are; the role comes from the DB on every request,
// so a role change or a deleted user takes effect immediately.
export async function getSessionUser(cookieValue: string | undefined): Promise<AuthUser | null> {
  const userId = await readSessionUserId(cookieValue);
  if (userId === null) return null;
  const row = getDb()
    .select({ id: users.id, email: users.email, role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  return row ?? null;
}

// Usage in a route: const auth = await requireRole(req, CAN_OPERATE); if (auth instanceof Response) return auth;
export async function requireRole(req: Request, allowed: readonly Role[]): Promise<AuthUser | Response> {
  const user = await getSessionUser(getCookie(req, SESSION_COOKIE));
  if (!user) return jsonError(401, "not logged in");
  if (!allowed.includes(user.role)) return jsonError(403, `role ${user.role} cannot do this`);
  return user;
}
