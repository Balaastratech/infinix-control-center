"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatIst, formatMoney } from "@/lib/format";

interface Item {
  id: number;
  status: string;
  orderId: string;
  amountMinor: number;
  requestedByLabel: string;
  requestedByUserId: number | null;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  note: string | null;
  operationStatus: string;
  error: string | null;
  externalId: string | null;
}

const RETRYABLE = ["approved", "failed"];
const OWN_HINT = "You cannot decide your own request";

export function ApprovalsQueue({ isManager, userId }: { isManager: boolean; userId: number }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch("/api/approvals", { signal: ctrl.signal })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        setError(null);
        setItems(body.items);
      })
      .catch((e: Error) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => ctrl.abort();
  }, [version]);

  async function act(id: number, action: "approve" | "reject" | "retry", body?: unknown) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/approvals/${id}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) setMessage({ ok: false, text: b.error ?? `HTTP ${res.status}` });
      else if (b.status === "failed") setMessage({ ok: false, text: `Refund failed: ${b.error}` });
      else if (b.status === "approved") setMessage({ ok: false, text: `Approved but not sent: ${b.error}` });
      else setMessage({ ok: true, text: action === "reject" ? "Rejected." : `Refund ${b.externalId ?? ""} succeeded.` });
      setVersion((v) => v + 1);
    } catch {
      setMessage({ ok: false, text: "Network error, try again" });
    } finally {
      setBusy(false);
    }
  }

  function reject(id: number) {
    const note = prompt("Reason for rejecting (required):")?.trim();
    if (note) void act(id, "reject", { note });
  }

  if (error) return <p className="error">Could not load approvals: {error}</p>;
  if (!items) return <p>Loading…</p>;
  if (items.length === 0) return <p>No refund requests yet.</p>;

  return (
    <>
      {message && <p className={message.ok ? undefined : "error"}>{message.text}</p>}
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Order</th>
            <th>Amount</th>
            <th>Requested by</th>
            <th>Approval</th>
            <th>Refund</th>
            <th>Decision</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {items.map((a) => {
            const own = a.requestedByUserId === userId;
            return (
              <tr key={a.id}>
                <td>{a.id}</td>
                <td>
                  <Link href={`/orders/${a.orderId}`}>{a.orderId}</Link>
                </td>
                <td>{formatMoney(a.amountMinor)}</td>
                <td>
                  {a.requestedByLabel}
                  <br />
                  <small>{formatIst(a.createdAt)}</small>
                </td>
                <td>{a.status}</td>
                <td>
                  {a.status === "approved" ? a.operationStatus : "-"}
                  {a.externalId && <small> ({a.externalId})</small>}
                  {a.error && <div className="error">{a.error}</div>}
                </td>
                <td>
                  {a.decidedBy ? `${a.decidedBy}, ${formatIst(a.decidedAt)}` : "-"}
                  {a.note && <div>Note: {a.note}</div>}
                </td>
                <td>
                  {isManager && a.status === "pending" && (
                    <>
                      <button onClick={() => act(a.id, "approve")} disabled={busy || own} title={own ? OWN_HINT : undefined}>
                        Approve
                      </button>{" "}
                      <button onClick={() => reject(a.id)} disabled={busy || own} title={own ? OWN_HINT : undefined}>
                        Reject
                      </button>
                    </>
                  )}
                  {isManager && a.status === "approved" && RETRYABLE.includes(a.operationStatus) && (
                    <button onClick={() => act(a.id, "retry")} disabled={busy}>
                      Retry
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}
