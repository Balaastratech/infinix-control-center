import { isValidId } from "@/server/clients/mock";
import { CAN_OPERATE, requireRole } from "@/server/auth/require-role";
import { jsonError } from "@/server/http";
import { userActor } from "@/server/services/audit";
import { reconcileCancel } from "@/server/services/orders";

// "Push cancel upstream" for an order cancelled locally (webhook) that upstream still shows as processing.
// 200 upstream agrees · 409 not in that state (no API call) · 502 the Commerce API said no or was unreachable.
export async function POST(req: Request, ctx: RouteContext<"/api/orders/[id]/reconcile-cancel">) {
  const auth = await requireRole(req, CAN_OPERATE);
  if (auth instanceof Response) return auth;
  const { id } = await ctx.params;
  if (!isValidId(id)) return jsonError(400, "invalid order id");
  const result = await reconcileCancel(id, userActor(auth));
  if (result.ok) return Response.json(result);
  const status = result.code === "not_found" ? 404 : result.code === "refused" ? 409 : 502;
  return jsonError(status, result.reason, { operationId: result.operationId, upstreamStatus: result.httpStatus });
}
