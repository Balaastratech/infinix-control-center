import { cookies } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { formatIst, formatMoney } from "@/lib/format";
import { statusLabel } from "@/lib/labels";
import { getSessionUser } from "@/server/auth/require-role";
import { SESSION_COOKIE } from "@/server/auth/session";
import { isValidId } from "@/server/clients/mock";
import { getCustomerDetail } from "@/server/services/customers";
import { AppShell } from "../../../app-header";
import { Badge, Card, Empty, TableWrap } from "../../../ui";

const OrderLink = ({ id }: { id: string }) => <Link href={`/orders/${id}`}>{id}</Link>;

export default async function CustomerPage({ params }: PageProps<"/customers/[id]">) {
  const user = await getSessionUser((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) redirect("/login");
  const { id } = await params;
  const d = isValidId(id) ? getCustomerDetail(id) : null;
  if (!d) notFound();
  const { customer, moneyAtRisk: risk } = d;
  return (
    <AppShell
      user={user}
      title={customer.name}
      subtitle={`${customer.id} · ${customer.email}`}
      crumb={
        <Link className="crumb" href="/customers">
          ← All customers
        </Link>
      }
    >
      <div className="kpis">
        <div className="kpi">
          <span className="kpi-label">Orders</span>
          <span className="kpi-value">{d.orders.length}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Spent (net of refunds)</span>
          <span className="kpi-value">{formatMoney(d.spentMinor)}</span>
        </div>
        <div className={`kpi${risk.totalMinor > 0 ? " bad" : ""}`}>
          <span className="kpi-label">Money at risk</span>
          <span className="kpi-value">{formatMoney(risk.totalMinor)}</span>
          <span className="kpi-foot">
            owed refunds {formatMoney(risk.owedMinor)} · unpaid {formatMoney(risk.unpaidMinor)}
          </span>
        </div>
        <div className={`kpi${d.openTickets.length > 0 ? " warn" : ""}`}>
          <span className="kpi-label">Open tickets</span>
          <span className="kpi-value">{d.openTickets.length}</span>
        </div>
      </div>

      {(risk.owed.length > 0 || risk.unpaid.length > 0) && (
        <Card title="Money at risk" count={risk.owed.length + risk.unpaid.length}>
          <div className="chips">
            {risk.owed.map((o) => (
              <Link key={o.orderId} href={`/orders/${o.orderId}`} className={`chip${o.pendingApproval ? " warn" : ""}`} title={o.pendingApproval ? "Refund requested, waiting for approval" : "Refund owed"}>
                {o.orderId} refund owed <span className="chip-amt">{formatMoney(o.amountMinor)}</span>
              </Link>
            ))}
            {risk.unpaid.map((o) => (
              <Link key={o.orderId} href={`/orders/${o.orderId}`} className="chip" title="Shipped or delivered, payment failed">
                {o.orderId} unpaid <span className="chip-amt">{formatMoney(o.amountMinor)}</span>
              </Link>
            ))}
          </div>
        </Card>
      )}

      <Card title="Orders" count={d.orders.length} flush>
        {d.orders.length === 0 ? (
          <Empty>No orders.</Empty>
        ) : (
          <TableWrap>
            <table className="compact">
              <thead>
                <tr>
                  <th>Order</th>
                  <th className="num">Amount</th>
                  <th>Order</th>
                  <th>Payment</th>
                  <th>Shipment</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {d.orders.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <OrderLink id={o.id} />
                    </td>
                    <td className="num">{formatMoney(o.amountMinor)}</td>
                    <td>
                      <Badge status={o.status} />
                      {o.localAhead && <span className="badge-sub">local ahead</span>}
                    </td>
                    <td>
                      <Badge status={o.paymentStatus} />
                    </td>
                    <td>
                      <Badge status={o.shipmentStatus} />
                    </td>
                    <td className="nowrap">{formatIst(o.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      <div className="grid-2">
        <Card title="Open tickets" count={d.openTickets.length} flush>
          {d.openTickets.length === 0 ? (
            <Empty>No open tickets.</Empty>
          ) : (
            <TableWrap>
              <table className="compact">
                <thead>
                  <tr>
                    <th>Ticket</th>
                    <th>Order</th>
                    <th>Reason</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {d.openTickets.map((t) => (
                    <tr key={t.id}>
                      <td className="mono">{t.id}</td>
                      <td>
                        <OrderLink id={t.orderId} />
                      </td>
                      <td>{t.reason}</td>
                      <td className="nowrap">{formatIst(t.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>
        <Card title="Recent operations" count={d.recentOperations.length} flush>
          {d.recentOperations.length === 0 ? (
            <Empty>No cancels or refunds yet.</Empty>
          ) : (
            <TableWrap>
              <table className="compact">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Order</th>
                    <th className="num">Amount</th>
                    <th>Status</th>
                    <th>By</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {d.recentOperations.map((op) => (
                    <tr key={op.id}>
                      <td>{statusLabel(op.type)}</td>
                      <td>
                        <OrderLink id={op.orderId} />
                      </td>
                      <td className="num">{formatMoney(op.amountMinor)}</td>
                      <td>
                        <Badge status={op.status} />
                        {op.error && <small className="error">{op.error}</small>}
                      </td>
                      <td>{op.requestedByLabel}</td>
                      <td className="nowrap">{formatIst(op.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>
      </div>
    </AppShell>
  );
}
