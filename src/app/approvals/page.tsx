import { cookies } from "next/headers";
import { AppHeader } from "../app-header";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/server/auth/require-role";
import { SESSION_COOKIE } from "@/server/auth/session";
import { ApprovalsQueue } from "./approvals-queue";

export default async function ApprovalsPage() {
  const user = await getSessionUser((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) redirect("/login");
  return (
    <main>
      <AppHeader user={user} />
      <h1>Refund approvals</h1>
      {/* Buttons only mirror the role and the own-request rule; every route checks them again. */}
      <ApprovalsQueue isManager={user.role === "manager"} userId={user.id} />
    </main>
  );
}
