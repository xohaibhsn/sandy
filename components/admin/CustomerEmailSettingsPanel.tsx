"use client";

import { useCallback, useEffect, useState } from "react";
import { adminRequest } from "@/lib/adminRequest";
import AdminBanner from "./AdminBanner";

/**
 * Customer order emails (super_admin only — the parent gates rendering and the API enforces
 * settings:accounts). Values load from GET /api/admin-accounts-settings (customerEmails) and save via
 * POST /api/site-content { updates: [...] }.
 */

type LoadResponse = {
  customerEmails?: { received?: boolean; confirmed?: boolean };
};

type FormState = { received: boolean; confirmed: boolean };

export default function CustomerEmailSettingsPanel() {
  const [form, setForm] = useState<FormState | null>(null);
  const [loadError, setLoadError] = useState("");
  const [banner, setBanner] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoadError("");
    const res = await adminRequest<LoadResponse>("/api/admin-accounts-settings");
    if (!res.ok || !res.data.customerEmails) {
      setLoadError(res.errorMessage || "Could not load customer email settings.");
      return;
    }
    setForm({
      received: res.data.customerEmails.received === true,
      confirmed: res.data.customerEmails.confirmed === true,
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await adminRequest<LoadResponse>("/api/admin-accounts-settings");
      if (cancelled) return;
      if (!res.ok || !res.data.customerEmails) {
        setLoadError(res.errorMessage || "Could not load customer email settings.");
        return;
      }
      setForm({
        received: res.data.customerEmails.received === true,
        confirmed: res.data.customerEmails.confirmed === true,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async () => {
    if (!form) return;
    setBanner("");
    setNotice("");
    setBusy(true);
    const res = await adminRequest("/api/site-content", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        updates: [
          { key: "customer_email_received_enabled", value: form.received ? "1" : "0" },
          { key: "customer_email_confirmed_enabled", value: form.confirmed ? "1" : "0" },
        ],
      }),
    });
    setBusy(false);
    if (!res.ok) {
      setBanner(res.errorMessage || "Could not save settings.");
      return;
    }
    setNotice("Customer email settings saved.");
    await load();
  };

  return (
    <div className="section-card" style={{ marginBottom: 20 }} data-customer-email-panel="1">
      <div className="section-header"><h3>Customer emails</h3></div>
      <div style={{ padding: "16px 20px" }}>
        {loadError && <AdminBanner message={loadError} tone="error" onRetry={() => { void load(); }} />}
        {banner && <AdminBanner message={banner} tone="error" />}
        {notice && <AdminBanner message={notice} tone="success" />}

        <p style={{ fontSize: 12, color: "#888", marginBottom: 14, lineHeight: 1.6 }}>
          Emails go to the address the customer typed at checkout.
        </p>

        {form && (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 14 }}>
              <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
                <input type="checkbox" checked={form.received}
                  onChange={(e) => setForm((f) => (f ? { ...f, received: e.target.checked } : f))} />
                Send &ldquo;Order received&rdquo; email to the customer
              </label>
              <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
                <input type="checkbox" checked={form.confirmed}
                  onChange={(e) => setForm((f) => (f ? { ...f, confirmed: e.target.checked } : f))} />
                Send &ldquo;Order confirmed&rdquo; email to the customer
              </label>
            </div>

            <button className="add-btn" disabled={busy} onClick={() => { void save(); }}>
              {busy ? "Saving…" : "Save"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
