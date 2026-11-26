"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchDashboardSummaryWithRetry } from "@/lib/dashboardSummaryFetch";
import { formatPrice } from "@/lib/site";
import {
  COD_RTO_AMBER,
  COD_RTO_RED,
  codInsightsCsv,
  codInsightsCsvFilename,
  type CodInsightRow,
  type CodInsightsBundle,
  type CodInsightsRange,
} from "@/lib/codInsights";

type Preset = "today" | "7d" | "30d" | "this_month" | "all" | "custom";

type TabId = "city" | "province" | "payment" | "courier" | "zone";

const PRESETS: { id: Preset; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "this_month", label: "This month" },
  { id: "all", label: "All time" },
  { id: "custom", label: "Custom" },
];

const TABS: { id: TabId; label: string; field: keyof CodInsightsBundle }[] = [
  { id: "city", label: "City", field: "by_city" },
  { id: "province", label: "Province", field: "by_province" },
  { id: "payment", label: "Payment", field: "by_payment" },
  { id: "courier", label: "Courier", field: "by_courier" },
  { id: "zone", label: "Zone", field: "by_zone" },
];

type ApiPayload = {
  success?: boolean;
  revenue?: { incl: number; excl: number; count: number };
  cod_insights?: CodInsightsBundle & { range?: CodInsightsRange };
};

function rateColor(rate: number | null): string | undefined {
  if (rate == null) return undefined;
  if (rate >= COD_RTO_RED) return "#B91C1C";
  if (rate >= COD_RTO_AMBER) return "#B45309";
  return undefined;
}

function fmtRate(rate: number | null): string {
  if (rate == null) return "—";
  return `${rate.toFixed(1)}%`;
}

function downloadCsv(insights: CodInsightsBundle, range: CodInsightsRange) {
  const csv = codInsightsCsv(insights, range);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = codInsightsCsvFilename(range);
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

type Props = {
  /** When false (writer), render nothing — same gate as DashboardCards. */
  enabled: boolean;
};

export default function CodInsightsPanel({ enabled }: Props) {
  const [preset, setPreset] = useState<Preset>("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [tab, setTab] = useState<TabId>("city");
  const [insights, setInsights] = useState<(CodInsightsBundle & { range?: CodInsightsRange }) | null>(
    null
  );
  const [revenueIncl, setRevenueIncl] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    setError("");
    const q = new URLSearchParams({ preset, include: "cod_insights" });
    if (preset === "custom") {
      q.set("from", from);
      q.set("to", to);
    }
    const res = await fetchDashboardSummaryWithRetry<ApiPayload>(
      `/api/admin-dashboard-summary?${q.toString()}`
    );
    if (!res.ok || res.data?.success !== true || !res.data.cod_insights) {
      setInsights(null);
      setRevenueIncl(null);
      setError(res.errorMessage || "Could not load COD insights.");
      setLoading(false);
      return;
    }
    setInsights(res.data.cod_insights);
    setRevenueIncl(res.data.revenue?.incl ?? null);
    setError("");
    setLoading(false);
  }, [enabled, preset, from, to]);

  useEffect(() => {
    if (!enabled) return;
    if (preset === "custom" && (!from || !to)) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError("");
      const q = new URLSearchParams({ preset, include: "cod_insights" });
      if (preset === "custom") {
        q.set("from", from);
        q.set("to", to);
      }
      const res = await fetchDashboardSummaryWithRetry<ApiPayload>(
        `/api/admin-dashboard-summary?${q.toString()}`,
        { isCancelled: () => cancelled }
      );
      if (cancelled) return;
      if (!res.ok || res.data?.success !== true || !res.data.cod_insights) {
        setInsights(null);
        setRevenueIncl(null);
        setError(res.errorMessage || "Could not load COD insights.");
        setLoading(false);
        return;
      }
      setInsights(res.data.cod_insights);
      setRevenueIncl(res.data.revenue?.incl ?? null);
      setError("");
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, preset, from, to]);

  if (!enabled) return null;

  const activeTab = TABS.find((t) => t.id === tab) || TABS[0];
  const rows: CodInsightRow[] =
    insights && activeTab.field !== "totals"
      ? (insights[activeTab.field] as CodInsightRow[])
      : [];

  const range: CodInsightsRange = insights?.range || {
    preset,
    from: preset === "custom" ? from || null : null,
    to: preset === "custom" ? to || null : null,
  };

  return (
    <div
      className="section-card"
      data-cod-insights="1"
      style={{ marginTop: 16 }}
    >
      <div className="section-header" style={{ flexWrap: "wrap", gap: 8 }}>
        <div className="section-title">COD &amp; delivery insights</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className="action-btn btn-view"
              data-cod-preset={p.id}
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
          {preset === "custom" && (
            <>
              <input
                type="date"
                data-cod-from="1"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                aria-label="From date"
              />
              <input
                type="date"
                data-cod-to="1"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                aria-label="To date"
              />
            </>
          )}
          <button type="button" className="add-btn" data-cod-refresh="1" onClick={() => void load()}>
            Refresh
          </button>
          <button
            type="button"
            className="add-btn"
            data-cod-csv="1"
            disabled={!insights}
            onClick={() => insights && downloadCsv(insights, range)}
          >
            Download CSV
          </button>
        </div>
      </div>

      <p style={{ fontSize: 12, color: "#666", margin: "0 0 10px" }}>
        High RTO: amber ≥ {COD_RTO_AMBER}%, red ≥ {COD_RTO_RED}%. Revenue = delivered only (matches
        Revenue tile).
        {revenueIncl != null && insights ? (
          <span data-cod-revenue-check="1">
            {" "}
            Delivered revenue {formatPrice(insights.totals.delivered_revenue)}
            {Math.abs(insights.totals.delivered_revenue - revenueIncl) < 0.005
              ? " (= Revenue tile)"
              : ""}
          </span>
        ) : null}
      </p>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className="action-btn btn-view"
            data-cod-tab={t.id}
            aria-pressed={tab === t.id}
            onClick={() => setTab(t.id)}
            style={{
              opacity: tab === t.id ? 1 : 0.7,
              borderColor: tab === t.id ? "#5B21B6" : undefined,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading && (
        <p data-cod-loading="1" style={{ color: "#888", fontSize: 13 }}>
          Loading insights…
        </p>
      )}
      {!loading && error && (
        <p data-cod-error="1" style={{ color: "#B91C1C", fontSize: 13 }}>
          {error}
        </p>
      )}
      {!loading && !error && rows.length === 0 && (
        <p data-cod-empty="1" style={{ color: "#888", fontSize: 13 }}>
          No orders in this range.
        </p>
      )}
      {!loading && !error && rows.length > 0 && (
        <div className="table-wrap">
          <table data-cod-table={tab}>
            <thead>
              <tr>
                <th>{activeTab.label}</th>
                <th>Orders</th>
                <th>Delivered</th>
                <th>RTO</th>
                <th>Cancelled</th>
                <th>Open</th>
                <th>RTO rate</th>
                <th>Cancel rate</th>
                <th>Delivered revenue (incl. GST)</th>
                <th>(excl. GST)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const color = rateColor(r.rto_rate);
                return (
                  <tr key={r.key} data-cod-row={r.key}>
                    <td>{r.key}</td>
                    <td>{r.orders}</td>
                    <td>{r.delivered}</td>
                    <td>{r.rto}</td>
                    <td>{r.cancelled}</td>
                    <td>{r.open}</td>
                    <td
                      style={color ? { color, fontWeight: 700 } : undefined}
                      title={color ? "High RTO" : undefined}
                      data-cod-rto-rate={r.rto_rate == null ? "" : String(r.rto_rate)}
                    >
                      {fmtRate(r.rto_rate)}
                    </td>
                    <td>{fmtRate(r.cancel_rate)}</td>
                    <td>{formatPrice(r.delivered_revenue)}</td>
                    <td>{formatPrice(r.delivered_revenue_ex_gst)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
