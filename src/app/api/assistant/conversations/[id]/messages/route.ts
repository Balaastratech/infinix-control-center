import { z } from "zod";
import { ANY_ROLE, requireRole } from "@/server/auth/require-role";
import { readDevice } from "@/server/auth/device";
import { jsonError, parseBody } from "@/server/http";
import { ask } from "@/server/services/assistant";
import { limits } from "@/server/services/conversations";

// Ask in one of my conversations. 200 answer · 400 bad input · 404 not mine · 409 conversation full · 429 burst limit.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(req, ANY_ROLE);
  if (auth instanceof Response) return auth;
  const { id } = await ctx.params;
  const device = readDevice(req);
  if (!device || !/^[0-9a-f-]{36}$/.test(id)) return jsonError(404, "conversation not found");
  const body = await parseBody(req, z.object({ text: z.string().trim().min(1).max(limits.maxChars) }).strict());
  if (body instanceof Response) return body;
  const r = ask({ userId: auth.id, device }, auth, body.text, id);
  return r.ok ? Response.json(r) : jsonError(r.status, r.error);
}
