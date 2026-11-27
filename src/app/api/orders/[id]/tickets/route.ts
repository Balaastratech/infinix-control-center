import { z } from "zod";
import { isValidId } from "@/server/clients/mock";
import { CAN_OPERATE, requireRole } from "@/server/auth/require-role";
import { jsonError, parseBody } from "@/server/http";
import { userActor } from "@/server/services/audit";
import { submitTicket, ticketReasonSchema } from "@/server/services/tickets";

const bodySchema = z.object({ reason: ticketReasonSchema }).strict();

// 201 ticket created (or adopted after a lost reply) · 404 unknown order · 502 Commerce API refused or unreachable.
export async function POST(req: Request, ctx: RouteContext<"/api/orders/[id]/tickets">) {
  const auth = await requireRole(req, CAN_OPERATE);
  if (auth instanceof Response) return auth;
  const { id } = await ctx.params;
  if (!isValidId(id)) return jsonError(400, "invalid order id");
  const body = await parseBody(req, bodySchema);
  if (body instanceof Response) return body;
  const r = await submitTicket(id, body.reason, userActor(auth), { auditAction: "ticket.create" });
  if (r.ok) return Response.json(r, { status: 201 });
  return r.code === "not_found" ? jsonError(404, r.reason) : jsonError(502, r.reason);
}
