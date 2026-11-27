import { and, desc, eq, sql } from "drizzle-orm";
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

export interface AuditQuery {
  action?: string;
  user?: string; // actor_label (email, "workflow:<name>", "system")
  page: number;
  pageSize: number;
}

// Newest first, filtered by exact action and/or actor. Also returns the values the filters can offer.
export function listAudit(q: AuditQuery) {
  const db = getDb();
  const cond = and(q.action ? eq(auditLog.action, q.action) : undefined, q.user ? eq(auditLog.actorLabel, q.user) : undefined);
  const total = db.select({ n: sql<number>`count(*)` }).from(auditLog).where(cond).get()!.n;
  const items = db
    .select()
    .from(auditLog)
    .where(cond)
    .orderBy(desc(auditLog.id))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize)
    .all();
  const distinct = (col: typeof auditLog.action | typeof auditLog.actorLabel) =>
    db.selectDistinct({ v: col }).from(auditLog).orderBy(col).all().map((r) => r.v);
  return { items, total, page: q.page, pageSize: q.pageSize, actions: distinct(auditLog.action), users: distinct(auditLog.actorLabel) };
}
