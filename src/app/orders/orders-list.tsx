"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { formatIst, formatMoney } from "@/lib/format";
import { Alert, Badge, Empty, FilterSelect, Skeleton, TableWrap, CustomerLink } from "../ui";

interface OrderRow {
  id: string;
  status: string;
  upstreamStatus: string | null;
  amountMinor: number;
  createdAt: string;
  customerId: string;
  customerName: string | null;
  customerEmail: string | null;
  paymentStatus: string | null;
  paymentUpstreamStatus: string | null;
  shipmentStatus: string | null;
  localAhead: boolean;
}
interface Page {
  items: OrderRow[];
  total: number;
  page: number;
  pageSize: number;
}

const FILTERS = {
  orderStatus: ["processing", "shipped", "delivered", "cancelled"],
  paymentStatus: ["captured", "failed"],
  shipmentStatus: ["pending", "shipped", "delayed", "delivered", "cancelled"],
} as const;
const FILTER_LABELS: Record<keyof typeof FILTERS, string> = { orderStatus: "Order status", paymentStatus: "Payment", shipmentStatus: "Shipment" };
const PAGE_SIZE = 25;

export function OrdersList() {
  // The URL is the state: filters and page are read from it (unknown values ignored) and written back with replaceState,
  // so a dashboard link, a reload or a shared link shows the same list.
  const params = useSearchParams();
  const filters: Record<string, string> = { q: params.get("q") ?? "", localAhead: params.get("localAhead") === "true" ? "true" : "" };
  for (const k of Object.keys(FILTERS) as (keyof typeof FILTERS)[]) {
    const v = params.get(k) ?? "";
    filters[k] = (FILTERS[k] as readonly string[]).includes(v) ? v : "";
  }
  const pageParam = Number(params.get("page"));
  const page = Number.isInteger(pageParam) && pageParam >= 1 ? pageParam : 1;
  // The result remembers which query it answers; loading = the current query has no result yet.
  const key = new URLSearchParams({ ...filters, page: String(page), pageSize: String(PAGE_SIZE) }).toString();
  const [result, setResult] = useState<{ key: string; data?: Page; error?: string } | null>(null);
  const loading = result?.key !== key;
  const error = loading ? null : (result?.error ?? null);
  const data = result?.data ?? null; // keep showing the previous page while the next loads

  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`/api/orders?${key}`, { signal: ctrl.signal })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        setResult({ key, data: body });
      })
      .catch((e: Error) => {
        if (e.name !== "AbortError") setResult({ key, error: e.message });
      });
    return () => ctrl.abort();
  }, [key]);

  const update = (changes: Record<string, string>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(changes)) {
      if (v && !(k === "page" && v === "1")) next.set(k, v);
      else next.delete(k);
    }
    const qs = next.toString();
    window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
  };
  const set = (key: string, value: string) => update({ [key]: value, page: "" });
  const setPage = (fn: (p: number) => number) => update({ page: String(fn(page)) });
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <section className="card">
      <div className="toolbar">
        <label className="field grow">
          <span>Search</span>
          <input type="search" placeholder="Order id, customer name or email" value={filters.q} onChange={(e) => set("q", e.target.value)} />
        </label>
        {(Object.keys(FILTERS) as (keyof typeof FILTERS)[]).map((key) => (
          <FilterSelect key={key} label={FILTER_LABELS[key]} value={filters[key]} options={FILTERS[key]} onChange={(v) => set(key, v)} />
        ))}
        <label className="check">
          <input type="checkbox" checked={filters.localAhead === "true"} onChange={(e) => set("localAhead", e.target.checked ? "true" : "")} /> Local ahead only
        </label>
      </div>

      {error && (
        <div className="card-body">
          <Alert tone="bad">Could not load orders: {error}</Alert>
        </div>
      )}
      {!data && loading && <SkeletonRows />}
      {!loading && !error && data?.items.length === 0 && <Empty>No orders match these filters.</Empty>}

      {data && data.items.length > 0 && (
        <TableWrap>
          <table style={{ opacity: loading ? 0.6 : 1 }}>
            <thead>
              <tr>
                <th>Order</th>
                <th>Customer</th>
                <th className="num">Amount</th>
                <th>Order</th>
                <th>Payment</th>
                <th>Shipment</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((o) => (
                <tr key={o.id}>
                  <td>
                    <Link href={`/orders/${o.id}`}>
                      <b>{o.id}</b>
                    </Link>
                  </td>
                  <td>
                    <CustomerLink id={o.customerId} name={o.customerName} />
                    <small>{o.customerEmail}</small>
                  </td>
                  <td className="num">{formatMoney(o.amountMinor)}</td>
                  <td>
                    <Badge status={o.status} />
                    {o.upstreamStatus && o.status !== o.upstreamStatus && <span className="badge-sub">local ahead · upstream {o.upstreamStatus}</span>}
                  </td>
                  <td>
                    <Badge status={o.paymentStatus} />
                    {o.paymentUpstreamStatus && o.paymentStatus !== o.paymentUpstreamStatus && (
                      <span className="badge-sub">local ahead · upstream {o.paymentUpstreamStatus}</span>
                    )}
                  </td>
                  <td>
                    <Badge status={o.shipmentStatus} />
                  </td>
                  <td className="nowrap">{formatIst(o.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}

      {data && (
        <div className="card-foot">
          <span className="tabular">
            Page {data.page} of {pages} · {data.total} orders
          </span>
          <span className="row">
            <button className="sm" disabled={page <= 1 || loading} onClick={() => setPage((p) => p - 1)}>
              ← Previous
            </button>
            <button className="sm" disabled={page >= pages || loading} onClick={() => setPage((p) => p + 1)}>
              Next →
            </button>
          </span>
        </div>
      )}
    </section>
  );
}

function SkeletonRows() {
  return (
    <div className="card-body stack" aria-busy="true" aria-label="Loading orders">
      {Array.from({ length: 8 }, (_, i) => (
        <Skeleton key={i} h={18} />
      ))}
    </div>
  );
}
