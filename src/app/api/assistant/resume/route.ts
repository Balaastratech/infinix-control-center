import { MANAGER_ONLY, requireRole } from "@/server/auth/require-role";
import { aiHealth, resumeAi } from "@/server/services/assistant-breaker";

// Manager only: clear a paused/degraded AI state (after the usage limit was raised). Audited. 401 · 403 · 200 health.
export async function POST(req: Request) {
  const auth = await requireRole(req, MANAGER_ONLY);
  if (auth instanceof Response) return auth;
  resumeAi(auth);
  return Response.json(aiHealth());
}
