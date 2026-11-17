"use client";

import { useCallback, useEffect, useState } from "react";
import { adminRequest } from "@/lib/adminRequest";
import AdminBanner from "./AdminBanner";
import { formatPrice } from "@/lib/site";

export type DashboardSummary = {
  success?: boolean;
  range?: {
    preset: string;
    from: string | null;
    to: string | null;
    label: string;
    timezone: string;
  };
  total_orders: number;
  pending_orders: number;
  pending_value: { incl: number; excl: number };
  confirmed_sales: { incl: number; excl: number; count: number };
  revenue: { incl: number; excl: number; count: number };
  tax_collected: { on_revenue: number; on_confirmed: number };
  cancelled_orders: number;
  cancelled_value: { incl: number; excl: number };
  customer_count: number;
  product_count: number;
  delivered_orders: number;
  vat_null_orders: number;
};

type Preset = "today" | "7d" | "30d" | "this_month" | "all" | "custom";

const PRESETS: { id: Preset; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "this_month", label: "This month" },
  { id: "all", label: "All time" },
  { id: "custom", label: "Custom" },
];

function tip(text: string) {
  return (
    <span
      title={text}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 16,
        height: 16,
        borderRadius: "50%",
        border: "1px solid #DDD6FE",
        color: "#7C3AED",
        fontSize: 11,
        marginLeft: 6,
        cursor: "help",
      }}
    >
      ?
    </span>
  );
}

function MoneyLines({ incl, excl }: { incl: number; excl: number }) {
  return (
    <>
      <div className="stat-value" data-dashboard-money="incl">
        {formatPrice(incl)}
      </div>
      <div style={{ fontSize: 12, color: "#666", marginTop: 2 }} data-dashboard-money="excl">
        excl. tax {formatPrice(excl)}
      </div>
    </>
  );
}

type Props = {
  /** Writers keep the legacy client dashboard — this component is for manager/super_admin only. */
  enabled: boolean;
};

export default function DashboardCards({ enabled }: Props) {
  const [preset, setPreset] = useState<Preset>("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const applyResult = useCallback((res: { ok: boolean; data?: DashboardSummary | null; errorMessage?: string }) => {
    if (!res.ok || res.data?.success !== true) {
      setData(null);
      setError(res.errorMessage || "Could not load dashboard summary.");
      setLoading(false);
      return;
    }
    setData(res.data);
    setError("");
    setLoading(false);
  }, []);

  const load = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    setError("");
    const q = new URLSearchParams({ preset });
    if (preset === "custom") {
      q.set("from", from);
      q.set("to", to);
    }
    const res = await adminRequest<DashboardSummary>(`/api/admin-dashboard-summary?${q.toString()}`);
    applyResult(res);
  }, [enabled, preset, from, to, applyResult]);

  // Initial + preset/range fetch: await first (no sync setState in the effect body).
  useEffect(() => {
    if (!enabled) return;
    if (preset === "custom" && (!from || !to)) return;
    let cancelled = false;
    void (async () => {
      const q = new URLSearchParams({ preset });
      if (preset === "custom") {
        q.set("from", from);
        q.set("to", to);
      }
      const res = await adminRequest<DashboardSummary>(`/api/admin-dashboard-summary?${q.toString()}`);
      if (cancelled) return;
      applyResult(res);
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, preset, from, to, applyResult]);

  if (!enabled) return null;

  return (
    <div data-dashboard-summary="1">
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 10,
          alignItems: "center",
          marginBottom: 14,
        }}
      >
        {PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            className="action-btn btn-view"
            data-dashboard-preset={p.id}
            aria-pressed={preset === p.id}
            onClick={() => setPreset(p.id)}
            style={{
              opacity: preset === p.id ? 1 : 0.7,
              borderColor: preset === p.id ? "#5B21B6" : undefined,
            }}
          >
            {p.label}
          </button>
        ))}
        <button
          type="button"
          className="add-btn"
          data-dashboard-refresh="1"
          onClick={() => void load()}
          disabled={loading}
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
        <span
          style={{ fontSize: 12, color: "#888" }}
          title="Filtered by orders.created_at in Asia/Karachi. There is no delivered_at column."
        >
          by order date (PKT)
        </span>
      </div>

      {preset === "custom" && (
        <div style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
          <label style={{ fontSize: 12 }}>
            From
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ display: "block", marginTop: 4 }} />
          </label>
          <label style={{ fontSize: 12 }}>
            To
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ display: "block", marginTop: 4 }} />
          </label>
        </div>
      )}

      {error && <AdminBanner message={error} tone="error" onRetry={() => void load()} />}

      {!data && !error && (
        <div className="stats-grid" data-dashboard-skeleton="1" aria-busy="true">
          {Array.from({ length: 6 }).map((_, i) => (
            <div className="stat-card" key={i} style={{ minHeight: 110, opacity: 0.5 }}>
              <div className="stat-label">Loading…</div>
            </div>
          ))}
        </div>
      )}

      {data && (
        <>
          <div className="stats-grid">
            <div className="stat-card">
              <div className="stat-card-top">
                <span className="stat-icon">🛒</span>
                <span className="stat-trend">All statuses</span>
              </div>
              <div className="stat-value" data-dashboard-card="total_orders">
                {data.total_orders}
              </div>
              <div className="stat-label">Total Orders</div>
            </div>

            <div className="stat-card">
              <div className="stat-card-top">
                <span className="stat-icon">⏳</span>
                <span className="stat-trend">Needs action</span>
              </div>
              <div className="stat-value" data-dashboard-card="pending_orders">
                {data.pending_orders}
              </div>
              <div className="stat-label">Pending Orders</div>
            </div>

            <div className="stat-card">
              <div className="stat-card-top">
                <span className="stat-icon">💳</span>
                <span className="stat-trend">
                  Pending
                  {tip("Pending orders only. Incl./excl. tax from stored order totals and vat_amount.")}
                </span>
              </div>
              <MoneyLines incl={data.pending_value.incl} excl={data.pending_value.excl} />
              <div className="stat-label">Pending value</div>
            </div>

            <div className="stat-card">
              <div className="stat-card-top">
                <span className="stat-icon">📦</span>
                <span className="stat-trend">
                  {data.confirmed_sales.count} orders
                  {tip("Confirmed Sales = confirmed + dispatched + delivered. Cancelled never included. Incl./excl. tax.")}
                </span>
              </div>
              <MoneyLines incl={data.confirmed_sales.incl} excl={data.confirmed_sales.excl} />
              <div className="stat-label">Confirmed Sales</div>
            </div>

            <div className="stat-card">
              <div className="stat-card-top">
                <span className="stat-icon">💰</span>
                <span className="stat-trend">
                  {data.revenue.count} delivered
                  {tip("Revenue = delivered orders only (every payment method counts on delivery). Incl./excl. tax.")}
                </span>
              </div>
              <MoneyLines incl={data.revenue.incl} excl={data.revenue.excl} />
              <div className="stat-label">Revenue</div>
            </div>

            <div className="stat-card">
              <div className="stat-card-top">
                <span className="stat-icon">🧾</span>
                <span className="stat-trend">
                  Tax
                  {tip("Tax collected = sum of stored vat_amount. Shown for revenue (delivered) and for confirmed sales.")}
                </span>
              </div>
              <div className="stat-value">{formatPrice(data.tax_collected.on_revenue)}</div>
              <div style={{ fontSize: 12, color: "#666", marginTop: 2 }}>
                on confirmed {formatPrice(data.tax_collected.on_confirmed)}
              </div>
              <div className="stat-label">Tax collected</div>
            </div>

            <div className="stat-card">
              <div className="stat-card-top">
                <span className="stat-icon">🚫</span>
                <span className="stat-trend">
                  Not revenue
                  {tip("Cancelled orders are never revenue or confirmed sales. Incl./excl. tax shown for reference only.")}
                </span>
              </div>
              <div className="stat-value" data-dashboard-card="cancelled_orders">
                {data.cancelled_orders}
              </div>
              <div style={{ fontSize: 12, color: "#666", marginTop: 2 }}>
                {formatPrice(data.cancelled_value.incl)} incl / {formatPrice(data.cancelled_value.excl)} excl
              </div>
              <div className="stat-label">Cancelled</div>
            </div>

            <div className="stat-card">
              <div className="stat-card-top">
                <span className="stat-icon">👥</span>
                <span className="stat-trend">Unique email</span>
              </div>
              <div className="stat-value" data-dashboard-card="customers">
                {data.customer_count}
              </div>
              <div className="stat-label">Customers</div>
            </div>

            <div className="stat-card">
              <div className="stat-card-top">
                <span className="stat-icon">📦</span>
                <span className="stat-trend">Active</span>
              </div>
              <div className="stat-value" data-dashboard-card="products">
                {data.product_count}
              </div>
              <div className="stat-label">Products</div>
            </div>

            <div className="stat-card">
              <div className="stat-card-top">
                <span className="stat-icon">✅</span>
                <span className="stat-trend">Delivered</span>
              </div>
              <div className="stat-value" data-dashboard-card="delivered">
                {data.delivered_orders}
              </div>
              <div className="stat-label">Delivered</div>
            </div>
          </div>

          {data.vat_null_orders > 0 && (
            <p style={{ fontSize: 12, color: "#888", marginTop: 8 }}>
              Note: {data.vat_null_orders} order(s) in this range have no stored tax amount (treated as 0 for excl. tax).
            </p>
          )}
        </>
      )}
    </div>
  );
}
