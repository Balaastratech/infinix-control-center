import { cookies } from "next/headers";
import { AppShell } from "../app-header";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/server/auth/require-role";
import { SESSION_COOKIE } from "@/server/auth/session";
import { AuditLog } from "./audit-log";

export default async function AuditPage() {
  const user = await getSessionUser((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) redirect("/login");
  return (
    <AppShell user={user} title="Audit log" subtitle="Who did what, with which role, and the outcome.">
      <AuditLog />
    </AppShell>
  );
}
