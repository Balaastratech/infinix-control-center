"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatIst } from "@/lib/format";
import type { EventRow } from "@/server/services/dashboard";
import type { ServiceStatus } from "@/server/services/health";

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

  return (
    <>
      {error && <p className="error">Could not load integration data: {error}</p>}
      {loading && <p>Loading…</p>}

      {data && (
        <>
          <h2>Services</h2>
          <table>
            <thead>
              <tr>
                <th>Service</th>
                <th>Status</th>
                <th>Last sync</th>
                <th>Last OK</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {data.health.map((h) => (
                <tr key={h.service}>
                  <td>{h.service}</td>
                  <td className={h.status === "down" ? "error" : undefined}>{h.status}</td>
                  <td>{formatIst(h.lastSyncAt)}</td>
                  <td>{formatIst(h.lastOkAt)}</td>
                  <td>{h.lastError ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h2>Sync runs (last {data.syncRuns.length})</h2>
          {data.syncRuns.length === 0 ? (
            <p>No sync has run yet. Use Sync now on the dashboard.</p>
          ) : (
            <table>
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
                    <td>{formatIst(r.startedAt)}</td>
                    <td>{formatIst(r.finishedAt)}</td>
                    <td>{r.service}</td>
                    <td className={r.status === "failed" ? "error" : undefined}>{r.status}</td>
                    <td>
                      <small>{formatCounts(r.counts)}</small>
                    </td>
                    <td>{r.error ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h2>Webhook events</h2>
          <p>
            <select value={filters.status} onChange={(e) => set("status", e.target.value)}>
              <option value="">status: any</option>
              {data.eventStatuses.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>{" "}
            <select value={filters.type} onChange={(e) => set("type", e.target.value)}>
              <option value="">type: any</option>
              {data.eventTypes.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>{" "}
            <small>Rejected = wrong or missing X-Webhook-Secret (not stored as an event). Duplicates are not stored.</small>
          </p>
          {data.events.length === 0 ? (
            <p>No webhook events match.</p>
          ) : (
            <table>
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
                    <td>{formatIst(e.receivedAt)}</td>
                    <td>{e.status === "rejected" ? "-" : e.id}</td>
                    <td>{e.type}</td>
                    <td>{e.orderId ? <Link href={`/orders/${e.orderId}`}>{e.orderId}</Link> : "-"}</td>
                    <td>{formatIst(e.occurredAt)}</td>
                    <td className={e.status === "rejected" || e.status === "stale" ? "error" : undefined}>{e.status}</td>
                    <td>
                      <small>{e.note ?? "-"}</small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </>
  );
}
