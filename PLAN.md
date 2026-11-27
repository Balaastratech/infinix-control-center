# Plan: NovaCommerce Operations Control Center (one page)

**Customer and problem:** NovaCommerce's ops, finance and support teams each use a separate system for orders, payments and shipments. They reconcile by hand and chase failures. We build one internal app that syncs all three, enforces the rules, and automates the repeat work.

## Tables (SQLite + Drizzle; money in integer paise)
| Table | Key fields | Owner |
|---|---|---|
| customers | id (C-001), name, email | Commerce copy |
| orders | id (NC-1001), customer_id, status, amount_minor, created_at, channel, local_updated_at, synced_at | Commerce copy |
| payments | id (P-001), order_id, status, amount_minor, refunded_minor | Payment copy |
| shipments | id (S-001), order_id, status, updated_at | Shipping copy |
| users | id, email, password_hash, role (viewer/operator/manager) | ours |
| operations | id, type (cancel/refund), order_id, amount_minor, status (requested → pending_approval → approved → submitted → succeeded/failed/rejected), external_id, error, requested_by | ours |
| approvals | id, operation_id, status (pending/approved/rejected), decided_by, decided_at, note | ours |
| workflows | id, name, trigger, conditions (JSON list of field/op/value), action, action_params (e.g. refund amount), enabled | ours |
| workflow_executions | id, workflow_id, event_id, matched, outcome (skipped/succeeded/failed), result, error, ran_at | ours |
| webhook_events | event_id (UNIQUE), type, order_id, occurred_at, payload, status (applied/duplicate/stale/pending) | ours |
| sync_runs / service_health | service, started, finished, status, counts, error; last_ok_at, down flag | ours |
| tickets | id (T-…), order_id, reason, status | Commerce copy |
| audit_log | at, user_id, role, action, target, outcome, detail | ours |

## Sync and webhooks
- **Sync:** pull customers, orders, payments, shipments, refunds and tickets. Each service syncs in its own transaction and writes one sync_runs row. If one fails, the others still finish. The UI always reads local data and shows "Payment API unreachable, data from 10:42".
- **Service down:**
  - Every call has a 5s timeout.
  - Retry a network error or 503 up to 3 times with backoff. Never retry 400, 404 or 409.
  - After repeated failures, mark the service down on the dashboard.
  - A cancel or refund that fails is saved as `failed` with the error and a Retry button.
- **The same webhook twice:** we insert the event_id first. A UNIQUE conflict means we've seen it, so we return 200 and do nothing: no state change and no second workflow run.
- **Out-of-order events:** for shipments, an event older than the row's `updated_at` is marked stale. Orders and payments have no timestamps, so we keep our own last-event time on the row.
- **Event for an unknown order:** saved as pending and applied after the next sync.
- **Refund retries:** before retrying a refund, check `GET /payments/refunds` for that order. The refund endpoint has no idempotency key, so a blind retry could refund twice.

## Roles (enforced in every API route; the UI only mirrors them)
| Action | Viewer | Operator | Manager |
|---|---|---|---|
| View orders, dashboard, audit | ✓ | ✓ | ✓ |
| Request cancel / request refund | ✗ | ✓ | ✓ |
| Approve or reject a refund | ✗ | ✗ | ✓ (not their own request) |
| Create, edit, enable or disable workflows | ✗ | ✗ | ✓ |
| Sync now | ✗ | ✓ | ✓ |

## Business rules (in the service layer, checked again on approve)
- **No cancel when:**
  - the order is shipped or delivered, or
  - the shipment is shipped, delayed or delivered (the mock refuses these too).
- **Refund:**
  - Needs a captured payment AND an order that is cancelled or delivered.
  - The amount must be 0 < amount ≤ captured minus non-failed refunds minus amounts in pending/approved requests.
  - Every refund needs Manager approval before the Payment API is called. That includes refunds started by a workflow.
- **Final state comes only from the API's answer.** A refund is a success only when the reply body says `status: succeeded`, not just because the HTTP code is 201.

## Build order (8 one-hour blocks)
1. **Read and scaffold.** The agent reads the docs and lists questions. Then the schema, migrations, seed users, login and `requireRole`. *Done when:* `npm run setup` works and a Viewer gets 403 on a write route.
2. **Clients, sync, webhooks, health** (plan mode). *Done when:* tests pass for service down, duplicate event and stale event.
3. **Orders.** List, search, filter and paginate; order detail; request cancel and refund with the rules. *Done when:* the rule tests pass, including the 409 cases.
4. **Approvals and audit.** Approval queue, approve with a fresh rule check, Payment API call, retry. *Done when:* tests pass for an Operator trying to approve, double approve, NC-1010 failure, and the API being down.
5. **Workflow engine** (plan mode). Triggers, conditions, actions (ticket via the API; refund via approval); execution log. *Done when:* the seeded "delayed and > ₹5,000" rule fires for NC-1016 but not NC-1006.
6. **Dashboard** from the DB: counts, issues, approvals, executions, activity, service health, Sync now. *Done when:* the counts match the data and the page loads with the mock stopped.
7. **Tests, hardening and a manual run** as all 3 users. Add the assistant only if 40+ minutes are left.
8. **Docs and submit.** README (setup, logins, API) by the agent; DECISIONS by you. Run setup and test on a fresh DB, then `/steerwise:submit`.

**Cut list if time is short:** the assistant first, then the audit page UI (the table stays), then search extras.
