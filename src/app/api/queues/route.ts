import { ANY_ROLE, requireRole } from "@/server/auth/require-role";
import { getQueues } from "@/server/services/queues";

// Local DB only, like the dashboard: works with every upstream service down.
export async function GET(req: Request) {
  const auth = await requireRole(req, ANY_ROLE);
  if (auth instanceof Response) return auth;
  return Response.json(getQueues());
}
