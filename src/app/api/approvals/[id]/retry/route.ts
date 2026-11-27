import { MANAGER_ONLY, requireRole } from "@/server/auth/require-role";
import { jsonError } from "@/server/http";
import { userActor } from "@/server/services/audit";
import { retryRefund } from "@/server/services/approvals";
import { approvalId, decisionResponse } from "@/server/services/decision-http";

export async function POST(req: Request, ctx: RouteContext<"/api/approvals/[id]/retry">) {
  const auth = await requireRole(req, MANAGER_ONLY);
  if (auth instanceof Response) return auth;
  const id = approvalId((await ctx.params).id);
  if (id === null) return jsonError(400, "invalid approval id");
  return decisionResponse(await retryRefund(id, userActor(auth)));
}
