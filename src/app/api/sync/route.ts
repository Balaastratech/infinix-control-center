import { CAN_OPERATE, requireRole } from "@/server/auth/require-role";
import { audit } from "@/server/services/audit";
import { syncAll } from "@/server/services/sync";

// Sync now (Operator, Manager). Always 200 with a per-service report; a down service shows as "failed" in it.
export async function POST(req: Request) {
  const auth = await requireRole(req, CAN_OPERATE);
  if (auth instanceof Response) return auth;

  const report = await syncAll();
  const failed = report.services.filter((s) => s.status === "failed").length;
  const outcome = failed === 0 ? "ok" : failed === report.services.length ? "failed" : "partial";
  audit({ userId: auth.id, actorLabel: auth.email, role: auth.role, action: "sync", target: "all", outcome, detail: report });
  return Response.json(report);
}
