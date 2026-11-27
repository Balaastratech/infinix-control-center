# Working on this take-home

This folder is a take-home assignment from a company, taken through Steerwise. Read ASSIGNMENT.md first.

- The candidate leads. Do what they ask, the way they ask; don't finish the assignment on your own.
- Build everything inside this folder. Anything outside it is not part of the submission.
- Never put secrets (API keys, passwords, tokens) in files or commands here: the folder and the sessions run in
  it are uploaded when the candidate submits.
- Submit only when the candidate asks: call the Steerwise `submit` tool with this take-home's id and run the
  command it returns, in this folder. Nothing is shared with the company until the candidate confirms on the website.

---

# NovaCommerce Operations Control Center

## The customer and the problem
NovaCommerce is a growing e-commerce business. Its ops, finance and support teams use separate systems
for orders (Commerce API), payments (Payment API) and shipments (Shipping API). They switch tools all day,
reconcile by hand, chase failures and coordinate approvals in chat. We build ONE internal platform that
syncs the three systems, enforces the business rules, and automates the repetitive work.
The pain in their own data: 11 cancelled orders still hold a captured payment with no refund (₹1,37,750 owed), and
4 orders were shipped or delivered with a failed payment (₹51,250 unpaid). Mismatches like these must be visible
on the dashboard and fixable from the app. Customer outcome first, polish last.

## Stack
Next.js App Router + TypeScript · SQLite (better-sqlite3) + Drizzle · zod · iron-session · Vitest + MSW.
External services: `python attachments/mock_services.py` → http://127.0.0.1:8765 (docs in ./attachments).
Commands: `npm run setup` (migrate + seed) · `npm run dev` · `npm test`.
Money is integer paise everywhere (₹5,000 = 500000). Never use floats for money.

## Business rules (must never break; enforced in src/server/services, never only in the UI)
- No cancel if the order is shipped/delivered, or the shipment is shipped/delayed/delivered.
- Refund only with a captured payment AND an order that is cancelled or delivered.
  Amount: 0 < amount <= captured minus non-failed refunds minus amounts in pending/approved requests.
  Partial refunds allowed.
- Every refund needs Manager approval before the Payment API is called — workflow refunds too.
- On approve, re-read the order and payment from upstream and re-check the rule. Local data can be ahead of
  upstream (a webhook cancel the mock doesn't know). If they disagree, don't refund; record why.
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
- Clean, consistent UI built on the tokens in src/app/globals.css; no UI library. Tables, forms, status badges, loading/empty/error states.
  Show money as ₹ with 2 decimals (store paise) and times in IST (store UTC).
- Must run on a fresh clone with no accounts: setup creates .env.local (random SESSION_SECRET) if missing.
- Ask me before adding a dependency. Don't change a test to make it pass without telling me why.
- Stay inside this folder. Never edit files in ./attachments.
- Don't use busctl or the Agent Bus here.

## Agreed decisions
External API contract and mock quirks: docs/external-apis.md (mock_services.py is the truth).
- Orders/payments: a webhook value wins until upstream agrees; show "local ahead" with both values on the dashboard, never overwrite silently.
- Shipments: event occurred_at strictly older than updated_at = stale; equal or newer = apply.
- Unpaid shipped/delivered order: fix = support ticket; it stays on "Money at risk" until upstream shows it paid.
- "Request full refunds" bulk action: one separate approval per owed order; skip orders with a pending/approved request.
- Webhooks require header X-Webhook-Secret == WEBHOOK_SECRET (.env.local, generated by setup); missing/wrong = 401, logged.
- Workflow refunds: requested_by_user_id empty, requested_by_label "workflow:<name>"; any manager may approve.
- Retries: 3 attempts total with backoff, network errors and 503 only, never 400/404/409; 5 s timeout per attempt.
- Webhook unknown type = stored as ignored, 200; malformed payload = 400.
- Workflows fire only from webhooks and in-app actions, never from sync; our own successful cancel fires order.cancelled.
- Cancels need no approval: Operator or Manager cancels immediately through the API.
- Refund amount defaults to the full refundable amount; a smaller amount may be entered.
- Demo users (password demo1234): viewer@nova.test, operator@nova.test, manager@nova.test, manager2@nova.test.
- Deploy: own server via Cloudflare tunnel (https://novaops.balaastratech.com), Node + Python mock as two services, no Docker.
- Config from env with local defaults: DATABASE_PATH, MOCK_BASE_URL, PORT, WEBHOOK_SECRET, SESSION_SECRET.
