"use client";

import { useEffect, useState } from "react";
import { formatIst, formatMoney, parseRupees } from "@/lib/format";

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
}

// 137550 -> "1375.50" for the amount input (integer maths; the submitted text goes through parseRupees).
const toRupees = (paise: number) => `${Math.trunc(paise / 100)}.${String(paise % 100).padStart(2, "0")}`;

export function OrderDetail({ id, canOperate }: { id: string; canOperate: boolean }) {
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [amount, setAmount] = useState("");

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

  async function act(path: string, body: unknown, success: (b: Record<string, unknown>) => string) {
    setBusy(true);
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
      setBusy(false);
    }
  }

  function cancel() {
    if (!confirm(`Cancel order ${id} through the Commerce API?`)) return;
    void act("cancel", {}, () => "Order cancelled.");
  }

  function requestRefund(e: React.FormEvent) {
    e.preventDefault();
    const paise = parseRupees(amount);
    if (paise === null) return setMessage({ ok: false, text: "Enter an amount above 0 with at most 2 decimals." });
    void act("refund-requests", { amount_minor: paise }, (b) => `Refund of ${formatMoney(b.amountMinor as number)} sent for Manager approval.`);
  }

  if (error) return <p className="error">Could not load order: {error}</p>;
  if (!data) return <p>Loading…</p>;
  const { order, customer, payment, refundPosition: rp, shipment } = data;

  return (
    <>
      {message && <p className={message.ok ? undefined : "error"}>{message.text}</p>}

      <h2>Order</h2>
      <p>
        Status: <b>{order.status}</b>
        {order.status !== order.upstreamStatus && <> (local ahead; Commerce API says {order.upstreamStatus})</>} · Amount{" "}
        {formatMoney(order.amountMinor)} · Created {formatIst(order.createdAt as string)} · Channel {order.channel ?? "-"}
      </p>
      <p>Customer: {customer ? `${customer.name} (${customer.email})` : "unknown"}</p>

      <h2>Payment</h2>
      {payment ? (
        <p>
          {payment.id}: <b>{payment.status}</b>
          {payment.status !== payment.upstreamStatus && <> (local ahead; Payment API says {payment.upstreamStatus})</>} ·{" "}
          {formatMoney(payment.amountMinor)} · Refunded {formatMoney(rp.refundedMinor)} · In open requests {formatMoney(rp.reservedMinor)} ·
          Refundable now {formatMoney(rp.refundableMinor)}
        </p>
      ) : (
        <p>No payment.</p>
      )}

      <h2>Shipment</h2>
      {data.shippingError && <p className="error">{data.shippingError}</p>}
      {shipment ? (
        <p>
          {shipment.id}: <b>{shipment.status}</b> · updated {formatIst(shipment.updatedAt)}
        </p>
      ) : (
        <p>No shipment.</p>
      )}

      {canOperate && (
        <>
          <h2>Actions</h2>
          <p>
            <button onClick={cancel} disabled={busy}>
              Cancel order
            </button>
          </p>
          <form onSubmit={requestRefund}>
            <label>
              Refund amount ₹ <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" size={12} />
            </label>{" "}
            <button type="submit" disabled={busy}>
              Request refund
            </button>{" "}
            <small>Needs Manager approval before the Payment API is called.</small>
          </form>
        </>
      )}

      <Table title="Refunds" rows={data.refunds} cols={["id", "amountMinor", "status", "createdAt"]} />
      <Table title="Operations" rows={data.operations} cols={["id", "type", "amountMinor", "status", "error", "requestedByLabel", "createdAt"]} />
      <Table title="Tickets" rows={data.tickets} cols={["id", "reason", "status", "createdAt"]} />
      <Table title="Events" rows={data.events} cols={["eventId", "source", "type", "status", "note", "occurredAt"]} />
    </>
  );
}

function Table({ title, rows, cols }: { title: string; rows: Row[]; cols: string[] }) {
  const cell = (col: string, v: Row[string]) =>
    v === null || v === undefined ? "-" : col === "amountMinor" ? formatMoney(v as number) : /At$/.test(col) ? formatIst(v as string) : String(v);
  return (
    <>
      <h2>{title}</h2>
      {rows.length === 0 ? (
        <p>None.</p>
      ) : (
        <table>
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {cols.map((c) => (
                  <td key={c}>{cell(c, r[c])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
