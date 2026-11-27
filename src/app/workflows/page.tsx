import { cookies } from "next/headers";
import { AppShell } from "../app-header";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/server/auth/require-role";
import { SESSION_COOKIE } from "@/server/auth/session";
import { WorkflowsEditor } from "./workflows-editor";

export default async function WorkflowsPage() {
  const user = await getSessionUser((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) redirect("/login");
  return (
    <AppShell user={user} title="Workflows" subtitle="Rules that run on webhooks and in-app actions. Refunds they request still need approval.">
      {/* The form only mirrors the role; every write route checks it again. */}
      <WorkflowsEditor isManager={user.role === "manager"} />
    </AppShell>
  );
}
