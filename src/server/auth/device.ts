// Per-browser id for assistant conversations. Demo logins are shared, so a conversation belongs to (user, browser):
// strangers on the same demo account can't read each other's chats. docs/assistant-design.md section 1.
import crypto from "node:crypto";
import { config } from "@/server/config";
import { getCookie } from "./session";

export const DEVICE_COOKIE = "nova_asst_dev";
const MAX_AGE = 7 * 24 * 60 * 60;
const VALID = /^[a-f0-9]{32}$/;

export function readDevice(req: Request): string | null {
  const v = getCookie(req, DEVICE_COOKIE);
  return v && VALID.test(v) ? v : null;
}

// Existing device, or a new one plus the Set-Cookie header to send with the response.
export function ensureDevice(req: Request): { device: string; setCookie?: string } {
  const existing = readDevice(req);
  if (existing) return { device: existing };
  const device = crypto.randomBytes(16).toString("hex");
  const secure = config.isProduction ? "; Secure" : "";
  return { device, setCookie: `${DEVICE_COOKIE}=${device}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}${secure}` };
}
