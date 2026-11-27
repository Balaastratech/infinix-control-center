import { ANY_ROLE, requireRole } from "@/server/auth/require-role";
import { listApprovals } from "@/server/services/approvals";

export async function GET(req: Request) {
  const auth = await requireRole(req, ANY_ROLE);
  if (auth instanceof Response) return auth;
  return Response.json({ items: listApprovals() });
}
