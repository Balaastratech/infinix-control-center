import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/server/auth/require-role";
import { SESSION_COOKIE } from "@/server/auth/session";
import { AppHeader } from "../app-header";
import { IntegrationsView } from "./integrations-view";

export default async function IntegrationsPage() {
  const user = await getSessionUser((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) redirect("/login");
  return (
    <main>
      <AppHeader user={user} />
      <h1>Integrations</h1>
      <IntegrationsView />
    </main>
  );
}
