# External APIs (Commerce, Payment, Shipping)

Source of truth: `attachments/mock_services.py`. Where it differs from `attachments/api-documentation.md`, the code wins.

## Base

- `http://127.0.0.1:8765`, no auth, JSON bodies and replies. Money is integer paise.
- One Python process serves all three "services": if it is down, all three are down.
- Any path not listed below → `404 {"error":"unknown endpoint"}`.
- Query strings are ignored: no server-side filtering or pagination.
- Every call can also fail at network level: connection refused (mock not running), timeout (our 5 s), connection reset.

## Endpoints we call

| Method | Path | We use it for | Replies (code → body) |
|---|---|---|---|
| GET | /health | Liveness probe for the status badge (one probe covers all 3 services) | 200 `{ok:true}` |
| GET | /commerce/customers | Sync customers | 200 array |
| GET | /commerce/orders | Sync orders | 200 array |
| GET | /commerce/orders/{order_id} | Fresh re-read before cancel and on refund approve | 200 order · 404 `not found` |
| POST | /commerce/orders/{order_id}/cancel | Cancel an order (body `{}`) | 200 updated order (also 200 if already cancelled) · 400 `invalid JSON object` · 404 `unknown order` · 409 `already shipped` |
| GET | /payments/transactions | Sync payments | 200 array |
| GET | /payments/transactions/{order_id} | Fresh re-read of the payment on approve (keyed by **order id**, not P-id) | 200 payment · 404 `not found` |
| POST | /payments/refunds | Execute an approved refund, body `{order_id, amount_minor}` | 201 refund `{id, order_id, amount_minor, currency, status: succeeded\|failed}` · 400 `invalid JSON object` · 400 `invalid amount` · 404 `unknown order` · 409 `ineligible refund` · 409 `refund exceeds captured amount` |
| GET | /payments/refunds | Sync refunds; pre-retry check for a refund that may already exist | 200 array (empty after mock restart) |
| GET | /payments/refunds/{refund_id} | Confirm one refund's final status | 200 refund · 404 `not found` |
| GET | /shipping/shipments | Sync shipments | 200 array |
| GET | /shipping/shipments/{order_id} | Fresh shipment read before cancel / order detail | 200 shipment · 404 `not found` · **503 `carrier temporarily unavailable` (always, for NC-1012)** |
| POST | /commerce/tickets | Create a support ticket (workflow action / manual), body `{order_id, reason}` | 201 ticket `{id, order_id, reason, status:"open"}` · 400 `invalid JSON object` · 400 `order_id and reason required` |
| GET | /commerce/tickets | Sync tickets; pre-retry check for a duplicate ticket | 200 array (empty after mock restart) |

Not offered by the mock: GET customer by id, GET ticket by id, any update to shipments or payments, any
PUT/PATCH/DELETE (those return **501 with an HTML body**, not JSON).

Value sets seen in the data and code:
- Order status: `processing`, `shipped`, `delivered`, `cancelled`
- Payment status: `captured`, `failed`
- Shipment status: `pending`, `shipped`, `delayed`, `delivered`, `cancelled`
- Refund status: `succeeded`, `failed`
- Ticket status: `open`

## Where the mock differs from the brief, or a reply can mislead us

### Stricter or different from the brief

1. Refund checks run in this order: 404 → 409 eligibility → 400 amount → 409 cap. A bad amount on an ineligible
   order comes back as 409, not 400.
2. `amount_minor` must be a JSON integer: `500.0`, `"500"` and `true` are all `400 invalid amount`.
3. Mock cap = captured − non-failed refunds. It does not know our pending/approved requests; our cap (also minus
   those) is stricter and we must enforce it ourselves.
4. Mock refund eligibility reads **its own** order status. A cancel we only got from a webhook (e.g. evt-003 for
   NC-1004) is unknown upstream → `409 ineligible refund`.
5. Cancel does nothing to the payment or the shipment: after our cancel the payment stays `captured` (a new
   "money owed" row) and the shipment stays `pending`.
6. Cancelling an already-cancelled order returns 200 again (safe to retry, no 409).
7. The cancel 409 says `already shipped` even when the reason is a **delayed** shipment.
8. Refunds never change the payment: no `refunded` status, no `refunded_minor` field. "Refunded so far" must be
   summed from `/payments/refunds`.
9. Shipments never change upstream (no endpoint) and `updated_at` is fixed; only webhooks move them. Orders and
   payments have no timestamps at all.
10. State is in memory: restarting the mock reverts cancels and forgets every refund and ticket. Our DB is then
    **ahead** of upstream.
11. Shipment statuses include `pending` and `cancelled`, which the brief does not name.
12. `/health` is one probe for all three services; per-service health must come from each service's own calls.

### Replies that can mislead us

13. `201` from POST /payments/refunds with `status:"failed"` (always for NC-1010) is a failure. It does not count
    against the cap, so a retry creates another failed refund upstream.
14. The `503` for NC-1012's single-shipment lookup is permanent, not transient: 3 retries always fail. The list
    endpoint returns NC-1012 fine.
15. `404` means both "no such record" (`not found` / `unknown order`) and "wrong path" (`unknown endpoint`); only
    the error text tells them apart.
16. POST /payments/refunds with a missing `order_id` returns `404 unknown order`, not 400.
17. An `order_id` that is an array or object crashes the handler: the socket closes with no reply, which looks like a
    **network error** and would be retried. Validate before sending.
18. Invalid JSON is rejected **before** the path is checked: a bad body to an unknown POST path gives 400, not 404.
19. Query strings are silently ignored: `/commerce/orders?status=cancelled` returns all 60 orders.
20. Refunds and tickets have no idempotency key: a timeout after the mock processed the POST plus a blind retry means
    a double refund or a duplicate ticket. Check the list endpoint first.
21. Unsupported methods return 501 with HTML; parsing it as JSON throws. Treat it as a non-retryable error.
