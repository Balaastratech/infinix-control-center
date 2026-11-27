"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

// "Create support ticket" for one order: opens a reason box, POSTs to /api/orders/[id]/tickets
// (the server checks role, order and Commerce API answer), then refreshes the page's server data.
export function CreateTicketButton({ orderId, defaultReason = "", onDone, label = "Create ticket" }: {
  orderId: string;
  defaultReason?: string;
  onDone?: () => void;
  label?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState(defaultReason);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!reason.trim()) return setResult({ ok: false, text: "A reason is required." });
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch(`/api/orders/${encodeURIComponent(orderId)}/tickets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) return setResult({ ok: false, text: b.error ?? `HTTP ${res.status}` });
      setResult({ ok: true, text: `Ticket ${b.ticketId} created.` });
      setOpen(false);
      onDone?.();
      router.refresh();
    } catch {
      setResult({ ok: false, text: "Network error, try again" });
    } finally {
      setBusy(false);
    }
  }

  const status = result && <span className={result.ok ? "small ok-text" : "field-error"} role={result.ok ? "status" : "alert"}>{result.text}</span>;
  if (!open) {
    return (
      <span className="row">
        <button className="sm" onClick={() => setOpen(true)}>{label}</button>
        {status}
      </span>
    );
  }
  return (
    <form className="ticket-form" onSubmit={submit} noValidate>
      <label className="field">
        <span>Reason for {orderId}</span>
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={2} aria-invalid={result && !result.ok ? true : undefined} autoFocus />
      </label>
      <span className="row">
        <button type="submit" className="primary sm" disabled={busy} aria-busy={busy}>{busy ? "Creating…" : "Create ticket"}</button>
        <button type="button" className="sm" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
        {status}
      </span>
    </form>
  );
}
