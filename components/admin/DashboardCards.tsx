"use client";

import { useCallback, useEffect, useState } from "react";
import { adminRequest } from "@/lib/adminRequest";
import AdminBanner from "./AdminBanner";
import { formatPrice } from "@/lib/site";
import { LOW_STOCK_CONTENT_KEY } from "@/lib/dashboardExtras";

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
  revenue_trend?: {
    bucket: "day" | "month";
    points: { key: string; label: string; incl: number; excl: number }[];
  };
  top_products?: {
    by_units: { product_id: number | null; name: string; units: number; revenue: number }[];
    by_revenue: { product_id: number | null; name: string; units: number; revenue: number }[];
  };
  low_stock?: {
    threshold: number;
    count: number;
    products: { id: number; name: string; stock_quantity: number }[];
  };
  cancel_reasons?: { reason: string; count: number }[];
  payment_methods?: { method: string; count: number; total: number }[];
  oldest_pending?: {
    order_id: string;
    age_hours: number;
    age_label: string;
    total: number;
    created_at: string;
  }[];
  coupon_usage?: { code: string; orders: number; discount_total: number }[];
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

function TrendChart({
  points,
}: {
  points: { key: string; label: string; incl: number; excl: number }[];
}) {
  const w = 560;
  const h = 160;
  const pad = 24;
  const max = Math.max(1, ...points.map((p) => p.incl));
  const coords = points.map((p, i) => {
    const x = pad + (points.length <= 1 ? 0 : (i / (points.length - 1)) * (w - pad * 2));
    const y = h - pad - (p.incl / max) * (h - pad * 2);
    return { x, y, ...p };
  });
  const poly = coords.map((c) => `${c.x},${c.y}`).join(" ");

  return (
    <div data-dashboard-trend="1">
      {points.length === 0 ? (
        <p data-dashboard-trend-empty="1" style={{ fontSize: 13, color: "#888", margin: "8px 0" }}>
          No delivered revenue in this range.
        </p>
      ) : (
        <>
          <svg
            role="img"
            aria-label="Revenue trend chart"
            viewBox={`0 0 ${w} ${h}`}
            width="100%"
            height={h}
            data-dashboard-trend-chart="1"
            style={{ background: "#FAFAFC", borderRadius: 8 }}
          >
            <polyline
              fill="none"
              stroke="#5B21B6"
              strokeWidth="2"
              points={poly}
            />
            {coords.map((c) => (
              <circle key={c.key} cx={c.x} cy={c.y} r={3} fill="#5B21B6">
                <title>{`${c.label}: ${c.incl}`}</title>
              </circle>
            ))}
          </svg>
          <table data-dashboard-trend-table="1" style={{ width: "100%", fontSize: 12, marginTop: 8 }}>
            <caption style={{ textAlign: "left", fontWeight: 600, marginBottom: 4 }}>
              Revenue trend (table)
            </caption>
            <thead>
              <tr>
                <th scope="col">Bucket</th>
                <th scope="col">Incl. tax</th>
                <th scope="col">Excl. tax</th>
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.key}>
                  <td>{p.label}</td>
                  <td>{formatPrice(p.incl)}</td>
                  <td>{formatPrice(p.excl)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

type Props = {
  /** Writers keep the legacy client dashboard — this component is for manager/super_admin only. */
  enabled: boolean;
  onOpenOrder?: (orderId: string) => void;
  onNavigateTab?: (tab: "products" | "orders") => void;
};

export default function DashboardCards({ enabled, onOpenOrder, onNavigateTab }: Props) {
  const [preset, setPreset] = useState<Preset>("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [thresholdDraft, setThresholdDraft] = useState("5");
  const [thresholdMsg, setThresholdMsg] = useState("");
  const [thresholdSaving, setThresholdSaving] = useState(false);

  const applyResult = useCallback((res: { ok: boolean; data?: DashboardSummary | null; errorMessage?: string }) => {
    if (!res.ok || res.data?.success !== true) {
      setData(null);
      setError(res.errorMessage || "Could not load dashboard summary.");
      setLoading(false);
      return;
    }
    setData(res.data);
    if (res.data.low_stock) {
      setThresholdDraft(String(res.data.low_stock.threshold));
    }
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

  const saveThreshold = useCallback(async () => {
    setThresholdSaving(true);
    setThresholdMsg("");
    const res = await adminRequest<{ success?: boolean }>("/api/site-content", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: LOW_STOCK_CONTENT_KEY, value: thresholdDraft }),
    });
    if (!res.ok || res.data?.success !== true) {
      setThresholdMsg(res.errorMessage || "Could not save threshold.");
      setThresholdSaving(false);
      return;
    }
    setThresholdMsg("Saved.");
    setThresholdSaving(false);
    await load();
  }, [thresholdDraft, load]);

  if (!enabled) return null;

  const extras = data;

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

          {/* ADMIN-DASH-02 extras */}
          <div data-dashboard-extras="1" style={{ marginTop: 20, display: "grid", gap: 16 }}>
            <section className="section-card" data-dashboard-panel="trend">
              <div className="section-header">
                <div className="section-title">
                  Revenue trend
                  {tip("Delivered orders only. Daily buckets in PKT for ranged presets; monthly for All time. Max 90 points.")}
                </div>
                <span style={{ fontSize: 12, color: "#888" }}>
                  {extras?.revenue_trend?.bucket === "month" ? "Monthly" : "Daily"}
                </span>
              </div>
              <TrendChart points={extras?.revenue_trend?.points || []} />
            </section>

            <section className="section-card" data-dashboard-panel="top-products">
              <div className="section-header">
                <div className="section-title">Top products</div>
              </div>
              {!(extras?.top_products?.by_units?.length) && !(extras?.top_products?.by_revenue?.length) ? (
                <p data-dashboard-top-products-empty="1" style={{ fontSize: 13, color: "#888" }}>
                  No delivered product sales in this range.
                </p>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <div data-dashboard-top-units="1">
                    <strong style={{ fontSize: 13 }}>By units</strong>
                    <ol style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 13 }}>
                      {(extras?.top_products?.by_units || []).map((p) => (
                        <li key={`u-${p.name}`}>{p.name} — {p.units} units</li>
                      ))}
                    </ol>
                  </div>
                  <div data-dashboard-top-revenue="1">
                    <strong style={{ fontSize: 13 }}>By revenue</strong>
                    <ol style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 13 }}>
                      {(extras?.top_products?.by_revenue || []).map((p) => (
                        <li key={`r-${p.name}`}>{p.name} — {formatPrice(p.revenue)}</li>
                      ))}
                    </ol>
                  </div>
                </div>
              )}
            </section>

            <section className="section-card" data-dashboard-panel="low-stock">
              <div className="section-header">
                <div className="section-title">
                  Low stock
                  {tip("Active products with track_inventory=1 and stock_quantity ≤ threshold.")}
                </div>
                <button
                  type="button"
                  className="action-btn btn-view"
                  data-dashboard-low-stock-products="1"
                  onClick={() => onNavigateTab?.("products")}
                >
                  Products →
                </button>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
                <label style={{ fontSize: 12 }}>
                  Threshold
                  <input
                    data-dashboard-low-stock-threshold="1"
                    type="number"
                    min={0}
                    max={9999}
                    value={thresholdDraft}
                    onChange={(e) => setThresholdDraft(e.target.value)}
                    style={{ marginLeft: 8, width: 72 }}
                  />
                </label>
                <button
                  type="button"
                  className="add-btn"
                  data-dashboard-low-stock-save="1"
                  disabled={thresholdSaving}
                  onClick={() => void saveThreshold()}
                >
                  {thresholdSaving ? "Saving…" : "Save"}
                </button>
                {thresholdMsg && (
                  <span data-dashboard-low-stock-save-msg="1" style={{ fontSize: 12, color: "#666" }}>
                    {thresholdMsg}
                  </span>
                )}
              </div>
              <div className="stat-value" data-dashboard-low-stock-count="1" style={{ fontSize: 22 }}>
                {extras?.low_stock?.count ?? 0}
              </div>
              <div className="stat-label">products at or below threshold ({extras?.low_stock?.threshold ?? 5})</div>
              {(extras?.low_stock?.products?.length || 0) === 0 ? (
                <p data-dashboard-low-stock-empty="1" style={{ fontSize: 13, color: "#888", marginTop: 8 }}>
                  None right now.
                </p>
              ) : (
                <ul data-dashboard-low-stock-list="1" style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 13 }}>
                  {(extras?.low_stock?.products || []).map((p) => (
                    <li key={p.id} data-product-id={p.id}>
                      {p.name} — stock {p.stock_quantity}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="section-card" data-dashboard-panel="cancel-reasons">
              <div className="section-header">
                <div className="section-title">Cancel reasons</div>
              </div>
              {(extras?.cancel_reasons?.length || 0) === 0 ? (
                <p data-dashboard-cancel-empty="1" style={{ fontSize: 13, color: "#888" }}>
                  No cancelled orders in this range.
                </p>
              ) : (
                <ul data-dashboard-cancel-list="1" style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                  {(extras?.cancel_reasons || []).map((r) => (
                    <li key={r.reason}>{r.reason}: {r.count}</li>
                  ))}
                </ul>
              )}
            </section>

            <section className="section-card" data-dashboard-panel="payment-methods">
              <div className="section-header">
                <div className="section-title">
                  Payment methods
                  {tip("Order count and total by payment_method for the range. All non-cancelled statuses.")}
                </div>
              </div>
              <p style={{ fontSize: 12, color: "#888", marginTop: 0 }}>
                Rule: all non-cancelled statuses in the selected range.
              </p>
              {(extras?.payment_methods?.length || 0) === 0 ? (
                <p data-dashboard-pay-empty="1" style={{ fontSize: 13, color: "#888" }}>
                  No matching orders.
                </p>
              ) : (
                <ul data-dashboard-pay-list="1" style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                  {(extras?.payment_methods || []).map((m) => (
                    <li key={m.method}>
                      {m.method}: {m.count} orders · {formatPrice(m.total)}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="section-card" data-dashboard-panel="oldest-pending">
              <div className="section-header">
                <div className="section-title">Oldest pending</div>
              </div>
              {(extras?.oldest_pending?.length || 0) === 0 ? (
                <p data-dashboard-pending-empty="1" style={{ fontSize: 13, color: "#888" }}>
                  No pending orders.
                </p>
              ) : (
                <ul data-dashboard-pending-list="1" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                  {(extras?.oldest_pending || []).map((o) => (
                    <li key={o.order_id} style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 6, fontSize: 13 }}>
                      <button
                        type="button"
                        className="action-btn btn-view"
                        data-dashboard-pending-open={o.order_id}
                        onClick={() => onOpenOrder?.(o.order_id)}
                      >
                        {o.order_id}
                      </button>
                      <span>{o.age_label}</span>
                      <span>{formatPrice(o.total)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="section-card" data-dashboard-panel="coupon-usage">
              <div className="section-header">
                <div className="section-title">Coupon usage</div>
              </div>
              {(extras?.coupon_usage?.length || 0) === 0 ? (
                <p data-dashboard-coupon-empty="1" style={{ fontSize: 13, color: "#888" }}>
                  No coupon usage in this range.
                </p>
              ) : (
                <ul data-dashboard-coupon-list="1" style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                  {(extras?.coupon_usage || []).map((c) => (
                    <li key={c.code}>
                      {c.code}: {c.orders} orders · discount {formatPrice(c.discount_total)}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
