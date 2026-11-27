import { z } from "zod";
import { ANY_ROLE, requireRole } from "@/server/auth/require-role";
import { jsonError } from "@/server/http";
import { listOrders, ORDER_STATUSES, PAYMENT_STATUSES, SHIPMENT_STATUSES } from "@/server/services/orders";

const querySchema = z.object({
  q: z.string().trim().max(100).optional(),
  orderStatus: z.enum(ORDER_STATUSES).optional(),
  paymentStatus: z.enum(PAYMENT_STATUSES).optional(),
  shipmentStatus: z.enum(SHIPMENT_STATUSES).optional(),
  localAhead: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

// Empty params ("?orderStatus=") mean "no filter".
export async function GET(req: Request) {
  const auth = await requireRole(req, ANY_ROLE);
  if (auth instanceof Response) return auth;
  const params = Object.fromEntries([...new URL(req.url).searchParams].filter(([, v]) => v !== ""));
  const query = querySchema.safeParse(params);
  if (!query.success) {
    return jsonError(400, "invalid query", { issues: query.error.issues.map((i) => ({ path: i.path, message: i.message })) });
  }
  return Response.json(listOrders(query.data));
}
