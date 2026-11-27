"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatIst, formatMoney, parseRupees } from "@/lib/format";
import { ACTION_LABELS, conditionLabel, FIELD_LABELS, issueFieldLabel, OP_LABELS, runResultLabel, SAMPLE_ORDER, statusLabel, TRIGGER_LABELS } from "@/lib/labels";
import { renderReason } from "@/lib/ticket-template";
import { Alert, Badge, Card, Empty, Skeleton, SkeletonCard, TableWrap } from "../../ui";

// Option lists for the form only; the server validates every value again (services/workflows.ts).
const TRIGGERS = ["payment.failed", "shipment.updated", "order.cancelled"];
const STATUS_OPTIONS: Record<string, string[]> = {
  order_status: ["processing", "shipped", "delivered", "cancelled"],
  payment_status: ["captured", "failed"],
  shipment_status: ["pending", "shipped", "delayed", "delivered", "cancelled"],
};
const FIELDS = ["amount_minor", ...Object.keys(STATUS_OPTIONS)];
const AMOUNT_OPS = ["eq", "neq", "gt", "gte", "lt", "lte"];
const PLACEHOLDER_HINT = "{order_id} {amount} {order_status} {payment_status} {shipment_status} {event_type}";

interface Condition {
  field: string;
  op: string;
  value: number | string;
}
type Action = { type: "create_ticket"; reason: string } | { type: "request_refund"; amount_minor?: number };
interface Workflow {
  id: number;
  name: string;
  trigger: string;
  conditions: Condition[];
  action: Action;
  enabled: boolean;
}
interface Execution {
  id: number;
  eventId: string;
  orderId: string | null;
  matched: boolean;
  outcome: string;
  result: string | null;
  error: string | null;
  ranAt: string;
}

// Form state keeps money as ₹ text; converted to paise on save.
interface FormCondition {
  field: string;
  op: string;
  value: string;
}
interface Form {
  id: number | null;
  name: string;
  trigger: string;
  conditions: FormCondition[];
  actionType: Action["type"];
  reason: string;
  amount: string; // ₹, blank = full refundable
}

const toRupees = (paise: number) => `${Math.trunc(paise / 100)}.${String(paise % 100).padStart(2, "0")}`;
const EMPTY: Form = {
  id: null,
  name: "",
  trigger: TRIGGERS[0],
  conditions: [{ field: "payment_status", op: "eq", value: "failed" }],
  actionType: "create_ticket",
  reason: "",
  amount: "",
};

const describeCondition = (c: Condition) => conditionLabel(c);
const describeAction = (a: Action) =>
  a.type === "create_ticket"
    ? "Create support ticket"
    : `Request refund (needs Manager approval): ${a.amount_minor ? formatMoney(a.amount_minor) : "full refundable amount"}`;
// The ticket text as it would read for a sample order, rendered by the same template code the workflow engine uses.
const previewTicket = (reason: string, trigger: string) =>
  renderReason(reason, SAMPLE_ORDER.facts, { orderId: SAMPLE_ORDER.orderId, type: trigger });

function toForm(w: Workflow): Form {
  return {
    id: w.id,
    name: w.name,
    trigger: w.trigger,
    conditions: w.conditions.map((c) => ({ ...c, value: c.field === "amount_minor" ? toRupees(c.value as number) : String(c.value) })),
    actionType: w.action.type,
    reason: w.action.type === "create_ticket" ? w.action.reason : "",
    amount: w.action.type === "request_refund" && w.action.amount_minor ? toRupees(w.action.amount_minor) : "",
  };
}

// Returns the API body, or a message for the user.
function toBody(f: Form): Record<string, unknown> | string {
  const conditions: Condition[] = [];
  for (const c of f.conditions) {
    if (c.field !== "amount_minor") {
      conditions.push(c);
      continue;
    }
    const paise = c.value.trim() === "0" ? 0 : parseRupees(c.value);
    if (paise === null) return "Condition amounts must be in ₹ with at most 2 decimals.";
    conditions.push({ ...c, value: paise });
  }
  let action: Action = { type: "create_ticket", reason: f.reason };
  if (f.actionType === "request_refund") {
    const paise = f.amount.trim() ? parseRupees(f.amount) : undefined;
    if (paise === null) return "Refund amount must be above ₹0 with at most 2 decimals, or blank for the full amount.";
    action = { type: "request_refund", ...(paise ? { amount_minor: paise } : {}) };
  }
  return { name: f.name, trigger: f.trigger, conditions, action };
}

async function send(url: string, method: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const b = await res.json().catch(() => ({}));
  if (!res.ok) {
    const issues = (b.issues as { path: unknown[]; message: string }[] | undefined)?.map((i) => `${issueFieldLabel(i.path as PropertyKey[])}: ${i.message}`);
    throw new Error([b.error ?? `HTTP ${res.status}`, ...(issues ?? [])].join(" · "));
  }
  return b;
}

export function WorkflowsEditor({ isManager }: { isManager: boolean }) {
  const [items, setItems] = useState<Workflow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [runsFor, setRunsFor] = useState<Workflow | null>(null);
  const [loadedRuns, setRuns] = useState<{ workflowId: number; items: Execution[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch("/api/workflows", { signal: ctrl.signal })
      .then(async (res) => {
        const b = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(b.error ?? `HTTP ${res.status}`);
        setLoadError(null);
        setItems(b.items);
      })
      .catch((e: Error) => {
        if (e.name !== "AbortError") setLoadError(e.message);
      });
    return () => ctrl.abort();
  }, [version]);

  useEffect(() => {
    if (!runsFor) return;
    const ctrl = new AbortController();
    fetch(`/api/workflows/${runsFor.id}/executions`, { signal: ctrl.signal })
      .then(async (res) => {
        const b = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(b.error ?? `HTTP ${res.status}`);
        setRuns({ workflowId: runsFor.id, items: b.items });
      })
      .catch((e: Error) => {
        if (e.name !== "AbortError") setMessage({ ok: false, text: `Could not load executions: ${e.message}` });
      });
    return () => ctrl.abort();
  }, [runsFor, version]);

  async function run(work: () => Promise<unknown>, okText: string) {
    setBusy(true);
    setMessage(null);
    try {
      await work();
      setMessage({ ok: true, text: okText });
      setVersion((v) => v + 1);
      return true;
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message || "Network error, try again" });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    const body = toBody(form);
    if (typeof body === "string") return setMessage({ ok: false, text: body });
    const saved = await run(
      () => (form.id ? send(`/api/workflows/${form.id}`, "PATCH", body) : send("/api/workflows", "POST", body)),
      form.id ? "Workflow saved." : "Workflow created.",
    );
    if (saved) setForm(null);
  }

  const setCondition = (i: number, patch: Partial<FormCondition>) =>
    setForm((f) => f && { ...f, conditions: f.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)) });

  const runs = loadedRuns && runsFor && loadedRuns.workflowId === runsFor.id ? loadedRuns.items : null;

  if (loadError && !items) return <Alert tone="bad">Could not load workflows: {loadError}</Alert>;
  if (!items) return <SkeletonCard rows={3} />;

  return (
    <>
      {message && <Alert tone={message.ok ? "ok" : "bad"}>{message.text}</Alert>}
      <Card
        title="Rules"
        count={items.length}
        actions={
          isManager && !form ? (
            <button className="primary sm" onClick={() => setForm(EMPTY)}>
              New workflow
            </button>
          ) : (
            !isManager && <span className="muted small">Only Managers can create or edit workflows.</span>
          )
        }
        flush
      >
        {items.length === 0 ? (
          <Empty>No workflows yet.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>When</th>
                  <th>If all of</th>
                  <th>Then</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((w) => (
                  <tr key={w.id}>
                    <td>
                      <b>{w.name}</b>
                    </td>
                    <td>{TRIGGER_LABELS[w.trigger] ?? w.trigger}</td>
                    <td>
                      {w.conditions.map((c, i) => (
                        <div key={i} className="small">
                          {i > 0 && <span className="muted">and </span>}
                          {describeCondition(c)}
                        </div>
                      ))}
                    </td>
                    <td className="small">
                      {describeAction(w.action)}
                      {w.action.type === "create_ticket" && (
                        <div className="preview" title={`Template: ${w.action.reason}`}>
                          “{previewTicket(w.action.reason, w.trigger)}”
                          <small>Preview for sample order {SAMPLE_ORDER.orderId}</small>
                        </div>
                      )}
                    </td>
                    <td>
                      <Badge status={w.enabled ? "enabled" : "disabled"} />
                    </td>
                    <td>
                      <span className="row">
                        <button className="sm" onClick={() => setRunsFor(w)} aria-pressed={runsFor?.id === w.id}>
                          Executions
                        </button>
                        {isManager && (
                          <>
                            <button
                              className="sm"
                              disabled={busy}
                              onClick={() => run(() => send(`/api/workflows/${w.id}`, "PATCH", { enabled: !w.enabled }), `${w.name} ${w.enabled ? "disabled" : "enabled"}.`)}
                            >
                              {w.enabled ? "Disable" : "Enable"}
                            </button>
                            <button className="sm" disabled={busy} onClick={() => setForm(toForm(w))}>
                              Edit
                            </button>
                          </>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      {form && (
        <Card title={form.id ? `Edit workflow #${form.id}` : "New workflow"}>
          <form className="stack" onSubmit={save}>
            <div className="row" style={{ alignItems: "flex-end" }}>
              <label className="field" style={{ flex: "1 1 260px" }}>
                <span>Name</span>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={100} />
              </label>
              <label className="field">
                <span>When</span>
                <select value={form.trigger} onChange={(e) => setForm({ ...form, trigger: e.target.value })}>
                  {TRIGGERS.map((t) => (
                    <option key={t} value={t}>
                      {TRIGGER_LABELS[t] ?? t}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <fieldset className="stack">
              <legend>Only if all of these are true (checked against our stored order, payment and shipment)</legend>
              {form.conditions.map((c, i) => {
                const isAmount = c.field === "amount_minor";
                return (
                  <div key={i} className="row">
                    <select
                      aria-label="Field"
                      value={c.field}
                      onChange={(e) => {
                        const field = e.target.value;
                        setCondition(i, { field, op: "eq", value: field === "amount_minor" ? "" : STATUS_OPTIONS[field][0] });
                      }}
                    >
                      {FIELDS.map((f) => (
                        <option key={f} value={f}>
                          {FIELD_LABELS[f] ?? f}
                        </option>
                      ))}
                    </select>
                    <select aria-label="Operator" value={c.op} onChange={(e) => setCondition(i, { op: e.target.value })}>
                      {(isAmount ? AMOUNT_OPS : ["eq", "neq"]).map((o) => (
                        <option key={o} value={o}>
                          {OP_LABELS[o] ?? o}
                        </option>
                      ))}
                    </select>
                    {isAmount ? (
                      <label className="money-input" aria-label="Amount in rupees">
                        <span>₹</span>
                        <input value={c.value} onChange={(e) => setCondition(i, { value: e.target.value })} inputMode="decimal" required />
                      </label>
                    ) : (
                      <select aria-label="Value" value={c.value} onChange={(e) => setCondition(i, { value: e.target.value })}>
                        {STATUS_OPTIONS[c.field].map((s) => (
                          <option key={s} value={s}>
                            {statusLabel(s)}
                          </option>
                        ))}
                      </select>
                    )}
                    <button
                      type="button"
                      className="ghost sm"
                      disabled={form.conditions.length === 1}
                      onClick={() => setForm({ ...form, conditions: form.conditions.filter((_, j) => j !== i) })}
                    >
                      Remove
                    </button>
                  </div>
                );
              })}
              <div>
                <button
                  type="button"
                  className="sm"
                  disabled={form.conditions.length >= 10}
                  onClick={() => setForm({ ...form, conditions: [...form.conditions, { field: "amount_minor", op: "gt", value: "" }] })}
                >
                  + Add condition
                </button>
              </div>
            </fieldset>
            <label className="field">
              <span>Then</span>
              <select value={form.actionType} onChange={(e) => setForm({ ...form, actionType: e.target.value as Action["type"] })}>
                <option value="create_ticket">{ACTION_LABELS.create_ticket}</option>
                <option value="request_refund">{ACTION_LABELS.request_refund}</option>
              </select>
            </label>
            {form.actionType === "create_ticket" ? (
              <label className="field">
                <span>Ticket reason</span>
                <input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} required maxLength={500} />
                <span className="hint">Placeholders: {PLACEHOLDER_HINT}</span>
                {form.reason.trim() && (
                  <span className="preview">
                    “{previewTicket(form.reason, form.trigger)}”
                    <small className="muted"> · preview for sample order {SAMPLE_ORDER.orderId}</small>
                  </span>
                )}
              </label>
            ) : (
              <label className="field">
                <span>Refund amount</span>
                <span className="money-input" style={{ alignSelf: "flex-start" }}>
                  <span>₹</span>
                  <input value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} inputMode="decimal" placeholder="full" />
                </span>
                <span className="hint">Blank = the full refundable amount. Over the limit, the run fails with the reason.</span>
              </label>
            )}
            <div className="row">
              <button type="submit" className="primary" disabled={busy} aria-busy={busy}>
                {busy ? "Saving…" : "Save"}
              </button>
              <button type="button" className="ghost" onClick={() => setForm(null)}>
                Cancel
              </button>
            </div>
          </form>
        </Card>
      )}

      {runsFor && (
        <Card
          title={`Executions: ${runsFor.name}`}
          count={runs?.length}
          actions={
            <button className="ghost sm" onClick={() => setRunsFor(null)}>
              Close
            </button>
          }
          flush
        >
          {!runs ? (
            <div className="card-body">
              <Skeleton h={16} />
            </div>
          ) : runs.length === 0 ? (
            <Empty>No executions yet.</Empty>
          ) : (
            <TableWrap>
              <table className="compact">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Event</th>
                    <th>Order</th>
                    <th>Matched</th>
                    <th>Outcome</th>
                    <th>Result / error</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id}>
                      <td className="nowrap">{formatIst(r.ranAt)}</td>
                      <td className="mono">{r.eventId}</td>
                      <td>{r.orderId ? <Link href={`/orders/${r.orderId}`}>{r.orderId}</Link> : "-"}</td>
                      <td>{r.matched ? "yes" : "no"}</td>
                      <td>
                        <Badge status={r.outcome} />
                      </td>
                      <td className={r.outcome === "failed" ? "error" : undefined}>
                        <small>{runResultLabel(r.result, r.error)}</small>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>
      )}
    </>
  );
}
