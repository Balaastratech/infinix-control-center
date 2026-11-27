import { sealData, unsealData } from "iron-session";
import { config } from "@/server/config";

export const SESSION_COOKIE = "nova_session";
const TTL_SECONDS = 8 * 60 * 60; // one working day

// The cookie only carries the user id. Role is always read from the DB (see requireRole).
interface SessionData {
  userId?: number;
}

export async function createSessionCookie(userId: number): Promise<string> {
  const seal = await sealData({ userId } satisfies SessionData, { password: config.sessionSecret, ttl: TTL_SECONDS });
  return serialize(seal, TTL_SECONDS);
}

export function clearSessionCookie(): string {
  return serialize("", 0);
}

export async function readSessionUserId(cookieValue: string | undefined): Promise<number | null> {
  if (!cookieValue) return null;
  const data = await unsealData<SessionData>(cookieValue, { password: config.sessionSecret, ttl: TTL_SECONDS });
  return Number.isInteger(data.userId) ? (data.userId as number) : null; // tampered/expired seal -> {}
}

export function getCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function serialize(value: string, maxAge: number): string {
  const secure = config.isProduction ? "; Secure" : "";
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}
