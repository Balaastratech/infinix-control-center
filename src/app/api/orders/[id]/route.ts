import { isValidId } from "@/server/clients/mock";
import { ANY_ROLE, requireRole } from "@/server/auth/require-role";
import { jsonError } from "@/server/http";
import { getOrderDetail } from "@/server/services/orders";

// Always answers from local data; a failed live shipment lookup comes back as `shippingError`, never a 5xx.
export async function GET(req: Request, ctx: RouteContext<"/api/orders/[id]">) {
  const auth = await requireRole(req, ANY_ROLE);
  if (auth instanceof Response) return auth;
  const { id } = await ctx.params;
  if (!isValidId(id)) return jsonError(400, "invalid order id");
  const detail = await getOrderDetail(id);
  return detail ? Response.json(detail) : jsonError(404, "unknown order");
}
