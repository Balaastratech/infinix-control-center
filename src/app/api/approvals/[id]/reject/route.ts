import { z } from "zod";
import { MANAGER_ONLY, requireRole } from "@/server/auth/require-role";
import { jsonError, parseBody } from "@/server/http";
import { userActor } from "@/server/services/audit";
import { rejectRefund } from "@/server/services/approvals";
import { approvalId, decisionResponse } from "@/server/services/decision-http";

const bodySchema = z.object({ note: z.string().trim().min(1, "a note is required").max(500) });

export async function POST(req: Request, ctx: RouteContext<"/api/approvals/[id]/reject">) {
  const auth = await requireRole(req, MANAGER_ONLY);
  if (auth instanceof Response) return auth;
  const id = approvalId((await ctx.params).id);
  if (id === null) return jsonError(400, "invalid approval id");
  const body = await parseBody(req, bodySchema);
  if (body instanceof Response) return body;
  return decisionResponse(rejectRefund(id, body.note, userActor(auth)));
}
