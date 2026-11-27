"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatIst } from "@/lib/format";
import { statusLabel } from "@/lib/labels";
import type { EventRow } from "@/server/services/dashboard";
import type { ServiceStatus } from "@/server/services/health";
import { Alert, Badge, Card, Empty, FilterSelect, SkeletonCard, TableWrap } from "../ui";

interface SyncRun {
  id: number;
  service: string;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  counts: string | null;
  error: string | null;
}
interface Data {
  health: ServiceStatus[];
  syncRuns: SyncRun[];
  events: EventRow[];
  eventTypes: string[];
  eventStatuses: string[];
}

const SERVICE_NAMES: Record<string, string> = { commerce: "Commerce API", payments: "Payment API", shipping: "Shipping API" };

// "{"orders":60,"payments":60}" -> "orders 60, payments 60"
const formatCounts = (json: string | null) => {
  if (!json) return "-";
  try {
    return Object.entries(JSON.parse(json) as Record<string, unknown>)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ");
  } catch {
    return json;
  }
};

export function IntegrationsView() {
  const [filters, setFilters] = useState({ status: "", type: "" });
  const key = new URLSearchParams(filters).toString();
  // The result remembers which query it answers; loading = the current query has no result yet.
  const [result, setResult] = useState<{ key: string; data?: Data; error?: string } | null>(null);
  const loading = result?.key !== key;
  const error = loading ? null : (result?.error ?? null);
  const data = result?.data ?? null;

  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`/api/integrations?${key}`, { signal: ctrl.signal })
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

  const set = (field: "status" | "type", value: string) => setFilters((f) => ({ ...f, [field]: value }));

  if (error && !data) return <Alert tone="bad">Could not load integration data: {error}</Alert>;
  if (!data) return <SkeletonCard rows={5} />;

  return (
    <>
      {error && <Alert tone="bad">Could not refresh: {error}</Alert>}
      <Card title="Services">
        <div className="health">
          {data.health.map((h) => (
            <div key={h.service} className={`service${h.status === "down" ? " down" : ""}`}>
              <span className="service-name">
                {SERVICE_NAMES[h.service] ?? h.service} <Badge status={h.status} />
              </span>
              <span className="small muted">Last sync {formatIst(h.lastSyncAt)}</span>
              <span className="small muted">Last OK {formatIst(h.lastOkAt)}</span>
              {h.lastError && <span className="small error">{h.lastError}</span>}
            </div>
          ))}
        </div>
      </Card>

      <Card title="Sync runs" count={data.syncRuns.length} flush>
        {data.syncRuns.length === 0 ? (
          <Empty>No sync has run yet. Use Sync now on the dashboard.</Empty>
        ) : (
          <TableWrap>
            <table className="compact">
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Finished</th>
                  <th>Service</th>
                  <th>Status</th>
                  <th>Counts</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {data.syncRuns.map((r) => (
                  <tr key={r.id}>
                    <td className="nowrap">{formatIst(r.startedAt)}</td>
                    <td className="nowrap">{formatIst(r.finishedAt)}</td>
                    <td>{SERVICE_NAMES[r.service] ?? r.service}</td>
                    <td>
                      <Badge status={r.status} />
                    </td>
                    <td>
                      <small>{formatCounts(r.counts)}</small>
                    </td>
                    <td className={r.error ? "error" : "muted"}>{r.error ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      <section className="card">
        <div className="card-head">
          <h2>
            Webhook events <span className="count">{data.events.length}</span>
          </h2>
          <span className="muted small">Rejected = wrong or missing X-Webhook-Secret (audited, not stored). Duplicates are not stored.</span>
        </div>
        <div className="toolbar">
          <FilterSelect label="Status" value={filters.status} options={data.eventStatuses} onChange={(v) => set("status", v)} />
          <FilterSelect label="Type" value={filters.type} options={data.eventTypes} onChange={(v) => set("type", v)} />
        </div>
        {data.events.length === 0 ? (
          <Empty>No webhook events match.</Empty>
        ) : (
          <TableWrap>
            <table className="compact" style={{ opacity: loading ? 0.6 : 1 }}>
              <thead>
                <tr>
                  <th>Received</th>
                  <th>Event</th>
                  <th>Type</th>
                  <th>Order</th>
                  <th>Occurred</th>
                  <th>Status</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {data.events.map((e) => (
                  <tr key={e.id}>
                    <td className="nowrap">{formatIst(e.receivedAt)}</td>
                    <td className="mono">{e.status === "rejected" ? "-" : e.id}</td>
                    <td>{statusLabel(e.type)}</td>
                    <td>{e.orderId ? <Link href={`/orders/${e.orderId}`}>{e.orderId}</Link> : "-"}</td>
                    <td className="nowrap">{formatIst(e.occurredAt)}</td>
                    <td>
                      <Badge status={e.status} />
                    </td>
                    <td style={{ maxWidth: 320, overflowWrap: "anywhere" }}>
                      <small>{e.note ?? "-"}</small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </section>
    </>
  );
}
