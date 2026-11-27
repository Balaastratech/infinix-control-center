"use client";

import { useEffect, useState } from "react";
import { formatIst, formatMoney, parseRupees } from "@/lib/format";
import { statusLabel } from "@/lib/labels";
import { CreateTicketButton } from "../../../create-ticket-button";
import { Alert, Badge, Card, CustomerLink, Empty, Skeleton, SkeletonCard, TableWrap } from "../../../ui";

type Row = Record<string, string | number | boolean | null>;
interface Detail {
  order: Row & { id: string; status: string; upstreamStatus: string | null; amountMinor: number };
  customer: Row | null;
  payment: (Row & { status: string; upstreamStatus: string | null; amountMinor: number }) | null;
  refundPosition: { capturedMinor: number; refundedMinor: number; reservedMinor: number; refundableMinor: number };
  refunds: Row[];
  shipment: (Row & { status: string; updatedAt: string; syncedAt: string | null }) | null;
  shippingError: string | null;
  operations: Row[];
  tickets: Row[];
  events: Row[];
  actions: Record<"cancel" | "reconcile" | "refund" | "createTicket", { allowed: boolean; reason: string | null }>;
}
type Busy = "cancel" | "push" | "refund" | null;

// 137550 -> "1375.50" for the amount input (integer maths; the submitted text goes through parseRupees).
const toRupees = (paise: number) => `${Math.trunc(paise / 100)}.${String(paise % 100).padStart(2, "0")}`;

export function OrderDetail({ id, canOperate }: { id: string; canOperate: boolean }) {
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [amount, setAmount] = useState("");
  const [amountError, setAmountError] = useState<string | null>(null);
  const [version, setVersion] = useState(0); // bump to reload after an action

  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`/api/orders/${encodeURIComponent(id)}`, { signal: ctrl.signal })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        setError(null);
        setData(body);
        setAmount(body.refundPosition.refundableMinor > 0 ? toRupees(body.refundPosition.refundableMinor) : "");
      })
      .catch((e: Error) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => ctrl.abort();
  }, [id, version]);

  async function act(kind: Busy, path: string, body: unknown, success: (b: Record<string, unknown>) => string) {
    setBusy(kind);
    setMessage(null);
    try {
      const res = await fetch(`/api/orders/${encodeURIComponent(id)}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const b = await res.json().catch(() => ({}));
      setMessage(res.ok ? { ok: true, text: success(b) } : { ok: false, text: b.error ?? `HTTP ${res.status}` });
      setVersion((v) => v + 1);
    } catch {
      setMessage({ ok: false, text: "Network error, try again" });
    } finally {
      setBusy(null);
    }
  }

  function cancel() {
    if (!confirm(`Cancel order ${id} through the Commerce API?`)) return;
    void act("cancel", "cancel", {}, () => "Order cancelled.");
  }

  function pushCancel() {
    if (!confirm(`Send the cancel for ${id} to the Commerce API so it agrees with us?`)) return;
    void act("push", "reconcile-cancel", {}, () => "Commerce API now shows the order cancelled.");
  }

  function requestRefund(e: React.FormEvent) {
    e.preventDefault();
    const paise = parseRupees(amount);
    if (paise === null) return setAmountError("Enter an amount above ₹0 with at most 2 decimals.");
    if (data && paise > data.refundPosition.refundableMinor) return setAmountError(`At most ${formatMoney(data.refundPosition.refundableMinor)}.`);
    setAmountError(null);
    void act("refund", "refund-requests", { amount_minor: paise }, (b) => `Refund of ${formatMoney(b.amountMinor as number)} sent for Manager approval.`);
  }

  if (error && !data) return <Alert tone="bad">Could not load order: {error}</Alert>;
  if (!data) return <OrderSkeleton />;
  const { order, customer, payment, refundPosition: rp, shipment } = data;
  const orderAhead = order.upstreamStatus !== null && order.status !== order.upstreamStatus;
  const paymentAhead = payment !== null && payment.upstreamStatus !== null && payment.status !== payment.upstreamStatus;

  return (
    <>
      {message && <Alert tone={message.ok ? "ok" : "bad"}>{message.text}</Alert>}
      {(orderAhead || paymentAhead) && (
        <Alert tone="warn">
          Local ahead of upstream:{" "}
          {orderAhead && `order is ${order.status} here, ${order.upstreamStatus} in the Commerce API`}
          {orderAhead && paymentAhead && "; "}
          {paymentAhead && `payment is ${payment.status} here, ${payment.upstreamStatus} in the Payment API`}.
        </Alert>
      )}

      <div className="grid-3">
        <Card title={<>Order <Badge status={order.status} /></>}>
          <dl className="facts">
            <dt>Amount</dt>
            <dd className="num">{formatMoney(order.amountMinor)}</dd>
            {orderAhead && (
              <>
                <dt>Upstream</dt>
                <dd>
                  <Badge status={order.upstreamStatus} />
                </dd>
              </>
            )}
            <dt>Customer</dt>
            <dd>
              {customer ? (
                <>
                  <CustomerLink id={customer.id as string} name={customer.name as string} />
                  <br />
                  <span className="muted">{customer.email}</span>
                </>
              ) : (
                "unknown"
              )}
            </dd>
            <dt>Channel</dt>
            <dd>{order.channel ?? "-"}</dd>
            <dt>Created</dt>
            <dd>{formatIst(order.createdAt as string)}</dd>
          </dl>
        </Card>

        <Card title={<>Payment {payment && <Badge status={payment.status} />}</>}>
          {payment ? (
            <dl className="facts">
              <dt>Payment</dt>
              <dd className="mono">{payment.id}</dd>
              {paymentAhead && (
                <>
                  <dt>Upstream</dt>
                  <dd>
                    <Badge status={payment.upstreamStatus} />
                  </dd>
                </>
              )}
              <dt>Amount</dt>
              <dd className="num">{formatMoney(payment.amountMinor)}</dd>
              <dt>Refunded</dt>
              <dd className="num">{formatMoney(rp.refundedMinor)}</dd>
              <dt>In open requests</dt>
              <dd className="num">{formatMoney(rp.reservedMinor)}</dd>
              {data.actions.refund.allowed ? (
                <>
                  <dt>Refundable now</dt>
                  <dd className="num">
                    <b>{formatMoney(rp.refundableMinor)}</b>
                  </dd>
                </>
              ) : (
                <>
                  <dt className="muted">Refundable once eligible</dt>
                  <dd className="num muted">{formatMoney(rp.refundableMinor)}</dd>
                </>
              )}
            </dl>
          ) : (
            <p className="muted">No payment on record.</p>
          )}
        </Card>

        <Card title={<>Shipment {shipment && <Badge status={shipment.status} />}</>}>
          {data.shippingError && <p className="error small">{data.shippingError}</p>}
          {shipment ? (
            <dl className="facts">
              <dt>Shipment</dt>
              <dd className="mono">{shipment.id}</dd>
              <dt>Updated</dt>
              <dd>{formatIst(shipment.updatedAt)}</dd>
              <dt>Synced</dt>
              <dd>{formatIst(shipment.syncedAt)}</dd>
            </dl>
          ) : (
            <p className="muted">No shipment on record.</p>
          )}
        </Card>
      </div>

      {canOperate ? (
        <Actions data={data} orderAhead={orderAhead} busy={busy} onCancel={cancel} onPush={pushCancel}>
          <RefundAction
            data={data}
            busy={busy}
            amount={amount}
            amountError={amountError}
            onAmount={(v) => {
              setAmount(v);
              setAmountError(null);
            }}
            onSubmit={requestRefund}
          />
          <div className="action">
            <div className="action-text">
              <h3>Create support ticket</h3>
              <p>Opens a ticket in the Commerce API for the support team. A reason is required.</p>
            </div>
            {data.actions.createTicket.allowed ? (
              <CreateTicketButton orderId={id} label="Create support ticket" onDone={() => setVersion((v) => v + 1)} />
            ) : (
              <span className="blocked">Can&apos;t create a ticket: {data.actions.createTicket.reason}.</span>
            )}
          </div>
        </Actions>
      ) : (
        <Alert tone="warn">Read only: your role (viewer) can see this order but cannot cancel it, request refunds or create tickets.</Alert>
      )}

      <DataTable
        title="Refunds"
        rows={data.refunds}
        cols={[
          ["id", "Refund"],
          ["amountMinor", "Amount"],
          ["status", "Status"],
          ["createdAt", "Created"],
        ]}
        empty="No refunds."
      />
      <DataTable
        title="Operations"
        rows={data.operations}
        cols={[
          ["type", "Type"],
          ["amountMinor", "Amount"],
          ["status", "Status"],
          ["error", "Error"],
          ["requestedByLabel", "Requested by"],
          ["createdAt", "Created"],
        ]}
        empty="No cancels or refunds yet."
      />
      <div className="grid-2">
        <DataTable
          title="Tickets"
          rows={data.tickets}
          cols={[
            ["id", "Ticket"],
            ["reason", "Reason"],
            ["status", "Status"],
            ["createdAt", "Created"],
          ]}
          empty="No support tickets."
        />
        <DataTable
          title="Events"
          rows={data.events}
          cols={[
            ["type", "Type"],
            ["status", "Status"],
            ["source", "Source"],
            ["occurredAt", "Occurred"],
          ]}
          empty="No webhook events for this order."
        />
      </div>
    </>
  );
}

// Renders the server's allowed actions (GET /api/orders/[id] -> actions); no rule logic here.
function Actions(props: { data: Detail; orderAhead: boolean; busy: Busy; onCancel: () => void; onPush: () => void; children: React.ReactNode }) {
  const { data, orderAhead, busy, onCancel, onPush, children } = props;
  const { cancel, reconcile } = data.actions;
  return (
    <Card title="Actions" flush>
      <div className="actions">
        <div className="action">
          <div className="action-text">
            <h3>Cancel order</h3>
            <p>Cancels through the Commerce API right away. No approval needed.</p>
          </div>
          {cancel.allowed ? (
            <button className="danger" onClick={onCancel} disabled={busy !== null} aria-busy={busy === "cancel"}>
              {busy === "cancel" ? "Cancelling…" : "Cancel order"}
            </button>
          ) : (
            <span className="blocked">Can&apos;t cancel: {cancel.reason}.</span>
          )}
        </div>
        {(reconcile.allowed || orderAhead) && (
          <div className="action">
            <div className="action-text">
              <h3>Push cancel upstream</h3>
              <p>Cancelled here by a webhook, but the Commerce API still says processing. A refund is refused on approval until it agrees.</p>
            </div>
            {reconcile.allowed ? (
              <button className="primary" onClick={onPush} disabled={busy !== null} aria-busy={busy === "push"}>
                {busy === "push" ? "Pushing…" : "Push cancel upstream"}
              </button>
            ) : (
              <span className="blocked">Can&apos;t push: {reconcile.reason}.</span>
            )}
          </div>
        )}
        {children}
      </div>
    </Card>
  );
}

function RefundAction(props: {
  data: Detail;
  busy: Busy;
  amount: string;
  amountError: string | null;
  onAmount: (v: string) => void;
  onSubmit: (e: React.FormEvent) => void;
}) {
  const { data, busy, amount, amountError, onAmount, onSubmit } = props;
  const { refund, reconcile } = data.actions;
  return (
    <div className="action">
      <div className="action-text">
        <h3>Request refund</h3>
        <p>
          {refund.allowed && `Up to ${formatMoney(data.refundPosition.refundableMinor)}. `}A Manager approves it before the Payment API is called.
          {refund.allowed && reconcile.allowed && " Push the cancel upstream first, or the approval will be refused."}
        </p>
      </div>
      {!refund.allowed ? (
        <span className="blocked">Can&apos;t request a refund: {refund.reason}.</span>
      ) : (
        <form className="row" onSubmit={onSubmit} noValidate>
          <label className="money-input" aria-label="Refund amount in rupees">
            <span>₹</span>
            <input value={amount} onChange={(e) => onAmount(e.target.value)} inputMode="decimal" aria-invalid={amountError ? true : undefined} />
          </label>
          <button type="submit" className="primary" disabled={busy !== null} aria-busy={busy === "refund"}>
            {busy === "refund" ? "Requesting…" : "Request refund"}
          </button>
          {amountError && <span className="field-error">{amountError}</span>}
        </form>
      )}
    </div>
  );
}

function DataTable({ title, rows, cols, empty }: { title: string; rows: Row[]; cols: [string, string][]; empty: string }) {
  const cell = (col: string, v: Row[string]) => {
    if (v === null || v === undefined || v === "") return <span className="muted">-</span>;
    if (col === "amountMinor") return formatMoney(v as number);
    if (col === "status") return <Badge status={String(v)} />;
    if (col === "error") return <span className="error">{String(v)}</span>;
    if (col === "type") return statusLabel(String(v)); // "shipment.updated" -> "Shipment updated", "refund" -> "Refund"
    if (/At$/.test(col)) return <span className="nowrap">{formatIst(v as string)}</span>;
    return String(v);
  };
  return (
    <Card title={title} count={rows.length} flush>
      {rows.length === 0 ? (
        <Empty>{empty}</Empty>
      ) : (
        <TableWrap>
          <table className="compact">
            <thead>
              <tr>
                {cols.map(([c, label]) => (
                  <th key={c} className={c === "amountMinor" ? "num" : undefined}>
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={String(r.id ?? r.eventId ?? i)}>
                  {cols.map(([c]) => (
                    <td key={c} className={c === "amountMinor" ? "num" : undefined}>
                      {cell(c, r[c])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </Card>
  );
}

function OrderSkeleton() {
  return (
    <>
      <div className="grid-3">
        {[0, 1, 2].map((i) => (
          <section key={i} className="card" aria-busy="true" aria-label="Loading">
            <div className="card-head">
              <Skeleton h={14} w={110} />
            </div>
            <div className="card-body stack">
              <Skeleton h={12} w="80%" />
              <Skeleton h={12} w="65%" />
              <Skeleton h={12} w="72%" />
              <Skeleton h={12} w="50%" />
            </div>
          </section>
        ))}
      </div>
      <SkeletonCard rows={3} />
      <SkeletonCard rows={2} />
    </>
  );
}
