import { z } from "zod";
import { ANY_ROLE, requireRole } from "@/server/auth/require-role";
import { readDevice } from "@/server/auth/device";
import { jsonError, parseBody } from "@/server/http";
import { deleteConversation, getConversation, renameConversation } from "@/server/services/conversations";

type Ctx = { params: Promise<{ id: string }> };
const UUID = /^[0-9a-f-]{36}$/;

// Owner = logged-in user + this browser. Anything else (other user, other browser, bad id) is a 404.
async function owned(req: Request, ctx: Ctx) {
  const auth = await requireRole(req, ANY_ROLE);
  if (auth instanceof Response) return auth;
  const { id } = await ctx.params;
  const device = readDevice(req);
  if (!device || !UUID.test(id)) return jsonError(404, "conversation not found");
  return { owner: { userId: auth.id, device }, id };
}

export async function GET(req: Request, ctx: Ctx) {
  const o = await owned(req, ctx);
  if (o instanceof Response) return o;
  const conv = getConversation(o.owner, o.id);
  return conv ? Response.json(conv) : jsonError(404, "conversation not found");
}

export async function PATCH(req: Request, ctx: Ctx) {
  const o = await owned(req, ctx);
  if (o instanceof Response) return o;
  const body = await parseBody(req, z.object({ title: z.string().trim().min(1).max(60) }).strict());
  if (body instanceof Response) return body;
  return renameConversation(o.owner, o.id, body.title) ? Response.json({ ok: true }) : jsonError(404, "conversation not found");
}

export async function DELETE(req: Request, ctx: Ctx) {
  const o = await owned(req, ctx);
  if (o instanceof Response) return o;
  return deleteConversation(o.owner, o.id) ? Response.json({ ok: true }) : jsonError(404, "conversation not found");
}
