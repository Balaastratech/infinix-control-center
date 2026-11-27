import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    env: {
      DATABASE_PATH: ":memory:",
      // Test-only values, not real secrets.
      SESSION_SECRET: "test-session-secret-0123456789abcdef0123456789",
      WEBHOOK_SECRET: "test-webhook-secret-0123456789abcdef0123456789",
    },
  },
});
