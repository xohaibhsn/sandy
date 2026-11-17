"use client";

import { useEffect, useState } from "react";
import { adminRequest } from "@/lib/adminRequest";
import { normaliseEmail, normalisePhone } from "@/lib/customerIdentity";
import AdminBanner from "./AdminBanner";

/**
 * Customer blacklist (super_admin | manager — the API enforces customers:block).
 * Entries come back masked from GET /api/admin-blacklist; unblock needs a reason (PATCH).
 */

type Entry = {
  id: number;
  phone_masked: string | null;
  email_masked: string | null;
  reason: string | null;
  source_order_id: string | null;
  created_by: string | null;
  created_at: string | null;
  active: boolean;
};

type ListResponse = { entries?: Entry[]; total?: number };

const PAGE_SIZE = 20;

const inputStyle: React.CSSProperties = {
  padding: "8px 10px",
  border: "1px solid #E5E5E5",
  borderRadius: 8,
  fontSize: 13,
  background: "#fff",
  color: "#111",
};

function fmtDate(v: string | null): string {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isFinite(d.getTime())
    ? d.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric" })
    : "—";
}

/**
 * Block / Unblock button for a customers-table row. Block posts phone+email with a reason;
 * Unblock looks up active entries by normalised phone/email and deactivates them with a reason.
 */
export function CustomerBlockButton({
  phone,
  email,
  blocked,
  onChanged,
}: {
  phone: string;
  email: string;
  blocked: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);

  const run = async () => {
    const reason = (window.prompt(blocked ? "Reason for unblocking this customer:" : "Reason for blocking this customer:") || "").trim();
    if (!reason) return;
    setBusy(true);
    let failure = "";
    if (!blocked) {
      const res = await adminRequest("/api/admin-blacklist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: phone || undefined, email: email || undefined, reason }),
      });
      if (!res.ok) failure = res.errorMessage || "Could not block customer.";
    } else {
      const needles = [normalisePhone(phone), normaliseEmail(email)].filter((v): v is string => Boolean(v));
      const ids = new Set<number>();
      for (const needle of needles) {
        const res = await adminRequest<ListResponse>(
          `/api/admin-blacklist?limit=50&q=${encodeURIComponent(needle)}`,
          undefined,
          { expectSuccess: false }
        );
        if (!res.ok) {
          failure = res.errorMessage || "Could not look up blocked customer.";
          break;
        }
        for (const en of res.data.entries || []) if (en.active) ids.add(en.id);
      }
      if (!failure) {
        if (ids.size === 0) failure = "No active block found for this customer.";
        for (const id of ids) {
          const res = await adminRequest("/api/admin-blacklist", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, removed_reason: reason }),
          });
          if (!res.ok) {
            failure = res.errorMessage || "Could not unblock customer.";
            break;
          }
        }
      }
    }
    setBusy(false);
    if (failure) window.alert(failure);
    onChanged();
  };

  return (
    <button
      type="button"
      className={`action-btn ${blocked ? "btn-edit" : "btn-delete"}`}
      style={{ marginLeft: 6 }}
      disabled={busy}
      onClick={() => { void run(); }}
    >
      {blocked ? "Unblock" : "Block"}
    </button>
  );
}

export default function BlacklistPanel({ refreshKey = 0 }: { refreshKey?: number }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [qInput, setQInput] = useState("");
  const [q, setQ] = useState("");
  const [reload, setReload] = useState(0);
  const [loadError, setLoadError] = useState("");
  const [banner, setBanner] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const [unblockId, setUnblockId] = useState<number | null>(null);
  const [unblockReason, setUnblockReason] = useState("");

  const [showBlock, setShowBlock] = useState(false);
  const [blockForm, setBlockForm] = useState({ phone: "", email: "", reason: "" });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
      if (q) params.set("q", q);
      const res = await adminRequest<ListResponse>(`/api/admin-blacklist?${params.toString()}`, undefined, {
        expectSuccess: false,
      });
      if (cancelled) return;
      if (!res.ok) {
        setLoadError(res.errorMessage || "Could not load blacklist.");
        return;
      }
      setLoadError("");
      setEntries(Array.isArray(res.data.entries) ? res.data.entries : []);
      setTotal(Number(res.data.total) || 0);
    })();
    return () => {
      cancelled = true;
    };
  }, [q, page, reload, refreshKey]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const submitUnblock = async () => {
    if (unblockId === null) return;
    const reason = unblockReason.trim();
    if (!reason) {
      setBanner("A reason is required to unblock.");
      return;
    }
    setBanner("");
    setNotice("");
    setBusy(true);
    const res = await adminRequest("/api/admin-blacklist", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: unblockId, removed_reason: reason }),
    });
    setBusy(false);
    if (!res.ok) {
      setBanner(res.errorMessage || "Could not unblock.");
      return;
    }
    setNotice("Customer unblocked.");
    setUnblockId(null);
    setUnblockReason("");
    setReload((n) => n + 1);
  };

  const submitBlock = async () => {
    const reason = blockForm.reason.trim();
    if (!reason) {
      setBanner("A reason is required to block.");
      return;
    }
    if (!blockForm.phone.trim() && !blockForm.email.trim()) {
      setBanner("Enter a phone number or email.");
      return;
    }
    setBanner("");
    setNotice("");
    setBusy(true);
    const res = await adminRequest("/api/admin-blacklist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phone: blockForm.phone.trim() || undefined,
        email: blockForm.email.trim() || undefined,
        reason,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      setBanner(res.errorMessage || "Could not block customer.");
      return;
    }
    setNotice("Customer blocked.");
    setBlockForm({ phone: "", email: "", reason: "" });
    setShowBlock(false);
    setReload((n) => n + 1);
  };

  return (
    <div className="section-card" style={{ marginTop: 20 }} data-blacklist-panel="1">
      <div className="section-header">
        <div className="section-title">Blocked customers ({total})</div>
        <button type="button" className="action-btn btn-view" onClick={() => setShowBlock((v) => !v)}>
          {showBlock ? "Cancel" : "+ Block customer"}
        </button>
      </div>
      <div style={{ padding: "16px 20px" }}>
        {loadError && <AdminBanner message={loadError} tone="error" onRetry={() => setReload((n) => n + 1)} />}
        {banner && <AdminBanner message={banner} tone="error" />}
        {notice && <AdminBanner message={notice} tone="success" />}

        {showBlock && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "flex-end", marginBottom: 16 }}>
            <label style={{ fontSize: 12 }}>Phone<br />
              <input style={{ ...inputStyle, width: 160 }} value={blockForm.phone}
                onChange={(e) => setBlockForm((f) => ({ ...f, phone: e.target.value }))} />
            </label>
            <label style={{ fontSize: 12 }}>Email<br />
              <input style={{ ...inputStyle, width: 200 }} value={blockForm.email}
                onChange={(e) => setBlockForm((f) => ({ ...f, email: e.target.value }))} />
            </label>
            <label style={{ fontSize: 12 }}>Reason<br />
              <input style={{ ...inputStyle, width: 240 }} maxLength={500} value={blockForm.reason}
                onChange={(e) => setBlockForm((f) => ({ ...f, reason: e.target.value }))} />
            </label>
            <button type="button" className="add-btn" disabled={busy} onClick={() => { void submitBlock(); }}>
              Block
            </button>
          </div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            setPage(1);
            setQ(qInput.trim());
          }}
          style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap" }}
        >
          <input
            style={{ ...inputStyle, width: 260 }}
            placeholder="Search phone, email or reason"
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
          />
          <button type="submit" className="action-btn btn-view">Search</button>
          {q && (
            <button type="button" className="action-btn btn-view" onClick={() => { setQInput(""); setQ(""); setPage(1); }}>
              Clear
            </button>
          )}
        </form>

        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Phone</th><th>Email</th><th>Reason</th><th>Blocked by</th><th>Date</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {entries.length === 0 && (
                <tr><td colSpan={6} style={{ textAlign: "center", color: "#888", padding: 20 }}>No blocked customers.</td></tr>
              )}
              {entries.map((en) => (
                <tr key={en.id}>
                  <td style={{ fontSize: 13 }}>{en.phone_masked || "—"}</td>
                  <td style={{ fontSize: 13 }}>{en.email_masked || "—"}</td>
                  <td style={{ fontSize: 13, maxWidth: 260, wordBreak: "break-word" }}>{en.reason || "—"}</td>
                  <td style={{ fontSize: 12, color: "#888" }}>{en.created_by || "—"}</td>
                  <td style={{ fontSize: 12, color: "#888" }}>{fmtDate(en.created_at)}</td>
                  <td>
                    {!en.active ? (
                      <span style={{ color: "#aaa", fontSize: 12 }}>Unblocked</span>
                    ) : unblockId === en.id ? (
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        <input
                          style={{ ...inputStyle, width: 170 }}
                          placeholder="Reason for unblocking"
                          maxLength={500}
                          value={unblockReason}
                          onChange={(e) => setUnblockReason(e.target.value)}
                        />
                        <button type="button" className="action-btn btn-verify" disabled={busy} onClick={() => { void submitUnblock(); }}>
                          Confirm
                        </button>
                        <button type="button" className="action-btn btn-view" onClick={() => { setUnblockId(null); setUnblockReason(""); }}>
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button type="button" className="action-btn btn-edit" onClick={() => { setUnblockId(en.id); setUnblockReason(""); setBanner(""); }}>
                        Unblock
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {totalPages > 1 && (
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 12, fontSize: 12 }}>
            <button type="button" className="action-btn btn-view" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>← Prev</button>
            <span>Page {page} of {totalPages}</span>
            <button type="button" className="action-btn btn-view" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>Next →</button>
          </div>
        )}
      </div>
    </div>
  );
}
