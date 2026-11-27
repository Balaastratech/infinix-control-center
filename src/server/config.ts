// All config comes from env with local defaults (CLAUDE.md "Agreed decisions"). Read lazily so tests can set env.
export const config = {
  get databasePath(): string {
    return process.env.DATABASE_PATH || "./data/app.db";
  },
  get mockBaseUrl(): string {
    return (process.env.MOCK_BASE_URL || "http://127.0.0.1:8765").replace(/\/+$/, "");
  },
  get isProduction(): boolean {
    return process.env.NODE_ENV === "production";
  },
  get sessionSecret(): string {
    return requireSecret("SESSION_SECRET");
  },
  get webhookSecret(): string {
    return requireSecret("WEBHOOK_SECRET");
  },
};

function requireSecret(name: string): string {
  const value = process.env[name];
  if (!value || value.length < 32) {
    throw new Error(`${name} is missing or shorter than 32 characters. Run \`npm run setup\` to create .env.local.`);
  }
  return value;
}
