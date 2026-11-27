import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/server/auth/require-role";
import { SESSION_COOKIE } from "@/server/auth/session";
import { OrdersList } from "./orders-list";

export default async function OrdersPage() {
  const user = await getSessionUser((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) redirect("/login");
  return (
    <main>
      <p>
        <Link href="/">Home</Link>
      </p>
      <h1>Orders</h1>
      <OrdersList />
    </main>
  );
}
