import { CAN_OPERATE, requireRole } from "@/server/auth/require-role";
import { jsonError } from "@/server/http";

// Sync now (Operator, Manager). The sync itself lands in slice 2.
export async function POST(req: Request) {
  const auth = await requireRole(req, CAN_OPERATE);
  if (auth instanceof Response) return auth;
  return jsonError(501, "sync not implemented yet");
}
