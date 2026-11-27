import { jsonError, parseBody } from "@/server/http";
import { eventSchema, receiveWebhook, verifyWebhookSecret } from "@/server/services/webhooks";

// Upstream events. Secret first (401), then shape (400), then dedupe/apply (200 with what happened).
export async function POST(req: Request) {
  if (!verifyWebhookSecret(req.headers.get("x-webhook-secret"))) return jsonError(401, "invalid webhook secret");
  const event = await parseBody(req, eventSchema);
  if (event instanceof Response) return event;
  const { status } = await receiveWebhook(event);
  return Response.json({ event_id: event.event_id, status });
}
