// Customers: list with search, and one customer's view across orders, money, tickets and operations. Local DB only.
import { desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/server/db";
import { customers, operations, orders, payments, refunds } from "@/server/db/schema";
import { owedRefunds, unpaidShipped } from "./dashboard";
import { listOrders } from "./orders";
import { listTickets } from "./tickets";

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => "\\" + c);

// "Spent" = captured payments minus succeeded refunds: what the customer has actually paid us, net.
// customers.id spelled out: drizzle renders ${customers.id} unqualified, which is ambiguous inside the subqueries.
const spentMinor = sql<number>`coalesce((SELECT sum(p.amount_minor) FROM ${payments} p JOIN ${orders} o ON o.id = p.order_id
  WHERE o.customer_id = customers.id AND p.status = 'captured'), 0)
  - coalesce((SELECT sum(r.amount_minor) FROM ${refunds} r JOIN ${orders} o ON o.id = r.order_id
  WHERE o.customer_id = customers.id AND r.status = 'succeeded'), 0)`;

export function listCustomers(q?: string) {
  const p = q ? `%${escapeLike(q)}%` : null;
  return getDb()
    .select({
      id: customers.id,
      name: customers.name,
      email: customers.email,
      orderCount: sql<number>`(SELECT count(*) FROM ${orders} o WHERE o.customer_id = customers.id)`,
      spentMinor,
    })
    .from(customers)
    .where(p ? sql`(${customers.id} LIKE ${p} ESCAPE '\\' OR ${customers.name} LIKE ${p} ESCAPE '\\' OR ${customers.email} LIKE ${p} ESCAPE '\\')` : undefined)
    .orderBy(customers.name)
    .all();
}

export function getCustomerDetail(customerId: string) {
  const db = getDb();
  const customer = db.select().from(customers).where(eq(customers.id, customerId)).get();
  if (!customer) return null;
  const customerOrders = listOrders({ q: undefined, customerId, page: 1, pageSize: 1000 }).items;
  const ids = new Set(customerOrders.map((o) => o.id));
  // Same definitions as the dashboard's "Money at risk", narrowed to this customer.
  const owed = owedRefunds().orders.filter((o) => ids.has(o.orderId));
  const unpaid = unpaidShipped().orders.filter((o) => ids.has(o.orderId));
  const sum = (rows: { amountMinor: number }[]) => rows.reduce((s, r) => s + r.amountMinor, 0);
  return {
    customer,
    orders: customerOrders,
    spentMinor: db.select({ v: spentMinor }).from(customers).where(eq(customers.id, customerId)).get()!.v,
    moneyAtRisk: { owedMinor: sum(owed), unpaidMinor: sum(unpaid), totalMinor: sum(owed) + sum(unpaid), owed, unpaid },
    openTickets: listTickets({ customerId, status: "open" }).items,
    recentOperations: ids.size
      ? db.select().from(operations).where(inArray(operations.orderId, [...ids])).orderBy(desc(operations.id)).limit(10).all()
      : [],
  };
}
