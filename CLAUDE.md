# NovaCommerce Operations Control Center

## The customer and the problem
NovaCommerce is a growing e-commerce business. Its ops, finance and support teams use separate systems
for orders (Commerce API), payments (Payment API) and shipments (Shipping API). They switch tools all day,
reconcile by hand, chase failures and coordinate approvals in chat. We build ONE internal platform that
syncs the three systems, enforces the business rules, and automates the repetitive work.

## Stack
Next.js App Router + TypeScript · SQLite (better-sqlite3) + Drizzle · zod · iron-session · Vitest + MSW.
External services: `python attachments/mock_services.py` → http://127.0.0.1:8765 (docs in ./attachments).
Commands: `npm run setup` (migrate + seed) · `npm run dev` · `npm test`.
Money is integer paise everywhere (₹5,000 = 500000). Never use floats for money.

## Business rules (must never break; enforced in src/server/services, never only in the UI)
- No cancel if the order is shipped/delivered, or the shipment is shipped/delayed/delivered.
- Refund only with a captured payment AND an order that is cancelled or delivered.
  Amount: 0 < amount <= captured minus already refunded. Partial refunds allowed.
- Every refund needs Manager approval before the Payment API is called — workflow refunds too.
- On approve, re-check the refund rule against current data.
- Cancel and refund go through the external APIs. Final state comes from their answer, never assumed:
  a refund reply of HTTP 201 with `status: "failed"` is a failure.
- Every consequential action writes audit_log: who, role, action, target, outcome.
- The app must stay usable when an external service is down: read local data, show the error.

## Roles (checked in every API route with requireRole; 401 not logged in, 403 wrong role)
| Action | Viewer | Operator | Manager |
|---|---|---|---|
| View orders, dashboard, approvals, audit | yes | yes | yes |
| Request cancel / refund, Sync now | no | yes | yes |
| Approve or reject a refund | no | no | yes, but never their own request |
| Create / edit / enable / disable workflows | no | no | yes |

## Integration rules
- Webhooks: POST /api/webhooks. Dedupe on event_id (UNIQUE). A duplicate returns 200 and changes nothing.
- Shipment events older than the row's updated_at are stored as stale and not applied.
- Retry network errors and 503 with backoff (max 3). Never retry 400/404/409.
- No idempotency key on refunds: before retrying one, check GET /payments/refunds for that order.

## How we work
- One slice at a time from PLAN.md. Don't start the next slice until I say so.
- Routes are thin (zod parse → requireRole → service → JSON). All rules live in src/server/services.
- Every rule has a test, including at least one failure case. Run `npm test` before saying "done".
- Plain UI: tables, forms, status badges, loading/empty/error states. No styling work.
- Ask me before adding a dependency. Don't change a test to make it pass without telling me why.
- Stay inside this folder. Never edit files in ./attachments.
