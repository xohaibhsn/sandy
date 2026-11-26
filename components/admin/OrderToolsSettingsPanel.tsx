"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { adminRequest } from "@/lib/adminRequest";
import {
  ORDER_TOOLS_DEFAULTS,
  buildWhatsAppLink,
  type OrderDocSettings,
} from "@/lib/orderDocuments";
import AdminBanner from "./AdminBanner";

/**
 * Order tools (invoice / WhatsApp templates) — super_admin only.
 * Parent gates rendering; API enforces site_content:write_branding via SUPER_ADMIN_ONLY keys.
 * Load: GET /api/site-content (staff session). Save: POST /api/site-content { updates }.
 */

const KEYS = [
  "invoice_business_name",
  "invoice_business_address",
  "invoice_business_phone",
  "invoice_ntn",
  "invoice_title",
  "invoice_footer_note",
  "wa_confirm_template",
  "wa_dispatch_template",
] as const;

type FormState = Record<(typeof KEYS)[number], string>;

function defaultsForm(): FormState {
  return {
    invoice_business_name: ORDER_TOOLS_DEFAULTS.invoice_business_name,
    invoice_business_address: ORDER_TOOLS_DEFAULTS.invoice_business_address,
    invoice_business_phone: ORDER_TOOLS_DEFAULTS.invoice_business_phone,
    invoice_ntn: ORDER_TOOLS_DEFAULTS.invoice_ntn,
    invoice_title: ORDER_TOOLS_DEFAULTS.invoice_title,
    invoice_footer_note: ORDER_TOOLS_DEFAULTS.invoice_footer_note,
    wa_confirm_template: ORDER_TOOLS_DEFAULTS.wa_confirm_template,
    wa_dispatch_template: ORDER_TOOLS_DEFAULTS.wa_dispatch_template,
  };
}

function fromContent(content: Record<string, string> | null | undefined): FormState {
  const base = defaultsForm();
  if (!content) return base;
  for (const k of KEYS) {
    if (Object.prototype.hasOwnProperty.call(content, k) && content[k] != null) {
      base[k] = String(content[k]);
    }
  }
  return base;
}

const SAMPLE_ORDER = {
  order_id: "ORD-SAMPLE",
  customer_name: "Customer",
  customer_phone: "03001234567",
  city: "Lahore",
  payment_method: "cod",
  total: 1379,
  courier_name: "TCS",
  tracking_number: "TRK123",
  items: [{ product_name: "Phone Case", quantity: 1 }],
};

const PLACEHOLDER_HELP =
  "Placeholders: {name} {order_id} {total} {payment} {city} {items} {courier} {tracking} {store}";

const fieldStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  border: "1px solid #E5E5E5",
  borderRadius: 8,
  fontSize: 13,
  background: "#fff",
  color: "#111",
};

export default function OrderToolsSettingsPanel() {
  const [form, setForm] = useState<FormState | null>(null);
  const [loadError, setLoadError] = useState("");
  const [banner, setBanner] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoadError("");
    const res = await adminRequest<Record<string, string>>("/api/site-content", undefined, {
      expectSuccess: false,
    });
    if (!res.ok || !res.data || typeof res.data !== "object") {
      setLoadError(res.errorMessage || "Could not load order tools settings.");
      return;
    }
    setForm(fromContent(res.data));
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await adminRequest<Record<string, string>>("/api/site-content", undefined, {
        expectSuccess: false,
      });
      if (cancelled) return;
      if (!res.ok || !res.data || typeof res.data !== "object") {
        setLoadError(res.errorMessage || "Could not load order tools settings.");
        return;
      }
      setForm(fromContent(res.data));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const settings: OrderDocSettings = form || defaultsForm();

  const confirmPreview = useMemo(() => {
    const r = buildWhatsAppLink(SAMPLE_ORDER, settings.wa_confirm_template || "", { settings });
    if (!r.ok) return "";
    try {
      const u = new URL(r.href);
      return decodeURIComponent(u.searchParams.get("text") || "");
    } catch {
      return "";
    }
  }, [settings]);

  const dispatchPreview = useMemo(() => {
    const r = buildWhatsAppLink(SAMPLE_ORDER, settings.wa_dispatch_template || "", { settings });
    if (!r.ok) return "";
    try {
      const u = new URL(r.href);
      return decodeURIComponent(u.searchParams.get("text") || "");
    } catch {
      return "";
    }
  }, [settings]);

  const save = async () => {
    if (!form) return;
    setBanner("");
    setNotice("");
    setBusy(true);
    const res = await adminRequest("/api/site-content", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        updates: KEYS.map((key) => ({ key, value: form[key] ?? "" })),
      }),
    });
    setBusy(false);
    if (!res.ok) {
      setBanner(res.errorMessage || "Could not save settings.");
      return;
    }
    setNotice("Order tools settings saved.");
    await load();
  };

  const setField = (key: keyof FormState, value: string) => {
    setForm((f) => (f ? { ...f, [key]: value } : f));
  };

  return (
    <div className="section-card" style={{ marginBottom: 20 }} data-order-tools-panel="1">
      <div className="section-header">
        <h3>Order tools</h3>
      </div>
      <div style={{ padding: "16px 20px" }}>
        {loadError && (
          <AdminBanner
            message={loadError}
            tone="error"
            onRetry={() => {
              void load();
            }}
          />
        )}
        {banner && <AdminBanner message={banner} tone="error" />}
        {notice && <AdminBanner message={notice} tone="success" />}

        <p style={{ fontSize: 12, color: "#888", marginBottom: 14, lineHeight: 1.6 }}>
          Invoice / packing-slip business details and WhatsApp message templates for COD ops.
          Empty business fields are hidden on print. Leave NTN / STRN empty if not registered.
        </p>

        {form && (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 16, maxWidth: 640 }}>
              <label style={{ fontSize: 13 }}>
                Business name
                <input
                  style={{ ...fieldStyle, marginTop: 4 }}
                  value={form.invoice_business_name}
                  onChange={(e) => setField("invoice_business_name", e.target.value)}
                />
              </label>
              <label style={{ fontSize: 13 }}>
                Business address
                <textarea
                  rows={3}
                  style={{ ...fieldStyle, marginTop: 4, resize: "vertical" }}
                  value={form.invoice_business_address}
                  onChange={(e) => setField("invoice_business_address", e.target.value)}
                />
              </label>
              <label style={{ fontSize: 13 }}>
                Business phone
                <input
                  style={{ ...fieldStyle, marginTop: 4 }}
                  value={form.invoice_business_phone}
                  onChange={(e) => setField("invoice_business_phone", e.target.value)}
                />
              </label>
              <label style={{ fontSize: 13 }}>
                NTN / STRN (leave empty if not registered)
                <input
                  style={{ ...fieldStyle, marginTop: 4 }}
                  value={form.invoice_ntn}
                  onChange={(e) => setField("invoice_ntn", e.target.value)}
                />
              </label>
              <label style={{ fontSize: 13 }}>
                Invoice title
                <input
                  style={{ ...fieldStyle, marginTop: 4 }}
                  value={form.invoice_title}
                  onChange={(e) => setField("invoice_title", e.target.value)}
                />
              </label>
              <label style={{ fontSize: 13 }}>
                Footer note
                <textarea
                  rows={2}
                  style={{ ...fieldStyle, marginTop: 4, resize: "vertical" }}
                  value={form.invoice_footer_note}
                  onChange={(e) => setField("invoice_footer_note", e.target.value)}
                />
              </label>

              <label style={{ fontSize: 13 }}>
                WhatsApp: confirm order template
                <textarea
                  rows={3}
                  style={{ ...fieldStyle, marginTop: 4, resize: "vertical" }}
                  value={form.wa_confirm_template}
                  onChange={(e) => setField("wa_confirm_template", e.target.value)}
                  data-wa-confirm-template="1"
                />
              </label>
              <div style={{ fontSize: 12, color: "#666", lineHeight: 1.5 }} data-wa-confirm-preview="1">
                Preview: {confirmPreview}
              </div>

              <label style={{ fontSize: 13 }}>
                WhatsApp: dispatched template
                <textarea
                  rows={3}
                  style={{ ...fieldStyle, marginTop: 4, resize: "vertical" }}
                  value={form.wa_dispatch_template}
                  onChange={(e) => setField("wa_dispatch_template", e.target.value)}
                  data-wa-dispatch-template="1"
                />
              </label>
              <div style={{ fontSize: 12, color: "#666", lineHeight: 1.5 }} data-wa-dispatch-preview="1">
                Preview: {dispatchPreview}
              </div>

              <div style={{ fontSize: 11, color: "#888" }}>{PLACEHOLDER_HELP}</div>
            </div>

            <button
              className="add-btn"
              disabled={busy}
              onClick={() => {
                void save();
              }}
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
