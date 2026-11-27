import { ANY_ROLE, MANAGER_ONLY, requireRole } from "@/server/auth/require-role";
import { jsonError, parseBody } from "@/server/http";
import { userActor } from "@/server/services/audit";
import { createWorkflow, listWorkflows, workflowSchema } from "@/server/services/workflows";

export async function GET(req: Request) {
  const auth = await requireRole(req, ANY_ROLE);
  if (auth instanceof Response) return auth;
  return Response.json({ items: listWorkflows() });
}

// 201 created · 400 bad fields/ops/values · 409 name taken
export async function POST(req: Request) {
  const auth = await requireRole(req, MANAGER_ONLY);
  if (auth instanceof Response) return auth;
  const body = await parseBody(req, workflowSchema);
  if (body instanceof Response) return body;
  const result = createWorkflow(body, userActor(auth));
  return result.ok ? Response.json(result.workflow, { status: 201 }) : jsonError(409, result.reason);
}
