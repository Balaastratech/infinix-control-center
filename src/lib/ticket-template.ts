// Ticket text for the create_ticket workflow action. Pure, so the workflow engine (server) and the editor's
// preview (browser) render the template with the same code.
import { formatMoney } from "./format";

export interface TicketFacts {
  amount_minor: number | string | null;
  order_status: number | string | null;
  payment_status: number | string | null;
  shipment_status: number | string | null;
}

export function renderReason(template: string, facts: TicketFacts, event: { orderId: string; type: string }): string {
  const values: Record<string, string> = {
    order_id: event.orderId,
    amount: typeof facts.amount_minor === "number" ? formatMoney(facts.amount_minor) : "-",
    order_status: String(facts.order_status ?? "-"),
    payment_status: String(facts.payment_status ?? "-"),
    shipment_status: String(facts.shipment_status ?? "-"),
    event_type: event.type,
  };
  return template.replace(/\{(\w+)\}/g, (m, key: string) => values[key] ?? m);
}
