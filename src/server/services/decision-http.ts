import { jsonError } from "@/server/http";
import type { DecisionResult } from "./approvals";

const STATUS = { not_found: 404, forbidden: 403, conflict: 409 } as const;

export function approvalId(raw: string): number | null {
  return /^\d{1,9}$/.test(raw) && Number(raw) > 0 ? Number(raw) : null;
}

// ok -> 200 with the final status (a refund that ended "failed" is still a decided approval; read `status`/`error`).
export function decisionResponse(r: DecisionResult): Response {
  return r.ok ? Response.json(r) : jsonError(STATUS[r.code], r.reason);
}
