# NovaCommerce Operations Control Center

One internal app for NovaCommerce's **operations, finance and support** teams. Today orders live in the Commerce API, payments in the Payment API and shipments in the Shipping API, and the teams switch tools all day, reconcile by hand and approve refunds in chat. This app syncs all three systems into one place. It enforces the business rules on the server (no cancelling shipped orders, every refund approved by a Manager before money moves, state taken only from the upstream reply) and shows money at risk on the dashboard: cancelled orders still holding a captured payment, and shipped orders that were never paid. Each team gets its own work queue, and workflows automate the repetitive steps. It stays usable when an upstream service is down and keeps an audit log of every consequential action.

**Live:** https://novaops.balaastratech.com

## Demo logins

All four use the password `demo1234`.

| Email | Role | Can |
|---|---|---|
| `viewer@nova.test` | Viewer | read everything |
| `operator@nova.test` | Operator | + cancel orders, request refunds, create tickets, Sync now |
| `manager@nova.test` | Manager | + approve/reject refunds (never their own request), edit workflows |
| `manager2@nova.test` | Manager | a second Manager, to approve requests made by `manager@` |

## Run it locally

Needs **Node 24** and **Python 3** (for the mock services). No accounts or paid keys are needed.

```bash
npm install
python attachments/mock_services.py      # terminal 1: Commerce, Payment and Shipping APIs on http://127.0.0.1:8765
npm run setup                            # creates .env.local with random secrets (if missing), migrates, seeds users + workflows
npm run dev                              # terminal 2: http://localhost:3000
npm test                                 # Vitest: rules, roles, sync, webhooks, workflows, assistant, red-team, security
```

Log in, then press **Sync now** on the dashboard to pull data from the mock. `npm run setup` is safe to run again; it never deletes data.

## Configuration

All settings come from environment variables with local defaults (see `.env.example`). `npm run setup` writes `.env.local` and generates the two secrets.

| Variable | Default | What it is |
|---|---|---|
| `SESSION_SECRET` | generated | Seals the session cookie (≥ 32 chars). |
| `WEBHOOK_SECRET` | generated | Callers of `POST /api/webhooks` send it as `X-Webhook-Secret`. |
| `DATABASE_PATH` | `./data/app.db` | SQLite file. |
| `MOCK_BASE_URL` | `http://127.0.0.1:8765` | Base URL of the three upstream APIs. |
| `PORT` | `3000` | Read from the process env (`PORT=4000 npm start`), not from `.env` files. |
| `APP_ORIGIN` | unset | Production only: the public origin, allowed by the CSRF check when a proxy rewrites `Host`. |
| `ANTHROPIC_API_KEY` | unset | **Optional.** Turns on the assistant's AI layer. Set it only in the server's environment. Without it the assistant uses its built-in parser and everything still works. |
| `ASSISTANT_AI` | `on` | Kill switch: `off` disables the AI layer even with a key. |
| `ASSISTANT_MODEL` | `claude-sonnet-5-5` | Model for the AI layer. |
| `ASSISTANT_GLOBAL_DAILY` / `ASSISTANT_USER_DAILY` | `60` / `15` | Daily AI question caps (IST day). The built-in parser is never capped. |
| `ASSISTANT_RETENTION_DAYS`, `ASSISTANT_MAX_MESSAGES`, `ASSISTANT_MAX_CONVERSATIONS`, `ASSISTANT_MAX_CHARS` | `7`, `20`, `20`, `500` | Assistant conversation limits. |

## Sending the sample webhooks

The three sample events are in `attachments/webhook_examples.json`. Send them with the secret from `.env.local`:

```bash
SECRET=$(grep '^WEBHOOK_SECRET=' .env.local | cut -d= -f2)

curl -s -X POST http://localhost:3000/api/webhooks -H "Content-Type: application/json" -H "X-Webhook-Secret: $SECRET" \
  -d '{"event_id":"evt-001","type":"shipment.updated","occurred_at":"2026-11-22T10:00:00Z","order_id":"NC-1001","data":{"status":"delayed"}}'

curl -s -X POST http://localhost:3000/api/webhooks -H "Content-Type: application/json" -H "X-Webhook-Secret: $SECRET" \
  -d '{"event_id":"evt-002","type":"payment.failed","occurred_at":"2026-11-22T10:05:00Z","order_id":"NC-1007","data":{"status":"failed"}}'

curl -s -X POST http://localhost:3000/api/webhooks -H "Content-Type: application/json" -H "X-Webhook-Secret: $SECRET" \
  -d '{"event_id":"evt-003","type":"order.cancelled","occurred_at":"2026-11-22T10:10:00Z","order_id":"NC-1004","data":{"status":"cancelled"}}'
```

Sending the same event again returns `{"status":"duplicate"}` and changes nothing. A missing or wrong secret gets a 401, and the attempt is logged.

## API

All routes are under `/api` and return JSON. Money is integer **paise** (₹5,000 = `500000`); times are UTC ISO-8601.

**Rules for every route:**
- **Auth:** a session cookie from `POST /api/auth/login`. Role is read from the database on every request.
- **Common errors:**
  - `400 {"error":"invalid request","issues":[…]}`: bad body or query.
  - `401 {"error":"not logged in"}`.
  - `403 {"error":"role viewer cannot do this"}`: wrong role.
  - `403 {"error":"cross-site request refused"}`: a POST/PATCH/DELETE without a matching `Origin` header. Scripts must send `Origin: <base url>`; webhooks are exempt.
- **Roles column:** V = Viewer, O = Operator, M = Manager.

### Auth

| Method | Path | Role | Body | Replies |
|---|---|---|---|---|
| POST | `/api/auth/login` | public | `{ "email", "password" }` | `200 { user: { id, email, role } }` + session cookie (HttpOnly, SameSite=Lax, Secure in production, 8 h) · `401 invalid email or password` · `429` after 5 failures per IP+email or 20 per IP in 15 min (`Retry-After` header) |
| POST | `/api/auth/logout` | public | none | `200 { ok: true }`, cookie cleared |
| GET | `/api/me` | V O M | none | `200 { user: { id, email, role } }` |

### Orders

| Method | Path | Role | Body / query | Replies |
|---|---|---|---|---|
| GET | `/api/orders` | V O M | query: `q` (id, customer name or email), `orderStatus`, `paymentStatus`, `shipmentStatus`, `localAhead=true`, `page`, `pageSize` (≤ 100) | `200 { items: [{ id, status, upstreamStatus, amountMinor, customerName, paymentStatus, shipmentStatus, localAhead, … }], total, page, pageSize }` |
| GET | `/api/orders/:id` | V O M | none | `200 { order, actions, customer, payment, refundPosition, refunds, shipment, shippingError, operations, tickets, events }`, where `actions` lists what is allowed now and why not. Local data; a failed live shipment lookup comes back as `shippingError`, never a 5xx · `400 invalid order id` · `404 unknown order` |
| POST | `/api/orders/:id/cancel` | O M | none | `200 { ok, operationId, status }` (cancelled through the Commerce API) · `409` refused by a rule, e.g. shipped (no API call) · `404` · `502` Commerce API refused or unreachable (`{ error, operationId, upstreamStatus }`) |
| POST | `/api/orders/:id/reconcile-cancel` | O M | none | Pushes a local (webhook) cancel to the Commerce API. `200` upstream agrees · `409` not in that state · `404` · `502` |
| POST | `/api/orders/:id/refund-requests` | O M | `{ "amount_minor"?: int }` (omit for the full refundable amount) | `201 { ok, operationId, approvalId, amountMinor }`: pending Manager approval; the Payment API is **not** called · `409` refused (no captured payment, wrong status, amount above refundable) · `404` |
| POST | `/api/orders/:id/tickets` | O M | `{ "reason": string (1–500) }` | `201 { ok, ticketId, how }` · `404` unknown order · `502` Commerce API refused or unreachable |
| POST | `/api/refund-requests/bulk` | O M | none | `200 { created, skipped, orderIds }`: one pending approval per owed order; orders with an open request are skipped |

### Approvals (refunds)

| Method | Path | Role | Body | Replies |
|---|---|---|---|---|
| GET | `/api/approvals` | V O M | none | `200 { items: [{ id, status, orderId, amountMinor, requestedByLabel, decidedBy, operationStatus, error, … }] }` |
| POST | `/api/approvals/:id/approve` | M | none | Re-reads the order and payment upstream, re-checks the rule, then calls the Payment API. `200 { ok, approvalId, operationId, status, error, externalId }`: read `status`, since a refused re-check or a `status: "failed"` refund reply is still a decided 200 · `403` your own request · `404` · `409 already decided` |
| POST | `/api/approvals/:id/reject` | M | `{ "note": string (1–500) }` | `200 { ok, approvalId, status: "rejected" }` · `403` own request · `404` · `409 already decided` |
| POST | `/api/approvals/:id/retry` | M | none | Retries a failed refund after checking `GET /payments/refunds` for that order (no double refund). `200` final status · `404` · `409` nothing to retry |

### Customers, tickets, queues, dashboard

| Method | Path | Role | Query | Replies |
|---|---|---|---|---|
| GET | `/api/customers` | V O M | `q` | `200 { items: [{ id, name, email, orderCount, spentMinor }] }` |
| GET | `/api/customers/:id` | V O M | none | `200 { customer, orders, spentMinor, moneyAtRisk, openTickets, recentOperations }` · `404 unknown customer` |
| GET | `/api/tickets` | V O M | `status`, `orderId` | `200 { items: [{ id, orderId, reason, status, customerName, createdByLabel, … }] }` |
| GET | `/api/queues` | V O M | none | `200 { operations, finance, support }`, each `{ count, items }` |
| GET | `/api/dashboard` | V O M | none | `200 { orders, moneyAtRisk, paymentIssues, shipmentIssues, pendingApprovals, recentExecutions, recentOperations, recentAudit, localAhead, health }`. Local data only, so it works with every upstream down |

### Sync, health, integrations, audit

| Method | Path | Role | Body / query | Replies |
|---|---|---|---|---|
| POST | `/api/sync` | O M | none | `200 { services: [{ service, status, counts, error }], pendingApplied }`: always 200; a down service shows as `failed` in the report |
| GET | `/api/health` | public | none | `200 { services: [{ service, status: ok/down/unknown, lastOkAt, lastError, lastSyncAt, lastSyncStatus }] }` |
| GET | `/api/integrations` | V O M | `status` (applied, stale, pending, ignored, rejected), `type` | `200 { health, syncRuns, events, eventTypes, eventStatuses }` |
| GET | `/api/audit` | V O M | `action`, `user`, `page`, `pageSize` (≤ 100) | `200 { items: [{ at, actorLabel, role, action, target, outcome, detail }], total, page, pageSize, actions, users }` |

### Webhooks

| Method | Path | Auth | Body | Replies |
|---|---|---|---|---|
| POST | `/api/webhooks` | header `X-Webhook-Secret` | `{ event_id, type, occurred_at, order_id, data: { status } }` | `200 { event_id, status }`, where status is `applied`, `duplicate` (seen before, no change), `stale` (shipment event older than the row), `pending` (unknown order, applied after the next sync) or `ignored` (unknown type) · `400` malformed or a status the type doesn't allow · `401 invalid webhook secret` |

### Workflows

| Method | Path | Role | Body | Replies |
|---|---|---|---|---|
| GET | `/api/workflows` | V O M | none | `200 { items: [{ id, name, trigger, conditions, action, enabled, … }] }` |
| POST | `/api/workflows` | M | `{ name, trigger: payment.failed / shipment.updated / order.cancelled, conditions: [{ field: amount_minor / order_status / payment_status / shipment_status, op: eq / neq / gt / gte / lt / lte, value }] (1–10), action: { type: "create_ticket", reason } or { type: "request_refund", amount_minor? }, enabled? }` | `201` workflow · `400` bad field/op/value or unknown `{placeholder}` · `409` name taken |
| PATCH | `/api/workflows/:id` | M | any subset of the POST fields; `{ "enabled": false }` disables | `200` workflow · `400` · `404` · `409` name taken |
| GET | `/api/workflows/:id/executions` | V O M | none | `200 { items: [{ eventId, orderId, matched, outcome, result, error, ranAt }] }` (last 100) |

Workflow refunds still go to Manager approval. Workflows fire from webhooks and in-app actions, never from sync.

### Assistant

Conversations belong to the logged-in user **in this browser** (an HttpOnly `nova_asst_dev` cookie, set on first use). Any other user or browser gets 404. Answers come from the built-in parser, and from the optional AI layer for questions the parser can't place. Actions are only **proposed**: the card's Confirm button calls the order routes above, as you.

| Method | Path | Role | Body | Replies |
|---|---|---|---|---|
| GET | `/api/assistant/conversations` | V O M | none | `200 { conversations: [{ id, title, updatedAt }], maxChars }` |
| POST | `/api/assistant/conversations` | V O M | `{ "text": string (1–500) }` | Starts a conversation with its first question. `200 { ok, conversationId, answer: { text, mode: parser/ai/fallback, intent, understood, blocks, suggestions?, notice?, context }, droppedOldest? }` · `429` more than 20 questions a minute |
| GET | `/api/assistant/conversations/:id` | V O M | none | `200 { id, title, messages }` · `404` not yours |
| PATCH | `/api/assistant/conversations/:id` | V O M | `{ "title": string (1–60) }` | `200 { ok: true }` · `404` |
| DELETE | `/api/assistant/conversations/:id` | V O M | none | `200 { ok: true }` · `404` |
| POST | `/api/assistant/conversations/:id/messages` | V O M | `{ "text": string (1–500) }` | `200` as above · `404` not yours · `409` conversation full (20 messages) · `429` |

Before the AI layer goes on for a deployment, run the live red-team against it: `npm run redteam:live -- https://novaops.balaastratech.com`. It sends hostile prompts as the demo users and fails on any leak or action.

## More docs

- [docs/external-apis.md](docs/external-apis.md): the Commerce, Payment and Shipping API contract and where the mock differs from the brief.
- [docs/assistant-design.md](docs/assistant-design.md): the operations assistant: privacy, parser, AI layer, guardrails, red-team suite, security hardening, and what was built.
