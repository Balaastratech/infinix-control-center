import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { config } from "@/server/config";
import * as schema from "./schema";

export type Db = BetterSQLite3Database<typeof schema>;

// One connection per process; kept on globalThis so `next dev` hot reloads don't open new ones.
const g = globalThis as unknown as { __novaDb?: Db };

export function getDb(): Db {
  if (!g.__novaDb) {
    const file = config.databasePath;
    if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    const sqlite = new Database(file);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 5000");
    g.__novaDb = drizzle(sqlite, { schema });
  }
  return g.__novaDb;
}
