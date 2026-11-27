import { z } from "zod";
import { ANY_ROLE, requireRole } from "@/server/auth/require-role";
import { jsonError } from "@/server/http";
import { listTickets } from "@/server/services/tickets";

const querySchema = z.object({ status: z.string().max(40).optional(), orderId: z.string().max(64).optional() });

export async function GET(req: Request) {
  const auth = await requireRole(req, ANY_ROLE);
  if (auth instanceof Response) return auth;
  const q = querySchema.safeParse(Object.fromEntries([...new URL(req.url).searchParams].filter(([, v]) => v !== "")));
  if (!q.success) return jsonError(400, "invalid query");
  return Response.json(listTickets(q.data));
}
