import { ANY_ROLE, requireRole } from "@/server/auth/require-role";
import { getDashboard } from "@/server/services/dashboard";

// Same numbers as the dashboard page. Local DB only, so it answers with every upstream service down.
export async function GET(req: Request) {
  const auth = await requireRole(req, ANY_ROLE);
  if (auth instanceof Response) return auth;
  return Response.json(getDashboard());
}
