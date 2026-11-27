import { ANY_ROLE, requireRole } from "@/server/auth/require-role";
import { listCustomers } from "@/server/services/customers";

export async function GET(req: Request) {
  const auth = await requireRole(req, ANY_ROLE);
  if (auth instanceof Response) return auth;
  const q = new URL(req.url).searchParams.get("q")?.trim().slice(0, 100) || undefined;
  return Response.json({ items: listCustomers(q) });
}
