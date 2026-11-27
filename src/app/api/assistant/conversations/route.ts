import { z } from "zod";
import { ANY_ROLE, requireRole } from "@/server/auth/require-role";
import { ensureDevice } from "@/server/auth/device";
import { jsonError, parseBody } from "@/server/http";
import { ask } from "@/server/services/assistant";
import { limits, listConversations } from "@/server/services/conversations";

const withCookie = (res: Response, setCookie?: string) => {
  if (setCookie) res.headers.append("Set-Cookie", setCookie);
  return res;
};

// My conversations (this user, this browser). Sets the device cookie on first use.
export async function GET(req: Request) {
  const auth = await requireRole(req, ANY_ROLE);
  if (auth instanceof Response) return auth;
  const { device, setCookie } = ensureDevice(req);
  return withCookie(Response.json({ conversations: listConversations({ userId: auth.id, device }), maxChars: limits.maxChars }), setCookie);
}

// Start a conversation with its first question. 200 answer · 400 bad input · 429 burst limit.
export async function POST(req: Request) {
  const auth = await requireRole(req, ANY_ROLE);
  if (auth instanceof Response) return auth;
  const body = await parseBody(req, z.object({ text: z.string().trim().min(1).max(limits.maxChars) }).strict());
  if (body instanceof Response) return body;
  const { device, setCookie } = ensureDevice(req);
  const r = await ask({ userId: auth.id, device }, auth, body.text, null);
  return withCookie(r.ok ? Response.json(r) : jsonError(r.status, r.error), setCookie);
}
