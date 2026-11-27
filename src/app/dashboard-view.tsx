"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { formatIst, formatMoney } from "@/lib/format";
import type { Dashboard } from "@/server/services/dashboard";

const ORDER_STATUSES = ["processing", "shipped", "delivered", "cancelled"];

const OrderLink = ({ id }: { id: string | null }) => (id ? <Link href={`/orders/${id}`}>{id}</Link> : <>-</>);

export function DashboardView({ canOperate }: { canOperate: boolean }) {
  const router = useRouter();
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch("/api/dashboard", { signal: ctrl.signal })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        setError(null);
        setData(body);
      })
      .catch((e: Error) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => ctrl.abort();
  }, [version]);

  async function post(url: string, describe: (body: Record<string, unknown>) => { ok: boolean; text: string }) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(url, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      setMessage(res.ok ? describe(body) : { ok: false, text: body.error ?? `HTTP ${res.status}` });
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
      setVersion((v) => v + 1);
      router.refresh(); // header banners follow the new health
    }
  }

  const syncNow = () =>
    post("/api/sync", (b) => {
      const services = b.services as { service: string; status: string; error?: string }[];
      const failed = services.filter((s) => s.status === "failed");
      return failed.length
        ? { ok: false, text: `Sync finished with errors: ${failed.map((s) => `${s.service}: ${s.error}`).join("; ")}` }
        : { ok: true, text: "Sync finished: all services ok." };
    });
  const bulkRefunds = () =>
    post("/api/refund-requests/bulk", (b) => ({
      ok: true,
      text: `Refund requests created: ${b.created}, skipped: ${b.skipped}. Each needs Manager approval.`,
    }));

  if (error && !data) return <p className="error">Could not load the dashboard: {error}</p>;
  if (!data) return <p>Loading…</p>;
  const { owedRefunds, unpaidShipped } = data.moneyAtRisk;
  const owedOpen = owedRefunds.orders.filter((o) => !o.pendingApproval).length;

  return (
    <>
      {error && <p className="error">Refresh failed, showing earlier numbers: {error}</p>}
      {message && <p className={message.ok ? undefined : "error"}>{message.text}</p>}

      <section>
        <h2>Money at risk</h2>
        <h3>
          Owed refunds: {owedRefunds.count} cancelled orders, {formatMoney(owedRefunds.totalMinor)} captured and not refunded
        </h3>
        {owedRefunds.count === 0 ? (
          <p>None.</p>
        ) : (
          <p>
            {owedRefunds.orders.map((o, i) => (
              <span key={o.orderId}>
                {i > 0 && ", "}
                <OrderLink id={o.orderId} /> {formatMoney(o.amountMinor)}
                {o.pendingApproval && " (pending approval)"}
              </span>
            ))}
          </p>
        )}
        {canOperate && owedRefunds.count > 0 && (
          <button disabled={busy || owedOpen === 0} onClick={bulkRefunds}>
            Request full refunds ({owedOpen} without a request)
          </button>
        )}
        <h3>
          Unpaid: {unpaidShipped.count} shipped or delivered orders with a failed payment, {formatMoney(unpaidShipped.totalMinor)}
        </h3>
        {unpaidShipped.count === 0 ? (
          <p>None.</p>
        ) : (
          <p>
            {unpaidShipped.orders.map((o, i) => (
              <span key={o.orderId}>
                {i > 0 && ", "}
                <OrderLink id={o.orderId} /> ({o.status}) {formatMoney(o.amountMinor)}
              </span>
            ))}
            <br />
            <small>Fix: open a support ticket from the order page. They stay here until upstream shows them paid.</small>
          </p>
        )}
      </section>

      <section>
        <h2>Service health</h2>
        {canOperate && (
          <p>
            <button disabled={busy} onClick={syncNow}>
              {busy ? "Working…" : "Sync now"}
            </button>
          </p>
        )}
        <table>
          <thead>
            <tr>
              <th>Service</th>
              <th>Status</th>
              <th>Last sync</th>
              <th>Last OK</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            {data.health.map((h) => (
              <tr key={h.service}>
                <td>{h.service}</td>
                <td className={h.status === "down" ? "error" : undefined}>{h.status}</td>
                <td>
                  {formatIst(h.lastSyncAt)} {h.lastSyncStatus && `(${h.lastSyncStatus})`}
                </td>
                <td>{formatIst(h.lastOkAt)}</td>
                <td>{h.lastError ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>Orders: {data.orders.total}</h2>
        <p>
          {ORDER_STATUSES.map((s, i) => (
            <span key={s}>
              {i > 0 && " · "}
              <Link href={`/orders?orderStatus=${s}`}>{s}: {data.orders.byStatus[s] ?? 0}</Link>
            </span>
          ))}
        </p>
      </section>

      <section>
        <h2>Issues</h2>
        <ul>
          <li>
            <Link href="/orders?paymentStatus=failed">Failed payments: {data.paymentIssues.failedPayments}</Link>
          </li>
          <li>
            Failed refunds: {data.paymentIssues.failedRefunds.count}
            {data.paymentIssues.failedRefunds.items.map((r) => (
              <span key={r.id}>
                {" "}
                · <OrderLink id={r.orderId} /> {formatMoney(r.amountMinor)}: {r.error ?? "failed"}
              </span>
            ))}
          </li>
          <li>
            <Link href="/orders?shipmentStatus=delayed">Delayed shipments: {data.shipmentIssues.delayed}</Link>
          </li>
          <li>
            Shipment lookup errors: {data.shipmentIssues.lookupErrors.count}
            {data.shipmentIssues.lookupErrors.items.map((l) => (
              <span key={l.orderId}>
                {" "}
                · <OrderLink id={l.orderId} />: {l.error} ({formatIst(l.at)})
              </span>
            ))}
          </li>
        </ul>
      </section>

      <section>
        <h2>
          Pending approvals: {data.pendingApprovals.count} <Link href="/approvals">open queue</Link>
        </h2>
        {data.pendingApprovals.count === 0 ? (
          <p>None.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Order</th>
                <th>Amount</th>
                <th>Requested by</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {data.pendingApprovals.items.map((a) => (
                <tr key={a.id}>
                  <td>
                    <OrderLink id={a.orderId} />
                  </td>
                  <td>{formatMoney(a.amountMinor)}</td>
                  <td>{a.requestedByLabel}</td>
                  <td>{formatIst(a.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>
          <Link href="/orders?localAhead=true">Local ahead of upstream: {data.localAhead.length}</Link>
        </h2>
        {data.localAhead.length === 0 ? (
          <p>None: local data agrees with upstream.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Order</th>
                <th>Order: local / upstream</th>
                <th>Payment: local / upstream</th>
              </tr>
            </thead>
            <tbody>
              {data.localAhead.map((o) => (
                <tr key={o.id}>
                  <td>
                    <OrderLink id={o.id} />
                  </td>
                  <td>
                    {o.status} / {o.upstreamStatus ?? "-"}
                  </td>
                  <td>
                    {o.paymentStatus ?? "-"} / {o.paymentUpstreamStatus ?? "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>Last {data.recentExecutions.length} workflow executions</h2>
        {data.recentExecutions.length === 0 ? (
          <p>No workflow has run yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Workflow</th>
                <th>Order</th>
                <th>Event</th>
                <th>Outcome</th>
                <th>Result / error</th>
              </tr>
            </thead>
            <tbody>
              {data.recentExecutions.map((x) => (
                <tr key={x.id}>
                  <td>{formatIst(x.ranAt)}</td>
                  <td>{x.workflow}</td>
                  <td>
                    <OrderLink id={x.orderId} />
                  </td>
                  <td>{x.eventId}</td>
                  <td className={x.outcome === "failed" ? "error" : undefined}>{x.outcome}</td>
                  <td>
                    <small>{x.error ?? x.result ?? "-"}</small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>Last {data.recentOperations.length} operations</h2>
        {data.recentOperations.length === 0 ? (
          <p>No cancels or refunds yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Type</th>
                <th>Order</th>
                <th>Amount</th>
                <th>Outcome</th>
                <th>By</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {data.recentOperations.map((o) => (
                <tr key={o.id}>
                  <td>{formatIst(o.updatedAt)}</td>
                  <td>{o.type}</td>
                  <td>
                    <OrderLink id={o.orderId} />
                  </td>
                  <td>{formatMoney(o.amountMinor)}</td>
                  <td className={o.status === "failed" ? "error" : undefined}>{o.status}</td>
                  <td>{o.requestedByLabel}</td>
                  <td>{o.error ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>
          Last {data.recentAudit.length} audit entries <Link href="/audit">full log</Link>
        </h2>
        {data.recentAudit.length === 0 ? (
          <p>No audit entries yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>Role</th>
                <th>Action</th>
                <th>Target</th>
                <th>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {data.recentAudit.map((a) => (
                <tr key={a.id}>
                  <td>{formatIst(a.at)}</td>
                  <td>{a.actorLabel}</td>
                  <td>{a.role ?? "-"}</td>
                  <td>{a.action}</td>
                  <td>{a.target ?? "-"}</td>
                  <td>{a.outcome}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
