// npm run setup: create .env.local (if missing keys), run migrations, seed demo users if the users table is empty.
// Safe to run any number of times; never deletes or overwrites data.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

const ENV_FILE = ".env.local";
const GENERATED_SECRETS = ["SESSION_SECRET", "WEBHOOK_SECRET"];
const DEMO_PASSWORD = "demo1234"; // documented demo credential, not a secret
const DEMO_USERS = [
  ["viewer@nova.test", "viewer"],
  ["operator@nova.test", "operator"],
  ["manager@nova.test", "manager"],
  ["manager2@nova.test", "manager"],
];

function ensureEnvFile() {
  const existing = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : "";
  const has = (key) => new RegExp(`^${key}=.+`, "m").test(existing);
  const missing = GENERATED_SECRETS.filter((key) => !has(key));
  if (missing.length === 0) {
    console.log(`${ENV_FILE}: present, secrets kept`);
    return;
  }
  const lines = missing.map((key) => `${key}=${crypto.randomBytes(32).toString("hex")}`);
  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(ENV_FILE, prefix + lines.join("\n") + "\n", { mode: 0o600 });
  console.log(`${ENV_FILE}: generated ${missing.join(", ")}`);
}

// Same rules and shape as seedWorkflows() in src/server/services/workflows.ts (the app validates them on edit).
function seedWorkflows(sqlite) {
  const { n } = sqlite.prepare("SELECT COUNT(*) AS n FROM workflows").get();
  if (n > 0) return console.log(`workflows: ${n} already present, seed skipped`);
  const seed = JSON.parse(fs.readFileSync("src/server/db/seed-workflows.json", "utf8"));
  const insert = sqlite.prepare("INSERT INTO workflows (name, trigger, conditions, action, action_params, enabled) VALUES (?, ?, ?, ?, ?, ?)");
  sqlite.transaction(() =>
    seed.forEach(({ name, trigger, conditions, action: { type, ...params }, enabled }) =>
      insert.run(name, trigger, JSON.stringify(conditions), type, JSON.stringify(params), enabled ? 1 : 0),
    ),
  )();
  console.log(`workflows: seeded ${seed.map((w) => w.name).join(", ")}`);
}

function main() {
  ensureEnvFile();
  process.loadEnvFile(ENV_FILE);

  const dbPath = process.env.DATABASE_PATH || "./data/app.db";
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  migrate(drizzle(sqlite), { migrationsFolder: "./drizzle" });
  console.log(`database: ${dbPath} migrated`);

  const { n } = sqlite.prepare("SELECT COUNT(*) AS n FROM users").get();
  if (n > 0) {
    console.log(`users: ${n} already present, seed skipped`);
  } else {
    const hash = bcrypt.hashSync(DEMO_PASSWORD, 10);
    const insert = sqlite.prepare("INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)");
    sqlite.transaction(() => DEMO_USERS.forEach(([email, role]) => insert.run(email, hash, role)))();
    console.log(`users: seeded ${DEMO_USERS.map(([e]) => e).join(", ")} (password ${DEMO_PASSWORD})`);
  }
  seedWorkflows(sqlite);
  sqlite.close();
}

main();
