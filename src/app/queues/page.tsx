import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { formatIst, formatMoney } from "@/lib/format";
import { unpaidReason } from "@/lib/ticket-template";
import { getSessionUser } from "@/server/auth/require-role";
import { SESSION_COOKIE } from "@/server/auth/session";
import { getQueues, QUEUE_NAMES, type QueueName } from "@/server/services/queues";
import { AppShell } from "../app-header";
import { CreateTicketButton } from "../create-ticket-button";
import { Card, CustomerLink, Empty, TableWrap } from "../ui";

const TABS: Record<QueueName, { label: string; empty: string }> = {
  operations: { label: "Operations", empty: "No delayed shipments, lookup errors, local-ahead orders or failed syncs." },
  finance: { label: "Finance", empty: "No owed refunds, unpaid shipments, pending approvals or failed refunds." },
  support: { label: "Support", empty: "No open tickets and no customers affected by a problem." },
};

export default async function QueuesPage({ searchParams }: PageProps<"/queues">) {
  const user = await getSessionUser((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) redirect("/login");
  const raw = (await searchParams).tab;
  const tab: QueueName = (QUEUE_NAMES as readonly unknown[]).includes(raw) ? (raw as QueueName) : "operations";
  const queues = getQueues();
  const { items } = queues[tab];
  const canOperate = user.role !== "viewer";
  return (
    <AppShell user={user} title="Work queues" subtitle="What each team should act on next. Built from local data, so it works while a service is down.">
      <Card flush>
        <nav className="tabs" aria-label="Teams">
          {QUEUE_NAMES.map((q) => (
            <Link key={q} href={`/queues?tab=${q}`} aria-current={q === tab ? "page" : undefined}>
              {TABS[q].label} <span className="count">{queues[q].count}</span>
            </Link>
          ))}
        </nav>
        {items.length === 0 ? (
          <Empty>{TABS[tab].empty}</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Order</th>
                  <th>Customer</th>
                  <th className="num">Amount</th>
                  <th>Next action</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.key}>
                    <td>
                      <Link href={i.href}>{i.title}</Link>
                      {i.detail && <small>{i.detail}</small>}
                      {i.at && <small>{formatIst(i.at)}</small>}
                    </td>
                    <td>{i.orderId ? <Link href={`/orders/${i.orderId}`}>{i.orderId}</Link> : <span className="muted">-</span>}</td>
                    <td>
                      <CustomerLink id={i.customerId} name={i.customerName} />
                    </td>
                    <td className="num">{i.amountMinor === null ? <span className="muted">-</span> : formatMoney(i.amountMinor)}</td>
                    <td>
                      {i.canCreateTicket && canOperate && i.orderId ? (
                        <CreateTicketButton orderId={i.orderId} defaultReason={unpaidReason(i.orderId, i.amountMinor)} />
                      ) : (
                        <span className="next-action">{i.nextAction}</span>
                      )}
                    </td>
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
