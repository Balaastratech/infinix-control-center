import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { formatMoney } from "@/lib/format";
import { getSessionUser } from "@/server/auth/require-role";
import { SESSION_COOKIE } from "@/server/auth/session";
import { listCustomers } from "@/server/services/customers";
import { AppShell } from "../app-header";
import { Card, Empty, TableWrap } from "../ui";

export default async function CustomersPage({ searchParams }: PageProps<"/customers">) {
  const user = await getSessionUser((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) redirect("/login");
  const raw = (await searchParams).q;
  const q = typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 100) : undefined;
  const items = listCustomers(q);
  return (
    <AppShell user={user} title="Customers" subtitle="Spent = captured payments minus refunds that succeeded.">
      <Card flush>
        <form className="toolbar" method="get">
          <label className="field grow">
            <span>Search</span>
            <input type="search" name="q" defaultValue={q ?? ""} placeholder="Customer id, name or email" />
          </label>
          <button type="submit">Search</button>
        </form>
        {items.length === 0 ? (
          <Empty>{q ? "No customers match." : "No customers yet. Run a sync from the dashboard."}</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Email</th>
                  <th className="num">Orders</th>
                  <th className="num">Spent</th>
                </tr>
              </thead>
              <tbody>
                {items.map((c) => (
                  <tr key={c.id}>
                    <td><Link href={`/customers/${c.id}`}><b>{c.name}</b></Link><small>{c.id}</small></td>
                    <td>{c.email}</td>
                    <td className="num">{c.orderCount}</td>
                    <td className="num">{formatMoney(c.spentMinor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>
    </AppShell>
  );
}
