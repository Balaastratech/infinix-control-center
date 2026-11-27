import { ANY_ROLE, requireRole } from "@/server/auth/require-role";

export async function GET(req: Request) {
  const auth = await requireRole(req, ANY_ROLE);
  if (auth instanceof Response) return auth;
  return Response.json({ user: auth });
}
