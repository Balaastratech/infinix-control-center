"use client";

import { useEffect, useState } from "react";
import { formatIst } from "@/lib/format";
import { auditActionLabel, auditDetailEntries, auditSummary, auditTargetLabel } from "@/lib/labels";
import { Alert, Badge, Empty, FilterSelect, Skeleton, TableWrap } from "../../ui";

interface Entry {
  id: number;
  at: string;
  actorLabel: string;
  role: string | null;
  action: string;
  target: string | null;
  outcome: string;
  detail: string | null;
}
interface Page {
  items: Entry[];
  total: number;
  page: number;
  pageSize: number;
  actions: string[];
  users: string[];
}

export function AuditLog() {
  const [filters, setFilters] = useState({ action: "", user: "" });
  const [page, setPage] = useState(1);
  // The result remembers which query it answers; loading = the current query has no result yet.
  const key = new URLSearchParams({ ...filters, page: String(page) }).toString();
  const [result, setResult] = useState<{ key: string; data?: Page; error?: string } | null>(null);
  const loading = result?.key !== key;
  const error = loading ? null : (result?.error ?? null);
  const data = result?.data ?? null; // keep showing the previous page while the next loads

  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`/api/audit?${key}`, { signal: ctrl.signal })
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

  const set = (field: "action" | "user", value: string) => {
    setFilters((f) => ({ ...f, [field]: value }));
    setPage(1);
  };
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <section className="card">
      <div className="toolbar">
        <FilterSelect label="Action" value={filters.action} options={data?.actions ?? []} onChange={(v) => set("action", v)} format={auditActionLabel} />
        <FilterSelect label="User" value={filters.user} options={data?.users ?? []} onChange={(v) => set("user", v)} format={(u) => u} />
      </div>

      {error && (
        <div className="card-body">
          <Alert tone="bad">Could not load the audit log: {error}</Alert>
        </div>
      )}
      {!data && loading && (
        <div className="card-body stack" aria-busy="true" aria-label="Loading">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} h={18} />
          ))}
        </div>
      )}
      {!loading && !error && data?.items.length === 0 && <Empty>No audit entries match.</Empty>}

      {data && data.items.length > 0 && (
        <TableWrap>
          <table className="compact" style={{ opacity: loading ? 0.6 : 1 }}>
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>Action</th>
                <th>Target</th>
                <th>Outcome</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((e) => (
                <tr key={e.id}>
                  <td className="nowrap">{formatIst(e.at)}</td>
                  <td>
                    {e.actorLabel}
                    <small>{e.role ?? "no role"}</small>
                  </td>
                  <td>{auditActionLabel(e.action)}</td>
                  <td>{auditTargetLabel(e.action, e.target)}</td>
                  <td>
                    <Badge status={e.outcome} />
                  </td>
                  <td style={{ maxWidth: 420, overflowWrap: "anywhere" }}>
                    {auditSummary(e.action, e.detail)}
                    {e.detail && (
                      <details>
                        <summary>details</summary>
                        <dl className="kv">
                          {auditDetailEntries(e.detail).map(([k, v], i) => (
                            <div key={i}>
                              <dt>{k}</dt>
                              <dd>{v}</dd>
                            </div>
                          ))}
                        </dl>
                      </details>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}

      {data && (
        <div className="card-foot">
          <span className="tabular">
            Page {data.page} of {pages} · {data.total} entries
          </span>
          <span className="row">
            <button className="sm" disabled={page <= 1 || loading} onClick={() => setPage(page - 1)}>
              ← Previous
            </button>
            <button className="sm" disabled={page >= pages || loading} onClick={() => setPage(page + 1)}>
              Next →
            </button>
          </span>
        </div>
      )}
    </section>
  );
}
