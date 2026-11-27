import { ANY_ROLE, requireRole } from "@/server/auth/require-role";
import { jsonError } from "@/server/http";
import { listExecutions, workflowId } from "@/server/services/workflows";

export async function GET(req: Request, ctx: RouteContext<"/api/workflows/[id]/executions">) {
  const auth = await requireRole(req, ANY_ROLE);
  if (auth instanceof Response) return auth;
  const id = workflowId((await ctx.params).id);
  if (id === null) return jsonError(400, "invalid workflow id");
  return Response.json({ items: listExecutions(id) });
}
