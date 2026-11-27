import path from "node:path";
import bcrypt from "bcryptjs";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { getDb } from "@/server/db";
import { users, type Role } from "@/server/db/schema";

export const PASSWORD = "demo1234";

// Fresh in-memory DB (DATABASE_PATH=:memory: in vitest.config.ts) with the real migrations and demo users.
export function setupTestDb() {
  const db = getDb();
  migrate(db, { migrationsFolder: path.resolve("drizzle") });
  const hash = bcrypt.hashSync(PASSWORD, 4); // low cost: tests only
  const seed: [string, Role][] = [
    ["viewer@nova.test", "viewer"],
    ["operator@nova.test", "operator"],
    ["manager@nova.test", "manager"],
    ["manager2@nova.test", "manager"],
  ];
  db.insert(users)
    .values(seed.map(([email, role]) => ({ email, role, passwordHash: hash })))
    .run();
  return db;
}

// Empty every upstream-copy and integration table (users stay). Call between tests that sync or receive webhooks.
export function clearData() {
  const db = getDb();
  for (const table of ["refunds", "tickets", "approvals", "operations", "orders", "payments", "shipments", "customers", "webhook_events", "sync_runs", "service_health", "audit_log"]) {
    db.run(sql.raw(`DELETE FROM ${table}`));
  }
}
