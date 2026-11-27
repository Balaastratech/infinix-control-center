"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { formatIst, formatMoney } from "@/lib/format";

interface OrderRow {
  id: string;
  status: string;
  upstreamStatus: string | null;
  amountMinor: number;
  createdAt: string;
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
    <>
      <p>
        <input placeholder="Order id, customer name or email" value={filters.q} onChange={(e) => set("q", e.target.value)} size={32} />{" "}
        {(Object.keys(FILTERS) as (keyof typeof FILTERS)[]).map((key) => (
          <select key={key} value={filters[key]} onChange={(e) => set(key, e.target.value)}>
            <option value="">{key.replace("Status", "")}: any</option>
            {FILTERS[key].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        ))}{" "}
        <label>
          <input type="checkbox" checked={filters.localAhead === "true"} onChange={(e) => set("localAhead", e.target.checked ? "true" : "")} /> local
          ahead only
        </label>
      </p>

      {error && <p className="error">Could not load orders: {error}</p>}
      {loading && <p>Loading…</p>}
      {!loading && !error && data?.items.length === 0 && <p>No orders match.</p>}

      {data && data.items.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Order</th>
              <th>Customer</th>
              <th>Amount</th>
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
                  <Link href={`/orders/${o.id}`}>{o.id}</Link>
                </td>
                <td>
                  {o.customerName}
                  <br />
                  <small>{o.customerEmail}</small>
                </td>
                <td>{formatMoney(o.amountMinor)}</td>
                <td>
                  {o.status}
                  {o.status !== o.upstreamStatus && <small> (local ahead; upstream: {o.upstreamStatus})</small>}
                </td>
                <td>
                  {o.paymentStatus ?? "-"}
                  {o.paymentStatus !== o.paymentUpstreamStatus && <small> (local ahead; upstream: {o.paymentUpstreamStatus})</small>}
                </td>
                <td>{o.shipmentStatus ?? "-"}</td>
                <td>{formatIst(o.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {data && (
        <p>
          <button disabled={page <= 1 || loading} onClick={() => setPage((p) => p - 1)}>
            Previous
          </button>{" "}
          Page {data.page} of {pages} ({data.total} orders){" "}
          <button disabled={page >= pages || loading} onClick={() => setPage((p) => p + 1)}>
            Next
          </button>
        </p>
      )}
    </>
  );
}
