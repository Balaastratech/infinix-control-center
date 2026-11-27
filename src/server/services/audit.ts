import { getDb } from "@/server/db";
import { auditLog } from "@/server/db/schema";

// Who did something: a logged-in user, or a workflow (userId null, label "workflow:<name>").
export interface Actor {
  userId: number | null;
  label: string;
  role: string | null;
}

export const userActor = (u: { id: number; email: string; role: string }): Actor => ({ userId: u.id, label: u.email, role: u.role });

export interface AuditEntry {
  userId?: number | null;
  actorLabel: string; // email, "workflow:<name>", "webhook" or "system"
  role?: string | null;
  action: string;
  target?: string | null;
  outcome: string;
  detail?: unknown;
}

export function audit(entry: AuditEntry): void {
  getDb()
    .insert(auditLog)
    .values({
      userId: entry.userId ?? null,
      actorLabel: entry.actorLabel,
      role: entry.role ?? null,
      action: entry.action,
      target: entry.target ?? null,
      outcome: entry.outcome,
      detail: entry.detail === undefined ? null : typeof entry.detail === "string" ? entry.detail : JSON.stringify(entry.detail),
    })
    .run();
}
