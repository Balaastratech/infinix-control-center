import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/server/auth/require-role";
import { SESSION_COOKIE } from "@/server/auth/session";
import { AppShell } from "../../app-header";
import { OrderDetail } from "./order-detail";

export default async function OrderPage({ params }: PageProps<"/orders/[id]">) {
  const user = await getSessionUser((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) redirect("/login");
  const { id } = await params;
  return (
    <AppShell
      user={user}
      title={`Order ${id}`}
      crumb={
        <Link className="crumb" href="/orders">
          ← All orders
        </Link>
      }
    >
      {/* The actions only mirror the role and the rules; every route checks them again. */}
      <OrderDetail id={id} canOperate={user.role !== "viewer"} />
    </AppShell>
  );
}
