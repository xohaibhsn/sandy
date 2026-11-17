"use client";

import { useCallback, useEffect, useState } from "react";
import { adminRequest } from "@/lib/adminRequest";
import { CUSTOMER_TEXTS } from "@/lib/customerTexts";
import AdminBanner from "./AdminBanner";

/**
 * COD / order-protection settings (super_admin only — the parent gates rendering and the API
 * enforces settings:order_protection). Values load from GET /api/admin-order-protection and save via
 * POST /api/site-content { updates: [...] }.
 */

type AdvanceMethod = "jazzcash" | "easypaisa" | "bank";
const ADVANCE_OPTIONS: { val: AdvanceMethod; label: string }[] = [
  { val: "jazzcash", label: "JazzCash" },
  { val: "easypaisa", label: "Easypaisa" },
  { val: "bank", label: "Bank Transfer" },
];

type FormState = {
  cod_protection_enabled: boolean;
  cod_otp_enabled: boolean;
  cod_new_customer_cap: string;
  cod_max_open_per_phone: string;
  cod_risky_mode: "advance_only" | "advance_delivery_charge";
  cod_advance_delivery_charge: string;
  cod_risk_threshold: string;
  advance_methods: AdvanceMethod[];
};

type LoadResponse = {
  settings?: Partial<{
    cod_protection_enabled: boolean;
    cod_otp_enabled: boolean;
    cod_new_customer_cap: number;
    cod_max_open_per_phone: number;
    cod_risky_mode: string;
    cod_advance_delivery_charge: number;
    cod_risk_threshold: number;
    advance_methods: string[];
  }>;
  otpProviderConfigured?: boolean;
};

const inputStyle: React.CSSProperties = {
  padding: "8px 10px",
  border: "1px solid #E5E5E5",
  borderRadius: 8,
  fontSize: 13,
  background: "#fff",
  color: "#111",
};

function toForm(s: NonNullable<LoadResponse["settings"]>): FormState {
  const methods = (s.advance_methods || []).filter((m): m is AdvanceMethod =>
    ADVANCE_OPTIONS.some((o) => o.val === m)
  );
  return {
    cod_protection_enabled: s.cod_protection_enabled === true,
    cod_otp_enabled: s.cod_otp_enabled === true,
    cod_new_customer_cap: String(s.cod_new_customer_cap ?? 5000),
    cod_max_open_per_phone: String(s.cod_max_open_per_phone ?? 1),
    cod_risky_mode: s.cod_risky_mode === "advance_delivery_charge" ? "advance_delivery_charge" : "advance_only",
    cod_advance_delivery_charge: String(s.cod_advance_delivery_charge ?? 0),
    cod_risk_threshold: String(s.cod_risk_threshold ?? 50),
    advance_methods: methods.length ? methods : ["jazzcash", "easypaisa", "bank"],
  };
}

function isInt(v: string, max: number): boolean {
  return /^\d+$/.test(v.trim()) && Number(v) <= max;
}

export default function OrderProtectionSettingsPanel({
  otpProviderConfigured: otpProviderConfiguredProp,
}: {
  /** Optional override; by default the panel reads it from GET /api/admin-order-protection. */
  otpProviderConfigured?: boolean;
}) {
  const [form, setForm] = useState<FormState | null>(null);
  const [otpConfigured, setOtpConfigured] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState("");
  const [banner, setBanner] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoadError("");
    const res = await adminRequest<LoadResponse>("/api/admin-order-protection");
    if (!res.ok || !res.data.settings) {
      setLoadError(res.errorMessage || "Could not load order protection settings.");
      return;
    }
    setForm(toForm(res.data.settings));
    setOtpConfigured(res.data.otpProviderConfigured === true);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await adminRequest<LoadResponse>("/api/admin-order-protection");
      if (cancelled) return;
      if (!res.ok || !res.data.settings) {
        setLoadError(res.errorMessage || "Could not load order protection settings.");
        return;
      }
      setForm(toForm(res.data.settings));
      setOtpConfigured(res.data.otpProviderConfigured === true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const providerConfigured = otpProviderConfiguredProp ?? otpConfigured;

  const save = async () => {
    if (!form) return;
    setBanner("");
    setNotice("");
    if (!isInt(form.cod_new_customer_cap, 10_000_000)) return setBanner("New customer COD cap must be a whole number.");
    if (!isInt(form.cod_max_open_per_phone, 100)) return setBanner("Max open COD orders must be 0–100.");
    if (!isInt(form.cod_advance_delivery_charge, 10_000_000)) return setBanner("Advance delivery charge must be a whole number.");
    if (!isInt(form.cod_risk_threshold, 100)) return setBanner("Risk threshold must be 0–100.");
    if (form.advance_methods.length === 0) return setBanner("Select at least one advance payment method.");

    setBusy(true);
    const res = await adminRequest("/api/site-content", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        updates: [
          { key: "cod_protection_enabled", value: form.cod_protection_enabled ? "1" : "0" },
          { key: "cod_otp_enabled", value: form.cod_otp_enabled ? "1" : "0" },
          { key: "cod_new_customer_cap", value: form.cod_new_customer_cap.trim() },
          { key: "cod_max_open_per_phone", value: form.cod_max_open_per_phone.trim() },
          { key: "cod_risky_mode", value: form.cod_risky_mode },
          { key: "cod_advance_delivery_charge", value: form.cod_advance_delivery_charge.trim() },
          { key: "cod_risk_threshold", value: form.cod_risk_threshold.trim() },
          { key: "advance_methods", value: form.advance_methods.join(",") },
        ],
      }),
    });
    setBusy(false);
    if (!res.ok) {
      setBanner(res.errorMessage || "Could not save settings.");
      return;
    }
    setNotice("Order protection settings saved.");
    await load();
  };

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => (f ? { ...f, [key]: value } : f));

  const toggleMethod = (m: AdvanceMethod) =>
    setForm((f) =>
      f
        ? {
            ...f,
            advance_methods: f.advance_methods.includes(m)
              ? f.advance_methods.filter((x) => x !== m)
              : [...f.advance_methods, m],
          }
        : f
    );

  return (
    <div className="section-card" style={{ marginBottom: 20 }} data-order-protection-panel="1">
      <div className="section-header"><h3>Order protection (COD)</h3></div>
      <div style={{ padding: "16px 20px" }}>
        {loadError && <AdminBanner message={loadError} tone="error" onRetry={() => { void load(); }} />}
        {banner && <AdminBanner message={banner} tone="error" />}
        {notice && <AdminBanner message={notice} tone="success" />}

        <p style={{ fontSize: 12, color: "#888", marginBottom: 14, lineHeight: 1.6 }}>
          When protection is off, checkout behaves exactly as before. Changes apply to new orders within a few seconds.
        </p>

        {providerConfigured !== null && providerConfigured !== undefined && (
          <div style={{ fontSize: 12, marginBottom: 14 }} data-otp-provider-configured={providerConfigured ? "true" : "false"}>
            OTP provider:{" "}
            {providerConfigured ? (
              <span className="status-badge status-delivered">Configured</span>
            ) : (
              <span className="status-badge status-cancelled">{CUSTOMER_TEXTS.ADMIN_OTP_PROVIDER_MISSING}</span>
            )}
          </div>
        )}

        {form && (
          <>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 18, marginBottom: 14 }}>
              <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
                <input type="checkbox" checked={form.cod_protection_enabled}
                  onChange={(e) => set("cod_protection_enabled", e.target.checked)} />
                Enable COD protection
              </label>
              <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
                <input type="checkbox" checked={form.cod_otp_enabled}
                  onChange={(e) => set("cod_otp_enabled", e.target.checked)} />
                Require WhatsApp OTP for COD
              </label>
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginBottom: 14 }}>
              <label style={{ fontSize: 12 }}>New customer COD cap (Rs.)<br />
                <input style={{ ...inputStyle, width: 160 }} inputMode="numeric" value={form.cod_new_customer_cap}
                  onChange={(e) => set("cod_new_customer_cap", e.target.value)} />
              </label>
              <label style={{ fontSize: 12 }}>Max open COD orders per phone<br />
                <input style={{ ...inputStyle, width: 160 }} inputMode="numeric" value={form.cod_max_open_per_phone}
                  onChange={(e) => set("cod_max_open_per_phone", e.target.value)} />
              </label>
              <label style={{ fontSize: 12 }}>Risk threshold (0–100)<br />
                <input style={{ ...inputStyle, width: 160 }} inputMode="numeric" value={form.cod_risk_threshold}
                  onChange={(e) => set("cod_risk_threshold", e.target.value)} />
              </label>
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginBottom: 14 }}>
              <label style={{ fontSize: 12 }}>Risky customer mode<br />
                <select style={inputStyle} value={form.cod_risky_mode}
                  onChange={(e) => set("cod_risky_mode", e.target.value === "advance_delivery_charge" ? "advance_delivery_charge" : "advance_only")}>
                  <option value="advance_only">Advance payment only (no COD)</option>
                  <option value="advance_delivery_charge">COD with advance delivery charge</option>
                </select>
              </label>
              <label style={{ fontSize: 12 }}>Advance delivery charge (Rs.)<br />
                <input style={{ ...inputStyle, width: 160 }} inputMode="numeric" value={form.cod_advance_delivery_charge}
                  onChange={(e) => set("cod_advance_delivery_charge", e.target.value)} />
              </label>
            </div>

            <div style={{ fontSize: 12, marginBottom: 14 }}>
              Advance payment methods offered<br />
              <div style={{ display: "flex", gap: 16, marginTop: 6, flexWrap: "wrap" }}>
                {ADVANCE_OPTIONS.map((o) => (
                  <label key={o.val} style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
                    <input type="checkbox" checked={form.advance_methods.includes(o.val)}
                      onChange={() => toggleMethod(o.val)} />
                    {o.label}
                  </label>
                ))}
              </div>
            </div>

            <button className="add-btn" disabled={busy} onClick={() => { void save(); }}>
              {busy ? "Saving…" : "Save order protection settings"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
