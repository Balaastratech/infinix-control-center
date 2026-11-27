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

// A workflow run's stored result (JSON) or error, as a sentence for staff.
export function runResultLabel(result: string | null, error: string | null): string {
  if (error) return error;
  if (!result) return "-";
  let r: unknown;
  try {
    r = JSON.parse(result);
  } catch {
    return result; // skip reasons are stored as text
  }
  const d = (r ?? {}) as Record<string, unknown>;
  if (typeof d.approvalId === "number") {
    return `Refund request #${d.approvalId}${typeof d.amountMinor === "number" ? ` for ${formatMoney(d.amountMinor)}` : ""} sent for approval`;
  }
  if (typeof d.ticketId === "string") return `Support ticket ${d.ticketId} created`;
  return statusLabel(String(r));
}

// Workflow form issue path -> the field's label: ["conditions", 0, "value"] -> "Condition 1 value".
export function issueFieldLabel(path: readonly PropertyKey[]): string {
  const [head, i, leaf] = path;
  if (head === "conditions" && typeof i === "number") {
    const part = { field: "field", op: "comparison", value: "value" }[String(leaf)] ?? "";
    return `Condition ${i + 1}${part ? ` ${part}` : ""}`;
  }
  if (head === "conditions") return "Conditions";
  if (head === "action") return i === "reason" ? "Ticket text" : i === "amount_minor" ? "Refund amount" : "Action";
  return { name: "Name", trigger: "Trigger", enabled: "Enabled" }[String(head)] ?? "Workflow";
}

// ---------- audit ----------

const DETAIL_KEYS: Record<string, string> = {
  amountMinor: "Amount",
  approvalId: "Approval",
  operationId: "Operation",
  externalId: "Refund id",
  ticketId: "Ticket",
  eventId: "Event",
  executionId: "Workflow run",
  httpStatus: "HTTP status",
};
const keyLabel = (k: string) => DETAIL_KEYS[k] ?? statusLabel(k.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase());
const valueText = (k: string, v: unknown): string => {
  if (v === null || v === undefined || v === "") return "-";
  if (/Minor$/.test(k) && typeof v === "number") return formatMoney(v);
  if (Array.isArray(v)) return v.map((x) => valueText("", x)).join("; ");
  if (typeof v === "object") return Object.entries(v as Record<string, unknown>).map(([kk, vv]) => `${keyLabel(kk)}: ${valueText(kk, vv)}`).join(", ");
  return String(v);
};

// The stored detail as readable label/value pairs (for the expandable row), never raw JSON.
export function auditDetailEntries(detail: string | null): [string, string][] {
  if (!detail) return [];
  try {
    const parsed: unknown = JSON.parse(detail);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return Object.entries(parsed as Record<string, unknown>).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [keyLabel(k), valueText(k, v)]);
    }
    return [["Detail", valueText("", parsed)]];
  } catch {
    return [["Detail", detail]];
  }
}

const AUDIT_ACTIONS: Record<string, string> = {
  sync: "Sync",
  "auth.login": "Login",
  "auth.logout": "Logout",
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
