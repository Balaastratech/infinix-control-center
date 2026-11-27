import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { formatIst } from "@/lib/format";
import { getSessionUser } from "@/server/auth/require-role";
import { SESSION_COOKIE } from "@/server/auth/session";
import { listTickets } from "@/server/services/tickets";
import { AppShell } from "../app-header";
import { Badge, Card, CustomerLink, Empty, TableWrap } from "../ui";

const pick = (v: string | string[] | undefined) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 64) : undefined);

// Local copy of Commerce tickets (sync + created here). Filters live in the URL; plain GET form, no client JS.
export default async function TicketsPage({ searchParams }: PageProps<"/tickets">) {
  const user = await getSessionUser((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) redirect("/login");
  const sp = await searchParams;
  const status = pick(sp.status);
  const orderId = pick(sp.orderId);
  const { items, statuses } = listTickets({ status, orderId });
  return (
    <AppShell
      user={user}
      title="Support tickets"
      subtitle={user.role === "viewer" ? "Read only. Operators and Managers create tickets from an order or a work queue." : "Create a ticket from an order page, the dashboard or the Finance queue."}
    >
      <Card flush>
        <form className="toolbar" method="get">
          <label className="field">
            <span>Status</span>
            <select name="status" defaultValue={status ?? ""}>
              <option value="">All</option>
              {statuses.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Order</span>
            <input name="orderId" defaultValue={orderId ?? ""} placeholder="NC-1021" />
          </label>
          <button type="submit">Filter</button>
          {(status || orderId) && <Link href="/tickets" className="link-button">Clear</Link>}
        </form>
        {items.length === 0 ? (
          <Empty>{status || orderId ? "No tickets match these filters." : "No support tickets yet."}</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Ticket</th>
                  <th>Order</th>
                  <th>Customer</th>
                  <th>Reason</th>
                  <th>Status</th>
                  <th>Created by</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {items.map((t) => (
                  <tr key={t.id}>
                    <td className="mono">{t.id}</td>
                    <td><Link href={`/orders/${t.orderId}`}>{t.orderId}</Link></td>
                    <td><CustomerLink id={t.customerId} name={t.customerName} /></td>
                    <td>{t.reason}{t.missingUpstream && <small>no longer listed by the Commerce API</small>}</td>
                    <td><Badge status={t.status} /></td>
                    <td>{t.createdByLabel ?? <span className="muted">synced</span>}</td>
                    <td className="nowrap">{formatIst(t.createdAt)}</td>
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
