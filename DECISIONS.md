# DECISIONS

How I built the NovaCommerce Operations Control Center, why, and what I left out. I built it with Claude Code as
my coding agent. I decided the scope, the rules and the order of work. I also checked each slice before moving on,
and pushed back when the agent's output was wrong or missed something. Every session is in the Steerwise upload.

## 1. The customer and what I optimised for

NovaCommerce's operations, finance and support teams each work in a separate system: orders (Commerce API),
payments (Payment API) and shipments (Shipping API). Before writing any code I read the sample data, and two numbers
told me what the real pain is:

- **11 cancelled orders still hold a captured payment with no refund: ₹1,37,750 owed to customers.**
- **4 orders were shipped or delivered with a failed payment: ₹51,250 of goods not paid for.**

Nobody sees these today because the facts sit in three systems. So my goal was not "a CRUD app over three APIs".
It was: **put the mismatches in front of the right team and let them fix them safely.** That's why the dashboard
opens with "Money at risk", and why there are work queues per team (Operations, Finance, Support).

Who uses it: NovaCommerce staff only (one company, not multi-tenant). Orders, customers and tickets are shared
company data; the role decides what you can *do*, not what you can see.

## 2. Architecture

- **One Next.js app (App Router, TypeScript)** with REST routes under `/api`. Routes are thin: validate input with
  zod → `requireRole` → call a service → JSON.
- **All business rules live in `src/server/services`**, never in the UI. The order page doesn't even decide which
  buttons to show: the server returns `allowedActions` (allowed + reason) from the same rule functions the routes
  use. I made this change after noticing the first UI version had copied the rules into the browser.
- **SQLite (better-sqlite3) + Drizzle**, with migrations. Why SQLite: the brief allows it, a reviewer can clone and
  run with zero setup and no external account, and it gives real transactions. The trade-off: it suits one server.
  With more than one app instance I'd move to PostgreSQL (Drizzle keeps that contained).
- **Money is integer paise everywhere** (₹5,000 = 500000). Shown as ₹ with 2 decimals; times stored in UTC, shown in IST.
- **Auth:** local login with seeded demo accounts (bcrypt hashes, iron-session cookie). The role is read from the
  database on every request, not trusted from the cookie, so demoting a user takes effect immediately.

## 3. Integrating the three services

I had the agent read `mock_services.py` as well as the API doc, because the code is the truth. It turned out to
differ from the doc in ways that matter:

- **Cancel is stricter than the brief:** the mock also refuses when the *shipment* is shipped, delayed or delivered.
  Our rule matches the mock, not just the brief.
- **A refund reply of HTTP 201 can still be a failed refund** (`status: "failed"`, always for NC-1010). We only
  count a refund as successful when the body says `succeeded`.
- Lookups take the **order id**, lists never paginate, only shipments have timestamps, refunds have **no
  idempotency key**, webhooks have **no signature**, and the mock forgets everything on restart.

The full contract and every quirk is in `docs/external-apis.md`.

**Sync** imports customers, orders, payments, shipments, refunds and tickets. Each service syncs in its own
transaction and writes a sync run row. If one service is down, the others still finish and the app keeps working
from local data, with a banner like "Payment API unreachable, data from 17:06 IST".

**Retries:** 3 attempts in total with backoff, only for network errors and 503. Never 400/404/409, which are real
answers. A 5 s timeout per attempt. **Refund POSTs are never retried blindly.** The agent found that the generic
client would have retried a refund after a timeout, which could pay twice. Before any second attempt we read
`GET /payments/refunds` and adopt an existing non-failed refund for that order and amount. Tickets work the same way.

**Health:** only list calls and network failures change a service's health. NC-1012's permanent 503 on one
shipment is that order's problem. It shows on the order page and does not mark Shipping "down". The first version
did mark it down, and I changed it because it would put a false outage on the dashboard every time someone opened
that order.

## 4. Keeping data consistent

- **Webhooks:** `POST /api/webhooks` needs a shared secret header (`X-Webhook-Secret`), validates the payload,
  and **dedupes on `event_id` in the database** (a repeat returns 200 and changes nothing). Unknown types are stored
  as ignored. Shipment events older than the stored `updated_at` are stored as stale and not applied (equal or newer
  applies). An event for an unknown order is stored as pending and applied after the next sync.
- **"Local ahead":** a webhook can be newer than what the mock knows (evt-003 cancels NC-1004 locally while the
  mock still says processing). When sync finds upstream differs from a value a webhook or our own action set, **we
  keep our value and show both** instead of silently overwriting. Our own successful cancel counts as a local change
  too, so a mock restart that forgets the cancel shows up as a difference instead of quietly reverting it.
  - Trade-off I accepted: once a row is marked local, a later real upstream change on it is *shown*, not applied
    automatically. For an ops tool I'd rather show a conflict to a person than guess.
- **Fixing a difference:** "Push cancel upstream" sends our cancel to the Commerce API for orders cancelled locally
  but still processing upstream. It doesn't fire workflows a second time. I added this when I saw that a
  webhook-cancelled order could never be refunded, because the mock refuses refunds for orders it thinks are processing.
- **Refund approval re-checks upstream:** on approve we read the live order and payment first. If upstream disagrees
  we don't call the Payment API; we say why ("upstream says processing; push cancel upstream first").

## 5. Business rules and permissions

| Action | Viewer | Operator | Manager |
|---|---|---|---|
| View everything | yes | yes | yes |
| Cancel, request refund, create ticket, sync, push cancel upstream | no | yes | yes |
| Approve or reject a refund | no | no | yes, never their own request |
| Create / edit / enable / disable workflows | no | no | yes |

- Enforced in every API route (401 not logged in, 403 wrong role) and tested by calling the real route handlers.
  The UI only hides buttons to match.
- **Refunds:** need a captured payment and a cancelled or delivered order. The amount must be above 0 and at most
  captured − refunds that didn't fail − amounts already in pending, approved or in-flight requests, so two requests
  can't both pass. Partial refunds are allowed; the default is the full refundable amount.
- **Every refund needs Manager approval before the Payment API is called**, including refunds started by a
  workflow or the assistant. Only one approval can win (a conditional `UPDATE … WHERE status = 'pending'`).
  A second Manager account exists so one Manager can approve another's request.
- **Cancels need no approval** (my decision: they don't move money; refunds do).
- **Audit log:** every consequential action records who, role, action, target and outcome, including refused attempts.

## 6. Workflow engine

A workflow is a trigger (payment failed, shipment updated, order cancelled) + one or more conditions (amount, order,
payment or shipment status) + an action (create a support ticket, or request a refund). Conditions are checked
against **stored data**, not the event body. Each workflow runs **at most once per event** (unique index), a failing
action never breaks the webhook reply, and every run is recorded (matched/skipped with the failing condition, and
succeeded/failed with the error).

- Workflows fire from webhooks and our own in-app actions, never from sync, so one change can't fire twice. A late
  (pending) webhook still fires when it's applied: it's still a real event.
- Two seeded rules: "Delayed high-value shipment" (delayed AND over ₹5,000 → support ticket; fires for NC-1016,
  skips NC-1006 at ₹3,250) and "Refund cancelled paid orders" (cancelled AND captured → refund request, which still
  goes to approval). The second one is the repetitive finance work the brief talks about.
- Only Managers can change workflows; everyone can see them and their runs.

## 7. Built for three teams

My first version was organised by feature (Orders, Approvals, Workflows). When I re-read the brief I saw it's really
about three teams, and I found a real gap: the dashboard told staff to "open a support ticket" for unpaid orders,
but nobody could create a ticket by hand. I added:

- **Work queues** per team. **Operations:** delayed shipments, lookup errors, local-ahead orders, failed syncs.
  **Finance:** owed refunds, unpaid shipments, pending approvals, failed refunds. **Support:** open tickets, orders
  with any problem.
- **Tickets** (list, and create by hand through the same safe code path the workflow uses) and **Customers**
  (a customer page with their orders, money at risk and tickets).

## 8. Operations assistant (optional module)

The brief says a paid LLM isn't required and the app must not need paid keys. My first version only understood 5
fixed phrases; when I tested it, anything else failed. I rebuilt it as a **hybrid** (design in `docs/assistant-design.md`):

- **A built-in parser, always on, no key:** order ids, customers, statuses with synonyms ("late" → delayed, "unpaid"
  → failed payment), amounts ("over 10k", "1.5 lakh"), dates, follow-ups ("which of those are over ₹10,000?").
  Every answer starts with "I understood: …" so a wrong guess is visible.
- **An optional AI layer** (Claude Sonnet, only when `ANTHROPIC_API_KEY` is set) for questions the parser can't
  place. It can only call our own 14 tools, as the logged-in user with their role.
- **It can't act.** Cancel, refund and ticket are only *proposed*. The user presses Confirm, which calls the normal
  routes with the normal checks. Refunds still go to approval.
- **Plain-language answers without AI:** every answer starts with a sentence built from the same rows as the tables (for example "11 cancelled orders still hold ₹1,37,750.00 that hasn't been refunded…"), and open questions like "what's our biggest problem" get a ranked briefing. I added this after seeing the standard answers were tables with no words.
- **It can't make things up.** Facts on screen come from the tool results as tables. The model's short summary is
  dropped if it mentions an order id, customer, amount or count that isn't in this question's results.
- **Prompt injection:** customer names, ticket reasons and webhook data are treated as data, never instructions.
  There's no tool that approves, executes or reads other people's chats, so a successful injection can at most
  produce a proposal a person must confirm. A red-team test suite drives a deliberately malicious fake model through
  these attacks and checks nothing executes or leaks.
- **Privacy:** conversations belong to the user *and* their browser, because reviewers share the demo logins.
  Kept 7 days, capped in size.
- **Cost:** the parser answers first, so most questions cost nothing. AI use is capped at 15 questions per user and
  60 per day in total, with a hard spend limit on the API workspace as a second safety net.

## 9. Live demo and security

- Deployed on my own server behind a Cloudflare Tunnel: no inbound ports open, HTTPS at the edge.
- The app runs as its own locked-down user with no shell, no access to other users' files, a read-only system,
  memory/CPU limits, and an egress firewall that only allows its own ports, DNS and outbound HTTPS. The API key
  and secrets live only in the server's environment, never in the repo or in a chat.
- Public-demo hardening: login rate limiting, HttpOnly + SameSite + Secure cookies, an Origin check on write
  requests (CSRF), and security headers.

## 10. Testing

Over 320 automated tests (Vitest; the external APIs are mocked with MSW, so tests never touch the real mock),
including failure cases: services down, 503 then success, retries capped at 3, 404 not retried, duplicate and stale
webhooks, wrong webhook secret, 201-but-failed refunds, double approvals, a Manager approving their own request, a
refund retry after a lost reply, the role matrix on every write route, conversation privacy and the red-team suite.
Every business rule in CLAUDE.md maps to at least one test. I also ran the app by hand as all four users.

## 11. Problems I hit and what I did

- The agent's plan included my own machine's coordination tooling (`busctl`), which has nothing to do with this
  project. I told it to drop that and added a rule to CLAUDE.md.
- A webhook-cancelled order could never be refunded → added "Push cancel upstream".
- NC-1012's 503 marked all of Shipping down → per-order lookup errors instead.
- The generic HTTP client would have blind-retried refunds → refund POSTs never retry; we check first.
- A generated migration would have failed on a database with existing approvals → the agent hand-fixed it and
  tested it on a populated database.
- I first told the agent "no styling work". The result was raw HTML that no ops team could use, so I reversed that
  with a design-token CSS system and no UI library.
- The first assistant was too narrow, and the first console missed the three-team view → both rebuilt (sections 7 and 8).
- Before submitting I had a separate model audit the whole project against the brief, report only. It found real
  things I then fixed:
  - A fresh Windows clone couldn't `npm install` (better-sqlite3 tried to compile) → `.npmrc` uses the shipped
    prebuilt binary; proved on a fresh clone.
  - Editing a disabled workflow silently re-enabled it.
  - Approve didn't refuse when *our* payment was failed but upstream still said captured.
  - A partly refunded order dropped off "Money at risk" → it now owes the remaining amount.
  - "refund 500 rupees" became a full refund in the assistant.
  - Raw JSON, paise and field names were showing to staff.
- Testing the live site by hand as all four roles, I sent a refund request with a misspelled field (`amountMinor`
  instead of `amount_minor`). It was silently ignored, and the request became a **full** refund. For an API that
  moves money that's dangerous, so every write route now rejects unknown fields with a 400 that names the field.
- Opening some pages swapped the whole screen, sidebar included, for a grey loading box, so the app felt like it
  was reloading. The sidebar and top bar now live in one shared layout, and each page's loading skeleton matches that page.
- I deliberately set the AI workspace spend limit very low, to see what a user gets when the AI runs out. The answer
  was "every reply says AI unavailable, every question still hits the API, and nobody can see why". So I added a
  circuit breaker (pause until the provider's reset time, no wasted calls, failed calls don't use the daily cap),
  quiet "Smart answer / Standard answer" labels instead of error text, and an Assistant status card on the
  Integrations page.

## 12. Known limitations and what's not done

- The mock keeps its data in memory. After a mock restart it forgets refunds, tickets and cancels that our database
  remembers. We show these as differences; a real integration would have durable upstream state.
- Malformed webhooks (400) aren't stored; duplicates aren't stored a second time.
- Login rate limits and the per-minute assistant limit are in memory: they reset on restart and assume one server.
- Logout clears the cookie but doesn't revoke the sealed session (a session version column would).
- Demo accounts are shared publicly, so "private" chats are private per browser, not per person.
- The production build downloads the Inter font, so it needs network access at build time.
- Single app instance on SQLite (see section 2).
- The AI assistant is the weakest part. Simple lookups and "which customer has the most money at risk" work well, but some
  comparison and "money out today" questions still fall back to a plain fact sentence (the router or the strict
  anti-fabrication check is too cautious), and heavy testing can use up a user's 15 smart answers for the day.
  Next step: a better router and grounding that understands comparisons.
- Sync is manual ("Sync now"); there's no scheduled sync. A service marked down stays down until the next good sync.
- One Manager can cancel a paid order, the seeded workflow then files the refund as "workflow", and the same Manager
  can approve it. That follows my rule (workflow requests can be approved by any Manager), but a stricter company
  would block the person who triggered the cancel from approving its refund.
- An `order.cancelled` webhook for an order we think is shipped is applied locally and stays "local ahead"; push
  cancel only works for orders upstream still has as processing. It needs a person to look at it.
- The public demo shares one database and published logins, so a visitor could change things before a reviewer
  arrives. A real deployment would have real accounts; a demo could reset nightly.
- Write requests must come from our own origin (CSRF check), so API scripts need an `Origin` header (README shows it).

## 13. What I'd do next / questions for NovaCommerce

- Should cancels need approval above some order value?
- Who owns the unpaid shipped orders: finance or support? Is there a way to retry a payment?
- Can the Payment API accept an idempotency key? Will real webhooks be signed and retried?
- Next technical steps: OR conditions and retry buttons for workflows, PostgreSQL for multiple instances, real SSO
  instead of demo accounts, durable rate limits.
