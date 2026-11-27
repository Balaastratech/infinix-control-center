import { getHealth } from "@/server/services/health";

// No login: per-service status and last sync time, read from the local DB only.
export async function GET() {
  return Response.json({ services: getHealth() });
}
