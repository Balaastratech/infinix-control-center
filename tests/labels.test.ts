import { describe, expect, it } from "vitest";
import { auditDetailEntries, issueFieldLabel, runResultLabel } from "@/lib/labels";

describe("readable text for staff", () => {
  it("workflow run results read as sentences", () => {
    expect(runResultLabel(JSON.stringify({ operationId: 9, approvalId: 6, amountMinor: 250000 }), null)).toBe("Refund request #6 for ₹2,500.00 sent for approval");
    expect(runResultLabel(JSON.stringify({ ticketId: "T-1" }), null)).toBe("Support ticket T-1 created");
    expect(runResultLabel("Order amount ₹1,375.00 is not more than ₹5,000.00", null)).toBe("Order amount ₹1,375.00 is not more than ₹5,000.00");
    expect(runResultLabel(null, "Commerce API is unreachable")).toBe("Commerce API is unreachable");
  });

  it("workflow form issues name the field, not the JSON path", () => {
    expect(issueFieldLabel(["conditions", 0, "value"])).toBe("Condition 1 value");
    expect(issueFieldLabel(["action", "reason"])).toBe("Ticket text");
    expect(issueFieldLabel(["action", "amount_minor"])).toBe("Refund amount");
    expect(issueFieldLabel(["name"])).toBe("Name");
  });

  it("audit details become label/value pairs with money in Rs", () => {
    expect(auditDetailEntries(JSON.stringify({ approvalId: 3, amountMinor: 112500, error: null, reason: "x" }))).toEqual([
      ["Approval", "3"],
      ["Amount", "₹1,125.00"],
      ["Reason", "x"],
    ]);
    expect(auditDetailEntries("plain text")).toEqual([["Detail", "plain text"]]);
  });
});
