import { CAN_OPERATE, requireRole } from "@/server/auth/require-role";
import { userActor } from "@/server/services/audit";
import { requestBulkRefunds } from "@/server/services/refunds";

// "Request full refunds": one pending approval per owed order. Returns created/skipped counts.
export async function POST(req: Request) {
  const auth = await requireRole(req, CAN_OPERATE);
  if (auth instanceof Response) return auth;
  return Response.json(requestBulkRefunds(userActor(auth)));
}
