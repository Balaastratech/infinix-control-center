"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { formatIst, formatMoney } from "@/lib/format";
import type { Dashboard } from "@/server/services/dashboard";
import { Alert, Badge, Card, Empty, Skeleton, SkeletonCard, TableWrap } from "./ui";

const ORDER_STATUSES = ["processing", "shipped", "delivered", "cancelled"];
const SERVICE_NAMES: Record<string, string> = { commerce: "Commerce API", payments: "Payment API", shipping: "Shipping API" };

const OrderLink = ({ id }: { id: string | null }) => (id ? <Link href={`/orders/${id}`}>{id}</Link> : <>-</>);

export function DashboardView({ canOperate }: { canOperate: boolean }) {
  const router = useRouter();
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<"sync" | "bulk" | null>(null);
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

  async function post(kind: "sync" | "bulk", url: string, describe: (body: Record<string, unknown>) => { ok: boolean; text: string }) {
    setBusy(kind);
    setMessage(null);
    try {
      const res = await fetch(url, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      setMessage(res.ok ? describe(body) : { ok: false, text: body.error ?? `HTTP ${res.status}` });
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
      setVersion((v) => v + 1);
      router.refresh(); // header banners and the nav count follow
    }
  }

  const syncNow = () =>
    post("sync", "/api/sync", (b) => {
      const services = b.services as { service: string; status: string; error?: string }[];
      const failed = services.filter((s) => s.status === "failed");
      return failed.length
        ? { ok: false, text: `Sync finished with errors: ${failed.map((s) => `${s.service}: ${s.error}`).join("; ")}` }
        : { ok: true, text: "Sync finished: all services ok." };
    });
  const bulkRefunds = () =>
    post("bulk", "/api/refund-requests/bulk", (b) => ({
      ok: true,
      text: `Refund requests created: ${b.created}, skipped: ${b.skipped}. Each needs Manager approval.`,
    }));

  if (error && !data) return <Alert tone="bad">Could not load the dashboard: {error}</Alert>;
  if (!data) return <DashboardSkeleton />;

  const { owedRefunds, unpaidShipped } = data.moneyAtRisk;
  const owedOpen = owedRefunds.orders.filter((o) => !o.pendingApproval).length;
  const failedPayments = data.paymentIssues.failedPayments;
  const delayed = data.shipmentIssues.delayed;

  return (
    <>
      {error && <Alert tone="warn">Refresh failed, showing earlier numbers: {error}</Alert>}
      {message && <Alert tone={message.ok ? "ok" : "bad"}>{message.text}</Alert>}

      <section className="risk" aria-labelledby="risk-title">
        <div className="risk-head">
          <h2 id="risk-title">Money at risk</h2>
          <span className="risk-total">
            Total <b>{formatMoney(owedRefunds.totalMinor + unpaidShipped.totalMinor)}</b>
          </span>
        </div>
        <div className="risk-grid">
          <div className="risk-block">
            <span className="risk-label">Owed refunds</span>
            <span className="risk-amount">{formatMoney(owedRefunds.totalMinor)}</span>
            <span className="risk-sub">
              {owedRefunds.count} cancelled order{owedRefunds.count === 1 ? "" : "s"} with a captured payment and no refund
            </span>
            {owedRefunds.count > 0 && (
              <div className="chips">
                {owedRefunds.orders.map((o) => (
                  <Link key={o.orderId} href={`/orders/${o.orderId}`} className={`chip${o.pendingApproval ? " warn" : ""}`} title={o.pendingApproval ? "Refund request pending approval" : undefined}>
                    {o.orderId} <span className="chip-amt">{formatMoney(o.amountMinor)}</span>
                  </Link>
                ))}
              </div>
            )}
            {canOperate && owedRefunds.count > 0 && (
              <div className="row">
                <button className="primary" disabled={busy !== null || owedOpen === 0} aria-busy={busy === "bulk"} onClick={bulkRefunds}>
                  {busy === "bulk" ? "Requesting…" : `Request full refunds (${owedOpen})`}
                </button>
                <span className="muted small">
                  {owedOpen === 0 ? "Every owed order already has a request waiting for approval." : "One approval per order. Amber = already requested."}
                </span>
              </div>
            )}
          </div>
          <div className="risk-block warn">
            <span className="risk-label">Unpaid shipments</span>
            <span className="risk-amount">{formatMoney(unpaidShipped.totalMinor)}</span>
            <span className="risk-sub">
              {unpaidShipped.count} shipped or delivered order{unpaidShipped.count === 1 ? "" : "s"} with a failed payment
            </span>
            {unpaidShipped.count > 0 && (
              <div className="chips">
                {unpaidShipped.orders.map((o) => (
                  <Link key={o.orderId} href={`/orders/${o.orderId}`} className="chip">
                    {o.orderId} <span className="chip-amt">{formatMoney(o.amountMinor)}</span>
                  </Link>
                ))}
              </div>
            )}
            <span className="muted small">Fix: open a support ticket. They stay here until the Payment API shows them paid.</span>
          </div>
        </div>
      </section>

      <div className="kpis">
        <div className="kpi">
          <span className="kpi-label">Total orders</span>
          <Link href="/orders" className="kpi-value" style={{ color: "inherit" }}>
            {data.orders.total}
          </Link>
          <span className="kpi-foot">
            {ORDER_STATUSES.map((s, i) => (
              <span key={s}>
                {i > 0 && " · "}
                <Link href={`/orders?orderStatus=${s}`}>
                  {data.orders.byStatus[s] ?? 0} {s}
                </Link>
              </span>
            ))}
          </span>
        </div>
        <Link href="/orders?paymentStatus=failed" className={`kpi${failedPayments ? " bad" : ""}`}>
          <span className="kpi-label">Failed payments</span>
          <span className="kpi-value">{failedPayments}</span>
          <span className="kpi-foot">{data.paymentIssues.failedRefunds.count} failed refunds</span>
        </Link>
        <Link href="/orders?shipmentStatus=delayed" className={`kpi${delayed ? " warn" : ""}`}>
          <span className="kpi-label">Delayed shipments</span>
          <span className="kpi-value">{delayed}</span>
          <span className="kpi-foot">{data.shipmentIssues.lookupErrors.count} lookup errors</span>
        </Link>
        <Link href="/approvals" className={`kpi${data.pendingApprovals.count ? " warn" : ""}`}>
          <span className="kpi-label">Pending approvals</span>
          <span className="kpi-value">{data.pendingApprovals.count}</span>
          <span className="kpi-foot">refunds waiting for a Manager</span>
        </Link>
        <Link href="/orders?localAhead=true" className={`kpi${data.localAhead.length ? " warn" : ""}`}>
          <span className="kpi-label">Local ahead</span>
          <span className="kpi-value">{data.localAhead.length}</span>
          <span className="kpi-foot">webhook value not yet upstream</span>
        </Link>
      </div>

      <Card
        title="Service health"
        actions={
          canOperate && (
            <button className="primary sm" disabled={busy !== null} aria-busy={busy === "sync"} onClick={syncNow}>
              {busy === "sync" ? "Syncing…" : "Sync now"}
            </button>
          )
        }
      >
        <div className="health">
          {data.health.map((h) => (
            <div key={h.service} className={`service${h.status === "down" ? " down" : ""}`}>
              <span className="service-name">
                {SERVICE_NAMES[h.service] ?? h.service} <Badge status={h.status} />
              </span>
              <span className="small muted">
                Last sync {formatIst(h.lastSyncAt)} {h.lastSyncStatus && <Badge status={h.lastSyncStatus} />}
              </span>
              <span className="small muted">Last OK {formatIst(h.lastOkAt)}</span>
              {h.lastError && <span className="small error">{h.lastError}</span>}
            </div>
          ))}
        </div>
      </Card>

      <div className="grid-2">
        <Card title="Pending approvals" count={data.pendingApprovals.count} actions={<Link href="/approvals">Open queue →</Link>} flush>
          {data.pendingApprovals.count === 0 ? (
            <Empty>Nothing waiting for a Manager.</Empty>
          ) : (
            <TableWrap>
              <table className="compact">
                <thead>
                  <tr>
                    <th>Order</th>
                    <th className="num">Amount</th>
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
                      <td className="num">{formatMoney(a.amountMinor)}</td>
                      <td>{a.requestedByLabel}</td>
                      <td className="nowrap">{formatIst(a.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>

        <Card title="Issues" flush>
          <TableWrap>
            <table className="compact">
              <tbody>
                <tr>
                  <td>Failed refunds</td>
                  <td className="num">{data.paymentIssues.failedRefunds.count}</td>
                  <td>
                    {data.paymentIssues.failedRefunds.items.length === 0 && <span className="muted">None</span>}
                    {data.paymentIssues.failedRefunds.items.map((r) => (
                      <div key={r.id}>
                        <OrderLink id={r.orderId} /> {formatMoney(r.amountMinor)} <small className="error">{r.error ?? "failed"}</small>
                      </div>
                    ))}
                  </td>
                </tr>
                <tr>
                  <td>Shipment lookup errors</td>
                  <td className="num">{data.shipmentIssues.lookupErrors.count}</td>
                  <td>
                    {data.shipmentIssues.lookupErrors.items.length === 0 && <span className="muted">None</span>}
                    {data.shipmentIssues.lookupErrors.items.map((l) => (
                      <div key={l.orderId}>
                        <OrderLink id={l.orderId} /> <small className="error">{l.error}</small>
                        <small>{formatIst(l.at)}</small>
                      </div>
                    ))}
                  </td>
                </tr>
              </tbody>
            </table>
          </TableWrap>
        </Card>
      </div>

      <Card title="Local ahead of upstream" count={data.localAhead.length} actions={<Link href="/orders?localAhead=true">In orders →</Link>} flush>
        {data.localAhead.length === 0 ? (
          <Empty>Local data agrees with upstream.</Empty>
        ) : (
          <TableWrap>
            <table className="compact">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Order: local → upstream</th>
                  <th>Payment: local → upstream</th>
                </tr>
              </thead>
              <tbody>
                {data.localAhead.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <OrderLink id={o.id} />
                    </td>
                    <td>
                      <Badge status={o.status} /> → <Badge status={o.upstreamStatus} />
                    </td>
                    <td>
                      <Badge status={o.paymentStatus} /> → <Badge status={o.paymentUpstreamStatus} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      <Card title="Recent workflow executions" count={data.recentExecutions.length} actions={<Link href="/workflows">Workflows →</Link>} flush>
        {data.recentExecutions.length === 0 ? (
          <Empty>No workflow has run yet.</Empty>
        ) : (
          <TableWrap>
            <table className="compact">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Workflow</th>
                  <th>Order</th>
                  <th>Outcome</th>
                  <th>Result / error</th>
                </tr>
              </thead>
              <tbody>
                {data.recentExecutions.map((x) => (
                  <tr key={x.id}>
                    <td className="nowrap">{formatIst(x.ranAt)}</td>
                    <td>
                      {x.workflow}
                      <small className="mono">{x.eventId}</small>
                    </td>
                    <td>
                      <OrderLink id={x.orderId} />
                    </td>
                    <td>
                      <Badge status={x.outcome} />
                    </td>
                    <td className={x.outcome === "failed" ? "error" : undefined}>
                      <small>{x.error ?? x.result ?? "-"}</small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      <div className="grid-2">
        <Card title="Recent operations" count={data.recentOperations.length} flush>
          {data.recentOperations.length === 0 ? (
            <Empty>No cancels or refunds yet.</Empty>
          ) : (
            <TableWrap>
              <table className="compact">
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Type</th>
                    <th className="num">Amount</th>
                    <th>Status</th>
                    <th>By</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentOperations.map((o) => (
                    <tr key={o.id}>
                      <td>
                        <OrderLink id={o.orderId} />
                        <small>{formatIst(o.updatedAt)}</small>
                      </td>
                      <td>{o.type}</td>
                      <td className="num">{o.amountMinor === null ? "-" : formatMoney(o.amountMinor)}</td>
                      <td>
                        <Badge status={o.status} />
                        {o.error && <small className="error">{o.error}</small>}
                      </td>
                      <td>{o.requestedByLabel}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>

        <Card title="Recent audit entries" count={data.recentAudit.length} actions={<Link href="/audit">Full log →</Link>} flush>
          {data.recentAudit.length === 0 ? (
            <Empty>No audit entries yet.</Empty>
          ) : (
            <TableWrap>
              <table className="compact">
                <thead>
                  <tr>
                    <th>Who</th>
                    <th>Action</th>
                    <th>Target</th>
                    <th>Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentAudit.map((a) => (
                    <tr key={a.id}>
                      <td>
                        {a.actorLabel}
                        <small>
                          {a.role ?? "no role"} · {formatIst(a.at)}
                        </small>
                      </td>
                      <td className="mono">{a.action}</td>
                      <td>{a.target ?? "-"}</td>
                      <td>
                        <Badge status={a.outcome} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>
      </div>
    </>
  );
}

function DashboardSkeleton() {
  return (
    <>
      <section className="risk" aria-busy="true" aria-label="Loading">
        <div className="risk-grid">
          {[0, 1].map((i) => (
            <div key={i} className="risk-block stack">
              <Skeleton h={14} w={120} />
              <Skeleton h={34} w={200} />
              <Skeleton h={14} w="70%" />
            </div>
          ))}
        </div>
      </section>
      <div className="kpis">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="kpi">
            <Skeleton h={12} w={90} />
            <Skeleton h={28} w={60} />
          </div>
        ))}
      </div>
      <SkeletonCard rows={3} />
    </>
  );
}
