import { cookies } from "next/headers";
import { AppHeader } from "../app-header";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/server/auth/require-role";
import { SESSION_COOKIE } from "@/server/auth/session";
import { OrdersList } from "./orders-list";

export default async function OrdersPage() {
  const user = await getSessionUser((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) redirect("/login");
  return (
    <main>
      <AppHeader user={user} />
      <h1>Orders</h1>
      <OrdersList />
    </main>
  );
}
