import { MANAGER_ONLY, requireRole } from "@/server/auth/require-role";
import { jsonError, parseBody } from "@/server/http";
import { userActor } from "@/server/services/audit";
import { updateWorkflow, workflowId, workflowPatchSchema } from "@/server/services/workflows";

// Edit any subset of fields; { "enabled": false } disables. 400 invalid · 404 unknown · 409 name taken
export async function PATCH(req: Request, ctx: RouteContext<"/api/workflows/[id]">) {
  const auth = await requireRole(req, MANAGER_ONLY);
  if (auth instanceof Response) return auth;
  const id = workflowId((await ctx.params).id);
  if (id === null) return jsonError(400, "invalid workflow id");
  const body = await parseBody(req, workflowPatchSchema);
  if (body instanceof Response) return body;
  const result = updateWorkflow(id, body, userActor(auth));
  if (result.ok) return Response.json(result.workflow);
  if (result.code === "invalid") return jsonError(400, "invalid request", { issues: result.issues });
  return jsonError(result.code === "not_found" ? 404 : 409, result.reason);
}
