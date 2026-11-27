import { z } from "zod";
import { ANY_ROLE, requireRole } from "@/server/auth/require-role";
import { parseBody } from "@/server/http";
import { ask } from "@/server/services/assistant";

const bodySchema = z.object({ text: z.string().trim().min(1).max(300) });

// Any logged-in role may ask. Refund requests are role-checked inside the service (Viewer = 403) and go through the
// normal approval flow. Status: 200 answer · 403 role · 404 unknown order · 409 rule refusal.
export async function POST(req: Request) {
  const auth = await requireRole(req, ANY_ROLE);
  if (auth instanceof Response) return auth;
  const body = await parseBody(req, bodySchema);
  if (body instanceof Response) return body;
  const { status, ...answer } = ask(body.text, auth);
  return Response.json(answer, { status });
}
