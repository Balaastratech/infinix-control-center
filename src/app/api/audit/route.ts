import { z } from "zod";
import { ANY_ROLE, requireRole } from "@/server/auth/require-role";
import { jsonError } from "@/server/http";
import { listAudit } from "@/server/services/audit";

const querySchema = z.object({
  action: z.string().max(100).optional(),
  user: z.string().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

export async function GET(req: Request) {
  const auth = await requireRole(req, ANY_ROLE);
  if (auth instanceof Response) return auth;
  const params = Object.fromEntries(new URL(req.url).searchParams);
  for (const k of Object.keys(params)) if (params[k] === "") delete params[k];
  const q = querySchema.safeParse(params);
  if (!q.success) return jsonError(400, "invalid query");
  return Response.json(listAudit(q.data));
}
