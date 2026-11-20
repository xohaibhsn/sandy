"use client";

import { useCallback, useEffect, useState } from "react";
import { adminRequest } from "@/lib/adminRequest";
import AdminBanner from "./AdminBanner";

type AuditRow = {
  id: number;
  created_at: string;
  actor_type: string;
  actor_staff_id: number | null;
  actor_name: string | null;
  actor_role: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  summary: string;
  detail_json: string | null;
  user_agent?: string | null;
  request_id?: string | null;
};

type ListPayload = {
  rows?: AuditRow[];
  total?: number;
  page?: number;
  limit?: number;
};

const inputStyle: React.CSSProperties = {
  padding: "8px 10px",
  border: "1px solid #E5E5E5",
  borderRadius: 8,
  fontSize: 13,
  background: "#fff",
  color: "#111",
  width: "100%",
};

function fmtWhen(v: string): string {
  const d = new Date(v);
  return Number.isFinite(d.getTime())
    ? d.toLocaleString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        timeZone: "UTC",
      }) + " UTC"
    : "—";
}

function parseDetail(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export default function ActivityLogPanel() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [limit] = useState(25);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [drawer, setDrawer] = useState<AuditRow | null>(null);

  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [actor, setActor] = useState("");
  const [entityType, setEntityType] = useState("");
  const [action, setAction] = useState("");
  const [q, setQ] = useState("");

  const buildQuery = useCallback(
    (pageNum: number, forExport = false) => {
      const p = new URLSearchParams();
      if (forExport) p.set("export", "csv");
      else {
        p.set("page", String(pageNum));
        p.set("limit", String(limit));
      }
      if (from.trim()) p.set("from", from.trim());
      if (to.trim()) p.set("to", to.trim());
      if (actor.trim()) p.set("actor", actor.trim());
      if (entityType.trim()) p.set("entity_type", entityType.trim());
      if (action.trim()) p.set("action", action.trim());
      if (q.trim()) p.set("q", q.trim());
      return p.toString();
    },
    [from, to, actor, entityType, action, q, limit]
  );

  const load = useCallback(
    async (pageNum = 1) => {
      setBusy(true);
      setLoadError("");
      const res = await adminRequest<ListPayload>(
        `/api/admin-audit-log?${buildQuery(pageNum)}`,
        undefined,
        { expectSuccess: false }
      );
      setBusy(false);
      if (!res.ok) {
        setLoadError(res.errorMessage || "Could not load activity log.");
        setRows([]);
        setTotal(0);
        return false;
      }
      setRows(Array.isArray(res.data?.rows) ? res.data!.rows! : []);
      setTotal(Number(res.data?.total || 0));
      setPage(Number(res.data?.page || pageNum));
      return true;
    },
    [buildQuery]
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await adminRequest<ListPayload>(
        `/api/admin-audit-log?${buildQuery(1)}`,
        undefined,
        { expectSuccess: false }
      );
      if (cancelled) return;
      if (!res.ok) {
        setLoadError(res.errorMessage || "Could not load activity log.");
        setRows([]);
        setTotal(0);
        return;
      }
      setLoadError("");
      setRows(Array.isArray(res.data?.rows) ? res.data!.rows! : []);
      setTotal(Number(res.data?.total || 0));
      setPage(Number(res.data?.page || 1));
    })();
    return () => {
      cancelled = true;
    };
  }, [buildQuery]);

  const onApplyFilters = () => {
    void load(1);
  };

  const onExport = async () => {
    setBusy(true);
    setLoadError("");
    try {
      const res = await fetch(`/api/admin-audit-log?${buildQuery(1, true)}`, {
        method: "GET",
        credentials: "same-origin",
      });
      if (!res.ok) {
        setLoadError(res.status === 403 ? "Forbidden" : "Could not export CSV.");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "sandy-audit-log.csv";
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setLoadError("Could not export CSV.");
    } finally {
      setBusy(false);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div data-activity-log="1">
      {loadError && (
        <AdminBanner message={loadError} tone="error" onRetry={() => { void load(page); }} />
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
          gap: 10,
          marginBottom: 14,
        }}
      >
        <div>
          <label style={{ fontSize: 11, color: "#666" }} htmlFor="aal-from">From (UTC)</label>
          <input id="aal-from" type="datetime-local" style={inputStyle} value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <label style={{ fontSize: 11, color: "#666" }} htmlFor="aal-to">To (UTC)</label>
          <input id="aal-to" type="datetime-local" style={inputStyle} value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div>
          <label style={{ fontSize: 11, color: "#666" }} htmlFor="aal-actor">Actor</label>
          <input id="aal-actor" style={inputStyle} value={actor} onChange={(e) => setActor(e.target.value)} placeholder="name / staff id / type" />
        </div>
        <div>
          <label style={{ fontSize: 11, color: "#666" }} htmlFor="aal-entity">Entity type</label>
          <input id="aal-entity" style={inputStyle} value={entityType} onChange={(e) => setEntityType(e.target.value)} placeholder="order, product…" />
        </div>
        <div>
          <label style={{ fontSize: 11, color: "#666" }} htmlFor="aal-action">Action</label>
          <input id="aal-action" style={inputStyle} value={action} onChange={(e) => setAction(e.target.value)} placeholder="update, login_failed…" />
        </div>
        <div>
          <label style={{ fontSize: 11, color: "#666" }} htmlFor="aal-q">Search</label>
          <input id="aal-q" style={inputStyle} value={q} onChange={(e) => setQ(e.target.value)} placeholder="summary or entity id" />
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
        <button type="button" className="action-btn btn-view" onClick={onApplyFilters} disabled={busy}>
          Apply filters
        </button>
        <button type="button" className="action-btn btn-view" data-audit-export="1" onClick={() => { void onExport(); }} disabled={busy}>
          Export CSV
        </button>
        <button type="button" className="action-btn btn-view" onClick={() => { void load(page); }} disabled={busy}>
          Refresh
        </button>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table className="admin-table" data-audit-table="1" style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", padding: "8px 10px" }}>When (UTC)</th>
              <th style={{ textAlign: "left", padding: "8px 10px" }}>Actor</th>
              <th style={{ textAlign: "left", padding: "8px 10px" }}>Action</th>
              <th style={{ textAlign: "left", padding: "8px 10px" }}>Entity</th>
              <th style={{ textAlign: "left", padding: "8px 10px" }}>Summary</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} style={{ textAlign: "center", color: "#888", padding: 24 }}>
                  {busy ? "Loading…" : "No activity rows match these filters."}
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr
                key={r.id}
                data-audit-id={String(r.id)}
                tabIndex={0}
                role="button"
                aria-label={`Open audit detail ${r.id}`}
                onClick={() => setDrawer(r)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setDrawer(r);
                  }
                }}
                style={{ cursor: "pointer", borderTop: "1px solid #eee" }}
              >
                <td style={{ padding: "8px 10px", whiteSpace: "nowrap" }}>{fmtWhen(String(r.created_at))}</td>
                <td style={{ padding: "8px 10px" }}>
                  {r.actor_name || r.actor_type}
                  {r.actor_role ? ` (${r.actor_role})` : ""}
                </td>
                <td style={{ padding: "8px 10px" }}>{r.action}</td>
                <td style={{ padding: "8px 10px" }}>
                  {r.entity_type}
                  {r.entity_id != null && r.entity_id !== "" ? ` #${r.entity_id}` : ""}
                </td>
                <td style={{ padding: "8px 10px" }}>{r.summary}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 12, fontSize: 13 }}>
        <button
          type="button"
          className="action-btn btn-view"
          disabled={busy || page <= 1}
          onClick={() => { void load(page - 1); }}
        >
          Previous
        </button>
        <span>
          Page {page} / {totalPages} · {total} total
        </span>
        <button
          type="button"
          className="action-btn btn-view"
          disabled={busy || page >= totalPages}
          onClick={() => { void load(page + 1); }}
        >
          Next
        </button>
      </div>

      {drawer && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Audit detail"
          data-audit-drawer="1"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.35)",
            zIndex: 80,
            display: "flex",
            justifyContent: "flex-end",
          }}
          onClick={() => setDrawer(null)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setDrawer(null);
          }}
        >
          <div
            style={{
              width: "min(440px, 100%)",
              background: "#fff",
              height: "100%",
              padding: 20,
              overflow: "auto",
              boxShadow: "-8px 0 24px rgba(0,0,0,0.12)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <strong>Activity detail</strong>
              <button type="button" className="action-btn btn-view" onClick={() => setDrawer(null)} aria-label="Close detail">
                Close
              </button>
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.5, color: "#333" }}>
              <div><strong>When:</strong> {fmtWhen(String(drawer.created_at))}</div>
              <div><strong>Actor:</strong> {drawer.actor_name || drawer.actor_type} ({drawer.actor_type}{drawer.actor_role ? ` / ${drawer.actor_role}` : ""})</div>
              <div><strong>Action:</strong> {drawer.action}</div>
              <div><strong>Entity:</strong> {drawer.entity_type}{drawer.entity_id != null ? ` #${drawer.entity_id}` : ""}</div>
              <div style={{ marginTop: 8 }}><strong>Summary:</strong> {drawer.summary}</div>
            </div>
            <pre
              style={{
                marginTop: 14,
                padding: 12,
                background: "#f7f7f7",
                borderRadius: 8,
                fontSize: 12,
                overflow: "auto",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {JSON.stringify(parseDetail(drawer.detail_json), null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
