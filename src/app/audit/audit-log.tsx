"use client";

import { useEffect, useState } from "react";
import { formatIst } from "@/lib/format";

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
    <>
      <p>
        <select value={filters.action} onChange={(e) => set("action", e.target.value)}>
          <option value="">action: any</option>
          {data?.actions.map((a) => (
            <option key={a}>{a}</option>
          ))}
        </select>{" "}
        <select value={filters.user} onChange={(e) => set("user", e.target.value)}>
          <option value="">user: any</option>
          {data?.users.map((u) => (
            <option key={u}>{u}</option>
          ))}
        </select>
      </p>

      {error && <p className="error">Could not load the audit log: {error}</p>}
      {loading && <p>Loading…</p>}
      {!loading && !error && data?.items.length === 0 && <p>No audit entries match.</p>}

      {data && data.items.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Who</th>
              <th>Role</th>
              <th>Action</th>
              <th>Target</th>
              <th>Outcome</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((e) => (
              <tr key={e.id}>
                <td>{formatIst(e.at)}</td>
                <td>{e.actorLabel}</td>
                <td>{e.role ?? "-"}</td>
                <td>{e.action}</td>
                <td>{e.target ?? "-"}</td>
                <td>{e.outcome}</td>
                <td>
                  <small>{e.detail ?? "-"}</small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {data && (
        <p>
          Page {data.page} of {pages} ({data.total} entries){" "}
          <button disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Previous
          </button>{" "}
          <button disabled={page >= pages} onClick={() => setPage(page + 1)}>
            Next
          </button>
        </p>
      )}
    </>
  );
}
