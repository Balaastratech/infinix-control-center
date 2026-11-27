import { cookies } from "next/headers";
import { AppShell } from "../app-header";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/server/auth/require-role";
import { SESSION_COOKIE } from "@/server/auth/session";
import { OrdersList } from "./orders-list";

export default async function OrdersPage() {
  const user = await getSessionUser((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) redirect("/login");
  return (
    <AppShell user={user} title="Orders" subtitle="Search by order id, customer name or email. Filters live in the URL, so links and reloads keep them.">
      <OrdersList />
    </AppShell>
  );
}
