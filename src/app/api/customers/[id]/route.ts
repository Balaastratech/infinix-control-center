import { isValidId } from "@/server/clients/mock";
import { ANY_ROLE, requireRole } from "@/server/auth/require-role";
import { jsonError } from "@/server/http";
import { getCustomerDetail } from "@/server/services/customers";

export async function GET(req: Request, ctx: RouteContext<"/api/customers/[id]">) {
  const auth = await requireRole(req, ANY_ROLE);
  if (auth instanceof Response) return auth;
  const { id } = await ctx.params;
  if (!isValidId(id)) return jsonError(400, "invalid customer id");
  const detail = getCustomerDetail(id);
  return detail ? Response.json(detail) : jsonError(404, "unknown customer");
}
