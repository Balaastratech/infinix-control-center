// Words for the UI: statuses, workflow parts, audit actions. Display only; the stored values never change.
import { formatMoney } from "./format";

const WORDS: Record<string, string> = {
  ok: "OK",
  pending_approval: "Pending approval",
  unsent: "Not sent",
};

// "pending_approval" -> "Pending approval", "ok" -> "OK", "shipment.updated" -> "Shipment updated"
export function statusLabel(value: string | null | undefined): string {
  if (!value) return "-";
  if (WORDS[value]) return WORDS[value];
  const words = value.replace(/[._]/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export const SERVICE_LABELS: Record<string, string> = { commerce: "Commerce API", payments: "Payment API", shipping: "Shipping API" };

// ---------- workflows ----------

export const TRIGGER_LABELS: Record<string, string> = {
  "payment.failed": "Payment failed",
  "shipment.updated": "Shipment updated",
  "order.cancelled": "Order cancelled",
};
export const FIELD_LABELS: Record<string, string> = {
  amount_minor: "Order amount",
  order_status: "Order status",
  payment_status: "Payment status",
  shipment_status: "Shipment status",
};
export const OP_LABELS: Record<string, string> = {
  eq: "is",
  neq: "is not",
  gt: "is more than",
  gte: "is at least",
  lt: "is less than",
  lte: "is at most",
};
export const ACTION_LABELS: Record<string, string> = {
  create_ticket: "Create support ticket",
  request_refund: "Request refund (needs Manager approval)",
};

// { field: "amount_minor", op: "gt", value: 500000 } -> "Order amount is more than ₹5,000.00"
export function conditionLabel(c: { field: string; op: string; value: number | string }): string {
  const value = c.field === "amount_minor" ? formatMoney(Number(c.value)) : statusLabel(String(c.value));
  return `${FIELD_LABELS[c.field] ?? c.field} ${OP_LABELS[c.op] ?? c.op} ${value}`;
}

// A plausible order to preview ticket text against (matches the seeded "delayed high-value" case).
export const SAMPLE_ORDER = {
  orderId: "NC-1016",
  facts: { amount_minor: 700000, order_status: "shipped", payment_status: "captured", shipment_status: "delayed" },
};

// ---------- audit ----------

const AUDIT_ACTIONS: Record<string, string> = {
  sync: "Sync",
  "order.cancel": "Order cancelled",
  "order.reconcile_cancel": "Cancel pushed upstream",
  "refund.request": "Refund requested",
  "refund.bulk_request": "Bulk refunds requested",
  "refund.approve": "Refund approved",
  "refund.reject": "Refund rejected",
  "refund.execute": "Refund sent to Payment API",
  "refund.retry": "Refund retried",
  "webhook.rejected": "Webhook rejected",
  "workflow.create": "Workflow created",
  "workflow.update": "Workflow edited",
  "workflow.enable": "Workflow enabled",
  "workflow.disable": "Workflow disabled",
  "workflow.create_ticket": "Ticket created by workflow",
  "workflow.error": "Workflow error",
};
export const auditActionLabel = (action: string) => AUDIT_ACTIONS[action] ?? statusLabel(action);
export const auditTargetLabel = (action: string, target: string | null) =>
  action === "sync" && target === "all" ? "All services" : (target ?? "-");

// One readable line from the stored detail (JSON or plain text). The raw value stays available behind a toggle.
export function auditSummary(action: string, detail: string | null): string {
  if (!detail) return "-";
  let parsed: unknown;
  try {
    parsed = JSON.parse(detail);
  } catch {
    return detail;
  }
  if (typeof parsed !== "object" || parsed === null) return String(parsed);
  const d = parsed as Record<string, unknown>;

  if (Array.isArray(d.services)) {
    return (d.services as { service: string; status: string; error?: string }[])
      .map((s) => `${SERVICE_LABELS[s.service] ?? s.service} ${statusLabel(s.status)}${s.error ? ` (${s.error})` : ""}`)
      .join(" · ");
  }
  if (action === "workflow.update") return `Changed ${Object.keys(d).map((k) => k.replace(/_/g, " ")).join(", ")}`;

  const parts: string[] = [];
  if (typeof d.name === "string") parts.push(d.name);
  if (typeof d.trigger === "string") parts.push(`when ${TRIGGER_LABELS[d.trigger] ?? d.trigger}`);
  if (typeof d.amountMinor === "number") parts.push(formatMoney(d.amountMinor));
  if (typeof d.created === "number") parts.push(`${d.created} created, ${d.skipped ?? 0} skipped`);
  if (typeof d.externalId === "string") parts.push(`refund ${d.externalId}`);
  if (typeof d.ticketId === "string") parts.push(`ticket ${d.ticketId}`);
  if (typeof d.reason === "string") parts.push(d.reason);
  if (typeof d.note === "string") parts.push(`note: ${d.note}`);
  if (typeof d.httpStatus === "number") parts.push(`HTTP ${d.httpStatus}`);
  if (typeof d.error === "string") parts.push(d.error);
  if (typeof d.via === "string") parts.push(`via ${d.via}`);
  const line = parts.join(" · ");
  return line ? line.charAt(0).toUpperCase() + line.slice(1) : "-";
}
