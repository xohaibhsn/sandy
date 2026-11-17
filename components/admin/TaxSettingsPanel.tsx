"use client";

import { useCallback, useEffect, useState } from "react";
import { adminRequest } from "@/lib/adminRequest";
import AdminBanner from "./AdminBanner";

/**
 * TAX-CONFIG-01 admin Tax tab (super_admin only — the API enforces this too).
 * Display-only: "current" markers below are for the admin's information; checkout always uses
 * server-side values. Rates/rules are never edited in place: every change inserts a NEW dated row.
 */

type TaxClassRow = {
  id: number;
  name: string;
  slug: string;
  applies_to: "domestic" | "international" | "both";
  active: number | boolean;
  sort_order: number;
};
type TaxRateRow = {
  id: number;
  tax_class_id: number;
  rate_percent: number | string;
  effective_from: string;
  created_by?: string | null;
};
type TaxRuleRow = {
  id: number;
  tax_base: "after_discount" | "before_discount";
  shipping_taxable: number | boolean;
  tax_label: string;
  prices_include_tax: number | boolean;
  effective_from: string;
};
type TaxPayload = {
  classes?: TaxClassRow[];
  rates?: TaxRateRow[];
  rules?: TaxRuleRow[];
};

const inputStyle: React.CSSProperties = {
  padding: "8px 10px",
  border: "1px solid #E5E5E5",
  borderRadius: 8,
  fontSize: 13,
  background: "#fff",
  color: "#111",
};

function fmtDate(v: string): string {
  const d = new Date(v);
  return Number.isFinite(d.getTime())
    ? d.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
    : "—";
}

function isOn(v: unknown): boolean {
  return v === true || Number(v) === 1;
}

/** Index of the effective row (latest effective_from <= now) in a list sorted newest-first. */
function currentId<T extends { id: number; effective_from: string }>(rows: T[], now: number): number | null {
  let best: T | null = null;
  for (const r of rows) {
    const ms = new Date(r.effective_from).getTime();
    if (!Number.isFinite(ms) || ms > now) continue;
    if (!best || ms > new Date(best.effective_from).getTime() || (ms === new Date(best.effective_from).getTime() && r.id > best.id)) {
      best = r;
    }
  }
  return best ? best.id : null;
}

export default function TaxSettingsPanel() {
  const [data, setData] = useState<TaxPayload | null>(null);
  const [loadError, setLoadError] = useState("");
  const [banner, setBanner] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  // "now" for Current/Upcoming display markers only; refreshed on every load.
  const [nowMs, setNowMs] = useState(() => Date.now());

  const [rateForm, setRateForm] = useState({ tax_class_id: "", rate_percent: "", effective_from: "" });
  const [ruleForm, setRuleForm] = useState({
    tax_base: "after_discount",
    shipping_taxable: false,
    prices_include_tax: false,
    tax_label: "GST",
    effective_from: "",
  });
  const [classForm, setClassForm] = useState({ name: "", applies_to: "both" });

  const load = useCallback(async () => {
    setLoadError("");
    const res = await adminRequest<TaxPayload>("/api/admin-tax");
    if (!res.ok) {
      setLoadError(res.errorMessage || "Could not load tax settings.");
      return false;
    }
    setData(res.data);
    setNowMs(Date.now());
    return true;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await adminRequest<TaxPayload>("/api/admin-tax");
      if (cancelled) return;
      if (!res.ok) {
        setLoadError(res.errorMessage || "Could not load tax settings.");
        return;
      }
      setData(res.data);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const post = async (payload: Record<string, unknown>, okMessage: string) => {
    setBanner("");
    setNotice("");
    setBusy(true);
    const res = await adminRequest("/api/admin-tax", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    setBusy(false);
    if (!res.ok) {
      setBanner(res.errorMessage || "Could not save tax settings.");
      return false;
    }
    setNotice(okMessage);
    await load();
    return true;
  };

  const updateClass = async (id: number, patch: Record<string, unknown>) => {
    setBanner("");
    setNotice("");
    setBusy(true);
    const res = await adminRequest("/api/admin-tax", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...patch }),
    });
    setBusy(false);
    if (!res.ok) {
      setBanner(res.errorMessage || "Could not update tax class.");
      return;
    }
    setNotice("Tax class updated. Applies to new orders only.");
    await load();
  };

  const classes = data?.classes ?? [];
  const rates = data?.rates ?? [];
  const rules = data?.rules ?? [];
  const classNameById = new Map(classes.map((c) => [c.id, c.name]));
  const currentRuleId = currentId(rules, nowMs);
  const currentRateIds = new Set<number>();
  for (const c of classes) {
    const id = currentId(rates.filter((r) => r.tax_class_id === c.id), nowMs);
    if (id !== null) currentRateIds.add(id);
  }
  const effectiveRateByClass = new Map<number, TaxRateRow>();
  for (const r of rates) if (currentRateIds.has(r.id)) effectiveRateByClass.set(r.tax_class_id, r);

  const toIsoOrEmpty = (local: string): string => {
    if (!local) return "";
    const d = new Date(local);
    return Number.isFinite(d.getTime()) ? d.toISOString() : local;
  };

  return (
    <div>
      {loadError && <AdminBanner message={loadError} tone="error" onRetry={() => { void load(); }} />}
      {banner && <AdminBanner message={banner} tone="error" />}
      {notice && <AdminBanner message={notice} tone="success" />}

      <p style={{ fontSize: 12, color: "#888", marginBottom: 16, lineHeight: 1.6 }}>
        Rates and rules are never edited in place. Every change adds a <strong>new dated row</strong> that applies to{" "}
        <strong>new orders only</strong>; existing orders keep the tax they were placed with. Leave the date empty to
        take effect immediately.
      </p>

      {/* Global rules */}
      <div className="section-card" style={{ marginBottom: 20 }}>
        <div className="section-header"><h3>Global tax rules</h3></div>
        <div style={{ padding: "16px 20px" }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end", marginBottom: 14 }}>
            <label style={{ fontSize: 12 }}>Tax label<br />
              <input style={{ ...inputStyle, width: 140 }} maxLength={64} value={ruleForm.tax_label}
                onChange={(e) => setRuleForm((f) => ({ ...f, tax_label: e.target.value }))} />
            </label>
            <label style={{ fontSize: 12 }}>Tax base<br />
              <select style={inputStyle} value={ruleForm.tax_base}
                onChange={(e) => setRuleForm((f) => ({ ...f, tax_base: e.target.value }))}>
                <option value="after_discount">After coupon discount (default)</option>
                <option value="before_discount">Before coupon discount</option>
              </select>
            </label>
            <label style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center" }}>
              <input type="checkbox" checked={ruleForm.shipping_taxable}
                onChange={(e) => setRuleForm((f) => ({ ...f, shipping_taxable: e.target.checked }))} />
              Shipping taxable
            </label>
            <label style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center" }}>
              <input type="checkbox" checked={ruleForm.prices_include_tax}
                onChange={(e) => setRuleForm((f) => ({ ...f, prices_include_tax: e.target.checked }))} />
              Prices include tax
            </label>
            <label style={{ fontSize: 12 }}>Effective from (optional)<br />
              <input type="datetime-local" style={inputStyle} value={ruleForm.effective_from}
                onChange={(e) => setRuleForm((f) => ({ ...f, effective_from: e.target.value }))} />
            </label>
            <button className="add-btn" disabled={busy} onClick={() => {
              void post({
                action: "create_rule",
                tax_base: ruleForm.tax_base,
                shipping_taxable: ruleForm.shipping_taxable,
                prices_include_tax: ruleForm.prices_include_tax,
                tax_label: ruleForm.tax_label,
                effective_from: toIsoOrEmpty(ruleForm.effective_from),
              }, "New tax rules row saved. Applies to new orders only.");
            }}>Add new rules row</button>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Status</th><th>Label</th><th>Tax base</th><th>Shipping taxable</th><th>Prices incl. tax</th><th>Effective from</th></tr></thead>
              <tbody>
                {rules.length === 0 && (
                  <tr><td colSpan={6} style={{ textAlign: "center", color: "#888", padding: 20 }}>
                    No tax rules found. Checkout stays unavailable until the tax tables are set up.
                  </td></tr>
                )}
                {rules.map((r) => (
                  <tr key={r.id}>
                    <td>{r.id === currentRuleId ? <span className="status-badge status-delivered">Current</span> : new Date(r.effective_from).getTime() > nowMs ? <span className="status-badge status-pending">Upcoming</span> : <span style={{ color: "#aaa", fontSize: 12 }}>History</span>}</td>
                    <td style={{ fontWeight: 600 }}>{r.tax_label}</td>
                    <td>{r.tax_base === "after_discount" ? "After discount" : "Before discount"}</td>
                    <td>{isOn(r.shipping_taxable) ? "Yes" : "No"}</td>
                    <td>{isOn(r.prices_include_tax) ? "Yes" : "No"}</td>
                    <td style={{ fontSize: 12, color: "#888" }}>{fmtDate(r.effective_from)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Classes + rates */}
      <div className="section-card" style={{ marginBottom: 20 }}>
        <div className="section-header"><h3>Tax classes</h3></div>
        <div style={{ padding: "16px 20px" }}>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Class</th><th>Current rate</th><th>Applies to</th><th>Active</th></tr></thead>
              <tbody>
                {classes.length === 0 && (
                  <tr><td colSpan={4} style={{ textAlign: "center", color: "#888", padding: 20 }}>No tax classes found.</td></tr>
                )}
                {classes.map((c) => {
                  const eff = effectiveRateByClass.get(c.id);
                  return (
                    <tr key={c.id}>
                      <td style={{ fontWeight: 600 }}>{c.name}</td>
                      <td>{eff ? `${Number(eff.rate_percent)}%` : <span style={{ color: "#DC2626" }}>No rate set</span>}</td>
                      <td>
                        <select style={inputStyle} value={c.applies_to} disabled={busy}
                          onChange={(e) => { void updateClass(c.id, { applies_to: e.target.value }); }}>
                          <option value="both">Domestic + international</option>
                          <option value="domestic">Domestic only</option>
                          <option value="international">International only</option>
                        </select>
                      </td>
                      <td>
                        <input type="checkbox" checked={isOn(c.active)} disabled={busy}
                          onChange={(e) => { void updateClass(c.id, { active: e.target.checked }); }} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end", margin: "16px 0" }}>
            <label style={{ fontSize: 12 }}>New class name<br />
              <input style={{ ...inputStyle, width: 180 }} value={classForm.name} maxLength={100}
                onChange={(e) => setClassForm((f) => ({ ...f, name: e.target.value }))} />
            </label>
            <label style={{ fontSize: 12 }}>Applies to<br />
              <select style={inputStyle} value={classForm.applies_to}
                onChange={(e) => setClassForm((f) => ({ ...f, applies_to: e.target.value }))}>
                <option value="both">Domestic + international</option>
                <option value="domestic">Domestic only</option>
                <option value="international">International only</option>
              </select>
            </label>
            <button className="add-btn" disabled={busy || !classForm.name.trim()} onClick={() => {
              void post({ action: "create_class", name: classForm.name, applies_to: classForm.applies_to },
                "Tax class added. Add a rate row before assigning it to products.").then((ok) => {
                if (ok) setClassForm({ name: "", applies_to: "both" });
              });
            }}>Add class</button>
          </div>
        </div>
      </div>

      <div className="section-card">
        <div className="section-header"><h3>Rates (new dated row)</h3></div>
        <div style={{ padding: "16px 20px" }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end", marginBottom: 14 }}>
            <label style={{ fontSize: 12 }}>Class<br />
              <select style={inputStyle} value={rateForm.tax_class_id}
                onChange={(e) => setRateForm((f) => ({ ...f, tax_class_id: e.target.value }))}>
                <option value="">Select class…</option>
                {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <label style={{ fontSize: 12 }}>Rate %<br />
              <input style={{ ...inputStyle, width: 90 }} inputMode="decimal" placeholder="17" value={rateForm.rate_percent}
                onChange={(e) => setRateForm((f) => ({ ...f, rate_percent: e.target.value }))} />
            </label>
            <label style={{ fontSize: 12 }}>Effective from (optional)<br />
              <input type="datetime-local" style={inputStyle} value={rateForm.effective_from}
                onChange={(e) => setRateForm((f) => ({ ...f, effective_from: e.target.value }))} />
            </label>
            <button className="add-btn" disabled={busy || !rateForm.tax_class_id || rateForm.rate_percent === ""} onClick={() => {
              void post({
                action: "create_rate",
                tax_class_id: Number(rateForm.tax_class_id),
                rate_percent: rateForm.rate_percent,
                effective_from: toIsoOrEmpty(rateForm.effective_from),
              }, "New rate row saved. Applies to new orders only.").then((ok) => {
                if (ok) setRateForm({ tax_class_id: "", rate_percent: "", effective_from: "" });
              });
            }}>Add new rate row</button>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Status</th><th>Class</th><th>Rate</th><th>Effective from</th><th>Created by</th></tr></thead>
              <tbody>
                {rates.length === 0 && (
                  <tr><td colSpan={5} style={{ textAlign: "center", color: "#888", padding: 20 }}>No rates found.</td></tr>
                )}
                {rates.map((r) => (
                  <tr key={r.id}>
                    <td>{currentRateIds.has(r.id) ? <span className="status-badge status-delivered">Current</span> : new Date(r.effective_from).getTime() > nowMs ? <span className="status-badge status-pending">Upcoming</span> : <span style={{ color: "#aaa", fontSize: 12 }}>History</span>}</td>
                    <td>{classNameById.get(r.tax_class_id) ?? `#${r.tax_class_id}`}</td>
                    <td style={{ fontWeight: 600 }}>{Number(r.rate_percent)}%</td>
                    <td style={{ fontSize: 12, color: "#888" }}>{fmtDate(r.effective_from)}</td>
                    <td style={{ fontSize: 12, color: "#888" }}>{r.created_by || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
