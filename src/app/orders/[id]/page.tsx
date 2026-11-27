import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/server/auth/require-role";
import { SESSION_COOKIE } from "@/server/auth/session";
import { OrderDetail } from "./order-detail";

export default async function OrderPage({ params }: PageProps<"/orders/[id]">) {
  const user = await getSessionUser((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) redirect("/login");
  const { id } = await params;
  return (
    <main>
      <p>
        <Link href="/orders">All orders</Link>
      </p>
      <h1>Order {id}</h1>
      {/* The buttons only mirror the role; every route checks it again. */}
      <OrderDetail id={id} canOperate={user.role !== "viewer"} />
    </main>
  );
}
