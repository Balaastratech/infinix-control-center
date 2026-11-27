import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/server/auth/require-role";
import { SESSION_COOKIE } from "@/server/auth/session";
import { AppHeader } from "./app-header";
import { DashboardView } from "./dashboard-view";

export default async function Home() {
  const user = await getSessionUser((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) redirect("/login");
  return (
    <main>
      <AppHeader user={user} />
      <h1>Dashboard</h1>
      {/* Buttons only mirror the role; the routes check it again. */}
      <DashboardView canOperate={user.role !== "viewer"} />
    </main>
  );
}
