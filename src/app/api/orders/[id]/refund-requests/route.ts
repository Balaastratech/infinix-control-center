import { z } from "zod";
import { isValidId } from "@/server/clients/mock";
import { CAN_OPERATE, requireRole } from "@/server/auth/require-role";
import { jsonError, parseBody } from "@/server/http";
import { userActor } from "@/server/services/audit";
import { requestRefund } from "@/server/services/refunds";

// amount_minor in paise; omitted = the full refundable amount. The cap itself is checked in the service.
const bodySchema = z.object({ amount_minor: z.number().int().positive().optional() });

// 201 pending approval · 409 refused by a rule. Never calls the Payment API.
export async function POST(req: Request, ctx: RouteContext<"/api/orders/[id]/refund-requests">) {
  const auth = await requireRole(req, CAN_OPERATE);
  if (auth instanceof Response) return auth;
  const { id } = await ctx.params;
  if (!isValidId(id)) return jsonError(400, "invalid order id");
  const body = await parseBody(req, bodySchema);
  if (body instanceof Response) return body;
  const result = requestRefund(id, body.amount_minor, userActor(auth));
  if (result.ok) return Response.json(result, { status: 201 });
  return jsonError(result.code === "not_found" ? 404 : 409, result.reason);
}
