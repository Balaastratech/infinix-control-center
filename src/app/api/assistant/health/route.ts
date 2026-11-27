import { ANY_ROLE, requireRole } from "@/server/auth/require-role";
import { aiHealth } from "@/server/services/assistant-breaker";

// Assistant health for the Integrations card: AI status, today's usage, fallbacks by reason, last error. Any role.
export async function GET(req: Request) {
  const auth = await requireRole(req, ANY_ROLE);
  if (auth instanceof Response) return auth;
  return Response.json(aiHealth());
}
