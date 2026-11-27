import { isValidId } from "@/server/clients/mock";
import { CAN_OPERATE, requireRole } from "@/server/auth/require-role";
import { jsonError } from "@/server/http";
import { userActor } from "@/server/services/audit";
import { cancelOrder } from "@/server/services/orders";

// 200 cancelled · 409 refused by our rule (no API call) · 502 the Commerce API said no or was unreachable.
export async function POST(req: Request, ctx: RouteContext<"/api/orders/[id]/cancel">) {
  const auth = await requireRole(req, CAN_OPERATE);
  if (auth instanceof Response) return auth;
  const { id } = await ctx.params;
  if (!isValidId(id)) return jsonError(400, "invalid order id");
  const result = await cancelOrder(id, userActor(auth));
  if (result.ok) return Response.json(result);
  const status = result.code === "not_found" ? 404 : result.code === "refused" ? 409 : 502;
  return jsonError(status, result.reason, { operationId: result.operationId, upstreamStatus: result.httpStatus });
}
