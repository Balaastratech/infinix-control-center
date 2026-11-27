import { z } from "zod";
import { ANY_ROLE, requireRole } from "@/server/auth/require-role";
import { jsonError } from "@/server/http";
import { EVENT_FILTER_STATUSES, listSyncRuns, listWebhookEvents, webhookEventTypes } from "@/server/services/dashboard";
import { getHealth } from "@/server/services/health";

const querySchema = z.object({
  status: z.enum(EVENT_FILTER_STATUSES).optional(),
  type: z.string().max(64).optional(),
});

// Sync run history, service health and webhook events (filter by status and type).
export async function GET(req: Request) {
  const auth = await requireRole(req, ANY_ROLE);
  if (auth instanceof Response) return auth;
  const params = Object.fromEntries(new URL(req.url).searchParams);
  for (const k of Object.keys(params)) if (params[k] === "") delete params[k];
  const q = querySchema.safeParse(params);
  if (!q.success) return jsonError(400, "invalid query");
  return Response.json({
    health: getHealth(),
    syncRuns: listSyncRuns(),
    events: listWebhookEvents(q.data),
    eventTypes: webhookEventTypes(),
    eventStatuses: EVENT_FILTER_STATUSES,
  });
}
