"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatIst, formatMoney } from "@/lib/format";
import { Alert, Badge, Empty, SkeletonCard, TableWrap } from "../ui";

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
type Action = "approve" | "reject" | "retry";

const RETRYABLE = ["approved", "failed"];
const OWN_HINT = "You cannot decide your own request";

export function ApprovalsQueue({ isManager, userId }: { isManager: boolean; userId: number }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<{ id: number; action: Action } | null>(null);
  const [rejecting, setRejecting] = useState<{ id: number; note: string; error?: string } | null>(null);
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

  async function act(id: number, action: Action, body?: unknown) {
    setBusy({ id, action });
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
      if (res.ok && action === "reject") setRejecting(null);
      setVersion((v) => v + 1);
    } catch {
      setMessage({ ok: false, text: "Network error, try again" });
    } finally {
      setBusy(null);
    }
  }

  function submitReject(e: React.FormEvent) {
    e.preventDefault();
    if (!rejecting) return;
    const note = rejecting.note.trim();
    if (!note) return setRejecting({ ...rejecting, error: "A reason is required." });
    void act(rejecting.id, "reject", { note });
  }

  if (error && !items) return <Alert tone="bad">Could not load approvals: {error}</Alert>;
  if (!items) return <SkeletonCard rows={5} />;

  const pending = items.filter((a) => a.status === "pending").length;
  const isBusy = (id: number, action: Action) => busy?.id === id && busy.action === action;

  return (
    <>
      {message && <Alert tone={message.ok ? "ok" : "bad"}>{message.text}</Alert>}
      <section className="card">
        <div className="card-head">
          <h2>
            Refund requests <span className="count">{pending} pending</span>
          </h2>
          {!isManager && <span className="muted small">Only Managers can approve or reject.</span>}
        </div>
        {items.length === 0 ? (
          <Empty>No refund requests yet.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Order</th>
                  <th className="num">Amount</th>
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
                      <td className="muted tabular">{a.id}</td>
                      <td>
                        <Link href={`/orders/${a.orderId}`}>
                          <b>{a.orderId}</b>
                        </Link>
                      </td>
                      <td className="num">{formatMoney(a.amountMinor)}</td>
                      <td>
                        {a.requestedByLabel}
                        <small>{formatIst(a.createdAt)}</small>
                      </td>
                      <td>
                        <Badge status={a.status} />
                      </td>
                      <td>
                        {a.status === "approved" ? <Badge status={a.operationStatus === "approved" ? "unsent" : a.operationStatus} /> : <span className="muted">-</span>}
                        {a.externalId && <small className="mono">{a.externalId}</small>}
                        {a.error && <small className="error">{a.error}</small>}
                      </td>
                      <td>
                        {a.decidedBy ? (
                          <>
                            {a.decidedBy}
                            <small>{formatIst(a.decidedAt)}</small>
                          </>
                        ) : (
                          <span className="muted">-</span>
                        )}
                        {a.note && <small>Note: {a.note}</small>}
                      </td>
                      <td>
                        {isManager && a.status === "pending" && rejecting?.id !== a.id && (
                          <span className="row">
                            <button className="primary sm" onClick={() => act(a.id, "approve")} disabled={busy !== null || own} aria-busy={isBusy(a.id, "approve")} title={own ? OWN_HINT : undefined}>
                              {isBusy(a.id, "approve") ? "Approving…" : "Approve"}
                            </button>
                            <button className="sm" onClick={() => setRejecting({ id: a.id, note: "" })} disabled={busy !== null || own} title={own ? OWN_HINT : undefined}>
                              Reject
                            </button>
                          </span>
                        )}
                        {isManager && a.status === "pending" && own && <small>{OWN_HINT}.</small>}
                        {isManager && rejecting?.id === a.id && (
                          <form className="stack" onSubmit={submitReject}>
                            <input
                              autoFocus
                              placeholder="Reason (required)"
                              value={rejecting.note}
                              maxLength={500}
                              aria-invalid={rejecting.error ? true : undefined}
                              onChange={(e) => setRejecting({ id: a.id, note: e.target.value })}
                            />
                            {rejecting.error && <span className="field-error">{rejecting.error}</span>}
                            <span className="row">
                              <button type="submit" className="danger sm" disabled={busy !== null} aria-busy={isBusy(a.id, "reject")}>
                                {isBusy(a.id, "reject") ? "Rejecting…" : "Reject"}
                              </button>
                              <button type="button" className="ghost sm" onClick={() => setRejecting(null)}>
                                Keep
                              </button>
                            </span>
                          </form>
                        )}
                        {isManager && a.status === "approved" && RETRYABLE.includes(a.operationStatus) && (
                          <button className="primary sm" onClick={() => act(a.id, "retry")} disabled={busy !== null} aria-busy={isBusy(a.id, "retry")}>
                            {isBusy(a.id, "retry") ? "Retrying…" : "Retry"}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableWrap>
        )}
      </section>
    </>
  );
}
