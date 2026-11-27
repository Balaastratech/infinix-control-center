import { describe, expect, it } from "vitest";
import { amountToPaise, parse, type AssistantContext } from "@/server/services/assistant-parser";

const customers = Array.from({ length: 10 }, (_, i) => ({ id: `C-${String(i + 1).padStart(3, "0")}`, name: `Demo Customer ${i + 1}`, email: `customer${i + 1}@example.test` }));
const NOW = new Date("2026-11-20T10:00:00Z"); // 15:30 IST, 20 Nov
const run = (text: string, last: AssistantContext | null = null) => parse(text, last, customers, NOW);

// [question, tool (or intent), expected input subset]
const TABLE: [string, string, Record<string, unknown>][] = [
  ["late orders", "find_orders", { shipmentStatus: "delayed" }],
  ["show stuck shipments over 5k", "find_orders", { shipmentStatus: "delayed", minAmountMinor: 500000 }],
  ["unpaid shipped orders", "find_orders", { paymentStatus: "failed", orderStatuses: ["shipped", "delivered"] }],
  ["orders with payment failed", "find_orders", { paymentStatus: "failed" }],
  ["how many cancelled orders this week", "count_orders", { orderStatus: "cancelled", createdFrom: "2026-11-13T18:30:00.000Z" }],
  ["orders between Rs 2,000 and Rs 10,000", "find_orders", { minAmountMinor: 199999, maxAmountMinor: 1000001 }],
  ["orders under ₹3000", "find_orders", { maxAmountMinor: 300000 }],
  ["delivered orders above 1.5 lakh", "find_orders", { orderStatus: "delivered", minAmountMinor: 15000000 }],
  ["orders placed today", "find_orders", { createdFrom: "2026-11-19T18:30:00.000Z" }],
  ["orders on 2026-11-03", "find_orders", { createdFrom: "2026-11-02T18:30:00.000Z", createdTo: "2026-11-03T18:30:00.000Z" }],
  ["orders since 10 nov", "find_orders", { createdFrom: "2026-11-09T18:30:00.000Z" }],
  ["orders out of sync", "find_orders", { localAhead: true }],
  ["orders for customer3@example.test", "find_orders", { customerId: "C-003" }],
  ["orders for Demo Customer 10", "find_orders", { customerId: "C-010" }],
  ["customer C-002", "get_customer", { customer_id: "C-002" }],
  ["show me customer 7", "get_customer", { customer_id: "C-007" }],
  ["investigate order NC-1004", "investigate_order", { order_id: "NC-1004" }],
  ["what happened to nc 1012", "investigate_order", { order_id: "NC-1012" }],
  ["money at risk", "money_at_risk", {}],
  ["how much are we owed", "money_at_risk", {}],
  ["refunds waiting for approval", "list_approvals", { status: "pending" }],
  ["approved refunds", "list_approvals", { status: "approved" }],
  ["open tickets", "list_tickets", { status: "open" }],
  ["tickets for NC-1003", "list_tickets", { order_id: "NC-1003" }],
  ["what's in the finance queue", "team_queues", { queue: "finance" }],
  ["team queues", "team_queues", {}],
  ["failed workflow runs", "workflow_runs", { outcome: "failed" }],
  ["is the payment API down", "health_and_sync", {}],
  ["when was the last sync", "health_and_sync", {}],
  ["who cancelled NC-1004", "search_audit", { action: "order.cancel", target: "NC-1004" }],
  ["who approved refunds", "search_audit", { action: "refund.approve" }],
  ["cancel NC-1001", "propose_cancel", { order_id: "NC-1001" }],
  ["request a refund for order NC-1002", "propose_refund", { order_id: "NC-1002" }],
  ["refund Rs 500 on NC-1002", "propose_refund", { order_id: "NC-1002", amount_minor: 50000 }],
  ["refund 500 rupees on NC-1002", "propose_refund", { order_id: "NC-1002", amount_minor: 50000 }],
  ["refund 500 for NC-1002", "propose_refund", { order_id: "NC-1002", amount_minor: 50000 }],
  ["refund 1,250.50 rs for NC-1002", "propose_refund", { order_id: "NC-1002", amount_minor: 125050 }],
  ["create a ticket for NC-1007 because customer never paid", "propose_ticket", { order_id: "NC-1007", reason: "customer never paid" }],
  // batch 2 gaps
  ["who is the customer for NC-1003", "get_customer", { order_id: "NC-1003" }],
  ["any integration errors?", "health_and_sync", {}],
  ["delayd shipmnts", "find_orders", { shipmentStatus: "delayed" }],
  ["what workflows ran today", "workflow_runs", { ran_from: "2026-11-19T18:30:00.000Z" }],
  ["failed workflow runs yesterday", "workflow_runs", { outcome: "failed", ran_from: "2026-11-18T18:30:00.000Z", ran_to: "2026-11-19T18:30:00.000Z" }],
  ["shipped but not paid", "find_orders", { paymentStatus: "failed", orderStatuses: ["shipped", "delivered"] }],
  ["don't cancel NC-1002, just show it", "investigate_order", { order_id: "NC-1002" }],
  ["do not refund NC-1002", "investigate_order", { order_id: "NC-1002" }],
  ["approve the refund for NC-1005", "list_approvals", { status: "pending" }],
  ["reject refund NC-1005", "list_approvals", { status: "pending" }],
  ["cancel NC-1001 and refund NC-1002", "propose_cancel", { order_id: "NC-1001" }],
  ["late orders; open tickets", "find_orders", { shipmentStatus: "delayed" }],
];

describe("assistant parser: phrasing table", () => {
  it.each(TABLE)("%s -> %s", (text, tool, input) => {
    const p = run(text);
    expect(p.call?.tool, p.understood).toBe(tool);
    expect(p.call!.input).toMatchObject(input);
    expect(p.understood).toMatch(/^I understood: /);
  });

  it("has at least 25 phrasings", () => expect(TABLE.length).toBeGreaterThanOrEqual(25));
});

describe("assistant parser: follow-ups, ambiguity, no match", () => {
  const last: AssistantContext = { intent: "find_orders", filters: { shipmentStatus: "delayed" }, resultIds: ["NC-1006", "NC-1016"] };

  it('"which of those are over Rs 10,000?" keeps the filters and narrows to the previous result', () => {
    const p = run("which of those are over Rs 10,000?", last);
    expect(p.call).toEqual({ tool: "find_orders", input: { shipmentStatus: "delayed", minAmountMinor: 1000000, order_ids: ["NC-1006", "NC-1016"] } });
    expect(p.understood).toContain("within your previous result");
  });

  it('"how many of them are unpaid" counts within the previous result', () => {
    const p = run("how many of them are unpaid", last);
    expect(p.call?.tool).toBe("count_orders");
    expect(p.call?.input).toMatchObject({ paymentStatus: "failed", order_ids: ["NC-1006", "NC-1016"] });
  });

  it('"and over 5k" adds to the previous filters without restricting to ids', () => {
    const p = run("and over 5k", last);
    expect(p.call?.input).toEqual({ shipmentStatus: "delayed", minAmountMinor: 500000 });
  });

  it("an ambiguous customer asks which one", () => {
    const p = parse("orders for demo customer", null, [...customers, { id: "C-099", name: "Demo Customer", email: "x@y.test" }], NOW);
    expect(p.intent).toBe("find_orders"); // the exact full name wins; a real tie is below
    const tie = parse("orders for Asha", null, [{ id: "C-1", name: "Asha", email: "a@x.test" }, { id: "C-2", name: "Asha", email: "b@x.test" }], NOW);
    expect(tie.intent).toBe("ambiguous");
    expect(tie.suggestions).toHaveLength(2);
  });

  it("two order statuses at once asks which one", () => {
    const p = run("shipped cancelled orders");
    expect(p.intent).toBe("ambiguous");
    expect(p.suggestions).toEqual(["cancelled orders", "shipped orders"]);
  });

  it("nonsense gets no tool and three suggestions", () => {
    const p = run("blorp the frobnicator");
    expect(p.intent).toBe("no_match");
    expect(p.call).toBeUndefined();
    expect(p.suggestions).toHaveLength(3);
  });
});

describe("assistant parser: amounts are integer paise", () => {
  it.each([
    ["10,000", undefined, 1000000],
    ["1,00,000", undefined, 10000000],
    ["10", "k", 1000000],
    ["1.5", "lakh", 15000000],
    ["2500.50", undefined, 250050],
  ] as const)("%s %s -> %d", (digits, unit, paise) => expect(amountToPaise(digits, unit)).toBe(paise));
  it("rejects zero and junk", () => {
    expect(amountToPaise("0")).toBeNull();
    expect(amountToPaise("1.234")).toBeNull();
  });
});

describe("assistant parser: batch 2 gaps", () => {
  it("customer for an order is the customer view, but 'who cancelled' is still the audit log", () => {
    expect(run("who is the customer for NC-1003").call?.tool).toBe("get_customer");
    expect(run("who cancelled NC-1003").call?.tool).toBe("search_audit");
  });

  it("'workflow errors' is workflow runs, not health; 'orders with errors' is not health either", () => {
    expect(run("workflow errors").call?.tool).toBe("workflow_runs");
    expect(run("orders with errors").call?.tool).not.toBe("health_and_sync");
  });

  it("typos are fixed only for known keywords, never names, and not on a tie", async () => {
    const { fixTypos } = await import("@/server/services/assistant-parser");
    expect(fixTypos("delayd shipmnts")).toBe("delayed shipments");
    expect(fixTypos("cancled ordrs")).toBe("canceled orders");
    expect(fixTypos("refundz")).toBe("refundz"); // 1 edit from both refund and refunds: a tie, left alone
    expect(fixTypos("refunded delivery")).toBe("refunded delivery"); // known words are left alone
    expect(run("orders for Demo Customer 3").call?.input).toMatchObject({ customerId: "C-003" });
    expect(run("blorp the frobnicator").intent).toBe("no_match");
  });

  it("negation removes only the negated action: 'don't cancel NC-1002, just refund it' proposes the refund", () => {
    const show = run("don't cancel NC-1002, just show it");
    expect(show.call?.tool).toBe("investigate_order");
    expect(JSON.stringify(show)).not.toContain("propose_");
    expect(run("don't cancel NC-1002, just refund it").call?.tool).toBe("propose_refund");
  });

  it("approve requests point to the Approvals page with a note and never make a proposal", () => {
    const p = run("approve the refund for NC-1005");
    expect(p.call).toEqual({ tool: "list_approvals", input: { status: "pending" } });
    expect(p.notice).toMatch(/Approvals page/);
    expect(run("who approved refunds").call?.tool).toBe("search_audit"); // the audit question still works
    expect(run("approved refunds").call?.tool).toBe("list_approvals");
  });

  it("two requests: answers the first and says one request at a time; one request with 'and' is untouched", () => {
    const p = run("cancel NC-1001 and refund NC-1002");
    expect(p.call?.tool).toBe("propose_cancel");
    expect(p.notice).toMatch(/one request at a time/i);
    const one = run("orders between Rs 2,000 and Rs 10,000");
    expect(one.notice).toBeUndefined();
    expect(run("late orders and then nonsense words").notice).toBeUndefined(); // the second part isn't a request
  });

  it("unknown text: what I can help with plus 3 examples", () => {
    const p = run("blorp the frobnicator");
    expect(p.question).toMatch(/^I can help with orders/);
    expect(p.suggestions).toHaveLength(3);
  });
});
