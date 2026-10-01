"use client";

import { useCallback, useEffect, useState } from "react";

type RedirectStatusCode = 301 | 302 | 307 | 308;

type RedirectRecord = {
  id: number;
  source_path: string;
  destination: string;
  status_code: RedirectStatusCode;
  is_active: boolean;
  created_at?: string;
  updated_at?: string;
};

type FormState = {
  source_path: string;
  destination: string;
  status_code: RedirectStatusCode;
  is_active: boolean;
};

const STATUS_OPTIONS: { value: RedirectStatusCode; label: string }[] = [
  { value: 301, label: "301 — Permanent" },
  { value: 302, label: "302 — Temporary" },
  { value: 307, label: "307 — Temporary" },
  { value: 308, label: "308 — Permanent" },
];

const EMPTY_FORM: FormState = {
  source_path: "",
  destination: "",
  status_code: 301,
  is_active: true,
};

function statusLabel(code: RedirectStatusCode): string {
  const found = STATUS_OPTIONS.find((o) => o.value === code);
  return found ? found.label : String(code);
}

function formatUpdated(value?: string): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  try {
    return d.toLocaleString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

function mapApiError(status: number, fallback: string): string {
  switch (status) {
    case 400:
      return "Invalid redirect. Check the source, destination, status, protected paths, and redirect loops.";
    case 401:
      return "Your admin session has expired. Please sign in again.";
    case 403:
      return "You do not have permission to manage redirects.";
    case 404:
      return "Redirect not found. Refresh the list and try again.";
    case 409:
      return "A redirect for this source path already exists.";
    case 503:
      return "Redirect service is temporarily unavailable. Please try again.";
    default:
      return fallback;
  }
}

function normalizeRecord(raw: unknown): RedirectRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = Number(r.id);
  const status = Number(r.status_code);
  if (!Number.isInteger(id) || id <= 0) return null;
  if (status !== 301 && status !== 302 && status !== 307 && status !== 308) return null;
  return {
    id,
    source_path: String(r.source_path ?? ""),
    destination: String(r.destination ?? ""),
    status_code: status,
    is_active: r.is_active === true || r.is_active === 1 || r.is_active === "1",
    created_at: r.created_at != null ? String(r.created_at) : undefined,
    updated_at: r.updated_at != null ? String(r.updated_at) : undefined,
  };
}

type LoadResult =
  | { ok: true; rows: RedirectRecord[] }
  | { ok: false; error: string };

async function fetchRedirectList(): Promise<LoadResult> {
  try {
    const res = await fetch("/api/admin-redirects", { credentials: "same-origin" });
    if (res.status === 401) {
      return { ok: false, error: "Your admin session has expired. Please sign in again." };
    }
    if (res.status === 403) {
      return { ok: false, error: "You do not have permission to manage redirects." };
    }
    if (res.status === 503) {
      return { ok: false, error: "Redirect service is temporarily unavailable. Please try again." };
    }
    if (!res.ok) {
      return { ok: false, error: "Unable to load redirects. Please try again." };
    }
    const data: unknown = await res.json();
    if (!Array.isArray(data)) {
      return { ok: false, error: "Unable to load redirects. Please try again." };
    }
    const list: RedirectRecord[] = [];
    for (const item of data) {
      const rec = normalizeRecord(item);
      if (rec) list.push(rec);
    }
    return { ok: true, rows: list };
  } catch {
    return { ok: false, error: "Unable to load redirects. Check your connection and try again." };
  }
}

export default function RedirectManager() {
  const [rows, setRows] = useState<RedirectRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<RedirectRecord | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);

  const applyLoadResult = useCallback((result: LoadResult) => {
    if (result.ok) {
      setRows(result.rows);
      setLoadError(null);
    } else {
      setRows([]);
      setLoadError(result.error);
    }
    setLoading(false);
  }, []);

  const loadRedirects = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const result = await fetchRedirectList();
    applyLoadResult(result);
  }, [applyLoadResult]);

  useEffect(() => {
    let cancelled = false;
    void fetchRedirectList().then((result) => {
      if (cancelled) return;
      applyLoadResult(result);
    });
    return () => {
      cancelled = true;
    };
  }, [applyLoadResult]);

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    setFeedback(null);
    setModalOpen(true);
  }

  function openEdit(row: RedirectRecord) {
    setEditing(row);
    setForm({
      source_path: row.source_path,
      destination: row.destination,
      status_code: row.status_code,
      is_active: row.is_active,
    });
    setFormError(null);
    setFeedback(null);
    setModalOpen(true);
  }

  function closeModal() {
    if (saving) return;
    setModalOpen(false);
    setEditing(null);
    setFormError(null);
  }

  async function handleSave() {
    const source = form.source_path.trim();
    const destination = form.destination.trim();
    if (!source || !destination) {
      setFormError("Source path and destination are required.");
      return;
    }

    setSaving(true);
    setFormError(null);
    try {
      const payload = editing
        ? {
            id: editing.id,
            source_path: source,
            destination,
            status_code: form.status_code,
            is_active: form.is_active,
          }
        : {
            source_path: source,
            destination,
            status_code: form.status_code,
            is_active: form.is_active,
          };

      const res = await fetch("/api/admin-redirects", {
        method: editing ? "PUT" : "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        setFormError(mapApiError(res.status, "Unable to save redirect. Please try again."));
        return;
      }

      const data: unknown = await res.json();
      const body = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
      const returned = normalizeRecord(body?.redirect);
      if (!returned) {
        setFormError("Unable to save redirect. Please try again.");
        return;
      }

      setRows((prev) => {
        if (editing) {
          return prev.map((r) => (r.id === returned.id ? returned : r));
        }
        return [returned, ...prev.filter((r) => r.id !== returned.id)];
      });
      setModalOpen(false);
      setEditing(null);
      setFeedback({
        type: "ok",
        text: editing ? "Redirect updated." : "Redirect created.",
      });
    } catch {
      setFormError("Unable to save redirect. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleActive(row: RedirectRecord) {
    if (busyId != null) return;
    setBusyId(row.id);
    setFeedback(null);
    try {
      const res = await fetch("/api/admin-redirects", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: row.id,
          source_path: row.source_path,
          destination: row.destination,
          status_code: row.status_code,
          is_active: !row.is_active,
        }),
      });
      if (!res.ok) {
        setFeedback({
          type: "err",
          text: mapApiError(res.status, "Unable to save redirect. Please try again."),
        });
        return;
      }
      const data: unknown = await res.json();
      const body = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
      const returned = normalizeRecord(body?.redirect);
      if (!returned) {
        setFeedback({ type: "err", text: "Unable to save redirect. Please try again." });
        return;
      }
      setRows((prev) => prev.map((r) => (r.id === returned.id ? returned : r)));
      setFeedback({
        type: "ok",
        text: returned.is_active ? "Redirect activated." : "Redirect deactivated.",
      });
    } catch {
      setFeedback({ type: "err", text: "Unable to save redirect. Please try again." });
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(row: RedirectRecord) {
    if (busyId != null) return;
    const ok = window.confirm(`Delete redirect for "${row.source_path}"?`);
    if (!ok) return;

    setBusyId(row.id);
    setFeedback(null);
    try {
      const res = await fetch(`/api/admin-redirects?id=${encodeURIComponent(String(row.id))}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (!res.ok) {
        setFeedback({
          type: "err",
          text: mapApiError(res.status, "Unable to save redirect. Please try again."),
        });
        return;
      }
      setRows((prev) => prev.filter((r) => r.id !== row.id));
      setFeedback({ type: "ok", text: "Redirect deleted." });
    } catch {
      setFeedback({ type: "err", text: "Unable to save redirect. Please try again." });
    } finally {
      setBusyId(null);
    }
  }

  const actionBusy = busyId != null || saving;

  return (
    <div>
      {feedback && (
        <div
          role="status"
          style={{
            marginBottom: 16,
            padding: "10px 16px",
            background: feedback.type === "ok" ? "rgba(0,200,100,0.1)" : "rgba(255,68,68,0.1)",
            border: `1px solid ${feedback.type === "ok" ? "rgba(0,200,100,0.3)" : "rgba(255,68,68,0.25)"}`,
            borderRadius: 10,
            fontSize: 13,
            color: feedback.type === "ok" ? "#00c864" : "#ff6666",
          }}
        >
          {feedback.text}
        </div>
      )}

      <div className="section-card">
        <div className="section-header">
          <div>
            <div className="section-title">Redirects</div>
            <p style={{ margin: "6px 0 0", fontSize: 13, color: "#666666", lineHeight: 1.45, fontWeight: 400 }}>
              Manage old/legacy URLs and forward them to current internal or external URLs.
            </p>
          </div>
          <button type="button" className="add-btn" onClick={openCreate} disabled={loading || !!loadError}>
            + Add Redirect
          </button>
        </div>

        {loading && (
          <div style={{ padding: "28px 20px", textAlign: "center", color: "#666666", fontSize: 14 }}>
            Loading redirects…
          </div>
        )}

        {!loading && loadError && (
          <div style={{ padding: "28px 20px", textAlign: "center" }}>
            <p style={{ color: "#DC2626", fontSize: 14, marginBottom: 14 }}>{loadError}</p>
            <button type="button" className="action-btn btn-edit" onClick={() => void loadRedirects()}>
              Retry
            </button>
          </div>
        )}

        {!loading && !loadError && rows.length === 0 && (
          <div style={{ padding: "36px 24px", textAlign: "center" }}>
            <p style={{ fontSize: 15, fontWeight: 600, color: "#111111", marginBottom: 8 }}>
              No redirects configured yet.
            </p>
            <p style={{ fontSize: 13, color: "#666666", lineHeight: 1.5, maxWidth: 420, margin: "0 auto" }}>
              Use redirects when an old URL should point to a new location. Add a source path and destination to get started.
            </p>
          </div>
        )}

        {!loading && !loadError && rows.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Destination</th>
                  <th>Status</th>
                  <th>Active</th>
                  <th>Updated</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const rowBusy = busyId === row.id;
                  return (
                    <tr key={row.id}>
                      <td>
                        <code
                          style={{
                            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                            fontSize: 12,
                            wordBreak: "break-all",
                            whiteSpace: "pre-wrap",
                            color: "#111111",
                          }}
                        >
                          {row.source_path}
                        </code>
                      </td>
                      <td>
                        <span
                          style={{
                            fontSize: 13,
                            wordBreak: "break-all",
                            whiteSpace: "pre-wrap",
                            color: "#333333",
                          }}
                        >
                          {row.destination}
                        </span>
                      </td>
                      <td>
                        <span
                          style={{
                            display: "inline-block",
                            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                            fontSize: 12,
                            fontWeight: 700,
                            color: "#5B21B6",
                            whiteSpace: "nowrap",
                          }}
                          title={statusLabel(row.status_code)}
                        >
                          {row.status_code}
                        </span>
                        <div style={{ fontSize: 11, color: "#888888", marginTop: 2 }}>
                          {row.status_code === 301 || row.status_code === 308 ? "Permanent" : "Temporary"}
                        </div>
                      </td>
                      <td>
                        <button
                          type="button"
                          className={`status-badge ${row.is_active ? "status-delivered" : "status-pending"}`}
                          onClick={() => void handleToggleActive(row)}
                          disabled={actionBusy}
                          style={{
                            cursor: actionBusy ? "not-allowed" : "pointer",
                            border: "none",
                            opacity: rowBusy ? 0.6 : 1,
                          }}
                          aria-label={row.is_active ? "Deactivate redirect" : "Activate redirect"}
                        >
                          {rowBusy ? "Saving…" : row.is_active ? "Active" : "Inactive"}
                        </button>
                      </td>
                      <td style={{ whiteSpace: "nowrap", fontSize: 12, color: "#666666" }}>
                        {formatUpdated(row.updated_at)}
                      </td>
                      <td>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          <button
                            type="button"
                            className="action-btn btn-edit"
                            onClick={() => openEdit(row)}
                            disabled={actionBusy}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="action-btn btn-delete"
                            onClick={() => void handleDelete(row)}
                            disabled={actionBusy}
                          >
                            {rowBusy ? "…" : "Delete"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modalOpen && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="redirect-modal-title">
          <div className="modal" style={{ maxWidth: 520, width: "100%", maxHeight: "90vh", overflowY: "auto" }}>
            <div className="modal-title" id="redirect-modal-title">
              {editing ? "Edit Redirect" : "Add Redirect"}
            </div>

            <div className="modal-field">
              <label htmlFor="redirect-source">Source Path *</label>
              <input
                id="redirect-source"
                type="text"
                value={form.source_path}
                onChange={(e) => setForm((f) => ({ ...f, source_path: e.target.value }))}
                placeholder="/old-page"
                disabled={saving}
                autoComplete="off"
              />
              <p style={{ margin: "6px 0 0", fontSize: 11, color: "#888888", lineHeight: 1.4 }}>
                Local source path only (e.g. /old-page, /legacy/product.html). Queries and fragments in the source are normalized away by the backend.
              </p>
            </div>

            <div className="modal-field">
              <label htmlFor="redirect-destination">Destination *</label>
              <input
                id="redirect-destination"
                type="text"
                value={form.destination}
                onChange={(e) => setForm((f) => ({ ...f, destination: e.target.value }))}
                placeholder="/new-page or https://example.com/page"
                disabled={saving}
                autoComplete="off"
              />
              <p style={{ margin: "6px 0 0", fontSize: 11, color: "#888888", lineHeight: 1.4 }}>
                Internal path or absolute HTTP(S) URL (e.g. /new-page, /new-page?ref=legacy, https://example.com/page).
              </p>
            </div>

            <div className="modal-field">
              <label htmlFor="redirect-status">Status *</label>
              <select
                id="redirect-status"
                value={form.status_code}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    status_code: Number(e.target.value) as RedirectStatusCode,
                  }))
                }
                disabled={saving}
              >
                {STATUS_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="modal-field">
              <label
                htmlFor="redirect-active"
                style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", userSelect: "none" }}
              >
                <input
                  id="redirect-active"
                  type="checkbox"
                  checked={form.is_active}
                  onChange={(e) => setForm((f) => ({ ...f, is_active: e.target.checked }))}
                  disabled={saving}
                />
                Active
              </label>
            </div>

            {formError && (
              <p role="alert" style={{ color: "#DC2626", fontSize: 13, marginBottom: 12 }}>
                {formError}
              </p>
            )}

            <div className="modal-actions">
              <button type="button" className="modal-cancel" onClick={closeModal} disabled={saving}>
                Cancel
              </button>
              <button type="button" className="modal-save" onClick={() => void handleSave()} disabled={saving}>
                {saving ? "Saving…" : editing ? "Save Changes" : "Create Redirect"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
