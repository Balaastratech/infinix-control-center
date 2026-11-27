import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/server/db";
import { serviceHealth, SERVICES, syncRuns } from "@/server/db/schema";

export type Service = (typeof SERVICES)[number];

const now = () => new Date().toISOString();

// A failure recorded here has already been retried (3 attempts), so one failure marks the service down.
export function recordHealth(service: Service, ok: boolean, error?: string): void {
  const at = now();
  const db = getDb();
  if (ok) {
    db.insert(serviceHealth)
      .values({ service, lastOkAt: at, consecutiveFailures: 0, down: false })
      .onConflictDoUpdate({ target: serviceHealth.service, set: { lastOkAt: at, consecutiveFailures: 0, down: false } })
      .run();
  } else {
    db.insert(serviceHealth)
      .values({ service, lastErrorAt: at, lastError: error ?? null, consecutiveFailures: 1, down: true })
      .onConflictDoUpdate({
        target: serviceHealth.service,
        set: {
          lastErrorAt: at,
          lastError: error ?? null,
          consecutiveFailures: sql`${serviceHealth.consecutiveFailures} + 1`,
          down: true,
        },
      })
      .run();
  }
}

export interface ServiceStatus {
  service: Service;
  status: "ok" | "down" | "unknown";
  lastOkAt: string | null;
  lastError: string | null;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
}

export function getHealth(): ServiceStatus[] {
  const db = getDb();
  return SERVICES.map((service) => {
    const h = db.select().from(serviceHealth).where(eq(serviceHealth.service, service)).get();
    const run = db
      .select()
      .from(syncRuns)
      .where(eq(syncRuns.service, service))
      .orderBy(desc(syncRuns.id))
      .limit(1)
      .get();
    return {
      service,
      status: !h ? "unknown" : h.down ? "down" : "ok",
      lastOkAt: h?.lastOkAt ?? null,
      lastError: h?.down ? h.lastError : null,
      lastSyncAt: run?.finishedAt ?? run?.startedAt ?? null,
      lastSyncStatus: run?.status ?? null,
    };
  });
}
