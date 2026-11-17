"use client";

import { useEffect, useState } from "react";
import { adminRequest } from "../../lib/adminRequest";
import { formatPrice } from "../../lib/site";
import { paymentLabel } from "./OrdersToolbar";

type OrderStatus = "pending" | "confirmed" | "dispatched" | "delivered" | "cancelled";

type DetailOrder = {
  order_id?: string;
  status?: string;
  customer_name?: string;
  customer_email?: string;
  customer_phone?: string;
  delivery_address?: string;
  city?: string;
  postcode?: string;
  payment_method?: string;
  payment_reference?: string;
  discount_amount?: number | string | null;
  coupon_code?: string | null;
  vat_amount?: number | string | null;
  total?: number | string | null;
  notes?: string | null;
  cancel_reason?: string | null;
  created_at_pkt?: string;
  receipt_url?: string | null;
};

type DetailItem = {
  id?: number;
  product_name?: string;
  price?: number | string;
  quantity?: number | string;
  line_total?: number | string;
};

type DetailTax = {
  label?: string;
  vat_amount?: number | string;
  has_snapshot?: boolean;
};

type DetailResponse = {
  order?: DetailOrder;
  items?: DetailItem[];
  tax?: DetailTax;
};

type FetchState = {
  key: string;
  ok: boolean;
  data: DetailResponse | null;
  error: string;
};

export type OrderDetailDrawerProps = {
  orderId: string | null;
  open: boolean;
  onClose: () => void;
  onStatusChange: (orderId: string, status: OrderStatus) => void;
  onDelete: (orderId: string, total: string, status: string) => void;
  onViewReceipt: (orderId: string, receiptUrl: string) => void;
};

const money = (v: unknown) => formatPrice(Number(v || 0));
const text = (v: unknown) => {
  const s = v == null ? "" : String(v).trim();
  return s || "—";
};

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: "flex", gap: 12, padding: "6px 0", borderBottom: "1px solid #F5F5F5" }}>
      <div style={{ width: 130, flexShrink: 0, fontSize: 12, color: "#666", fontWeight: 600 }}>
        {label}
      </div>
      <div
        style={{
          fontSize: 13,
          color: "#111",
          wordBreak: "break-word",
          whiteSpace: "pre-wrap",
          fontFamily: mono ? "monospace" : undefined,
        }}
      >
        {value}
      </div>
    </div>
  );
}

/**
 * Right-hand drawer with full order detail. Fetches GET /api/admin-orders?id=
 * when opened. All server values are rendered as plain React text nodes.
 */
export default function OrderDetailDrawer({
  orderId,
  open,
  onClose,
  onStatusChange,
  onDelete,
  onViewReceipt,
}: OrderDetailDrawerProps) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<FetchState | null>(null);

  const active = open && !!orderId;
  const requestKey = active ? `${orderId}:${attempt}` : "";

  useEffect(() => {
    if (!active || !orderId) return;
    let cancelled = false;
    const key = `${orderId}:${attempt}`;
    (async () => {
      const res = await adminRequest<DetailResponse>(
        `/api/admin-orders?id=${encodeURIComponent(orderId)}`
      );
      if (cancelled) return;
      if (!res.ok || !res.data?.order) {
        setResult({
          key,
          ok: false,
          data: null,
          error: res.errorMessage || "Could not load order.",
        });
        return;
      }
      setResult({ key, ok: true, data: res.data, error: "" });
    })();
    return () => {
      cancelled = true;
    };
  }, [active, orderId, attempt]);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, onClose]);

  if (!active || !orderId) return null;

  const loading = !result || result.key !== requestKey;
  const failed = !loading && result && !result.ok;
  const order = !loading && result?.ok ? result.data?.order : undefined;
  const items = (!loading && result?.ok && result.data?.items) || [];
  const tax = (!loading && result?.ok && result.data?.tax) || undefined;

  const status = String(order?.status || "pending");
  const isCancelled = status === "cancelled";
  const address = order
    ? [order.delivery_address, order.city, order.postcode]
        .filter((p) => p != null && String(p).trim())
        .join(", ")
    : "";
  const discountNum = Number(order?.discount_amount || 0);
  const receiptUrl =
    order?.receipt_url && String(order.receipt_url).trim() ? String(order.receipt_url).trim() : "";
  const taxLabel = tax?.has_snapshot && tax.label && tax.label.trim() ? tax.label.trim() : "Tax";
  const taxAmount = tax?.vat_amount ?? order?.vat_amount ?? 0;

  return (
    <div
      data-order-detail-overlay="1"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.35)",
        zIndex: 300,
        display: "flex",
        justifyContent: "flex-end",
      }}
    >
      <aside
        data-order-detail="1"
        role="dialog"
        aria-modal="true"
        aria-label={`Order ${orderId}`}
        style={{
          background: "#FFFFFF",
          width: "100%",
          maxWidth: 520,
          height: "100%",
          overflowY: "auto",
          padding: 24,
          boxShadow: "-8px 0 32px rgba(0,0,0,0.12)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div className="modal-title" style={{ margin: 0 }}>
            Order — {orderId}
          </div>
          <button
            type="button"
            className="modal-cancel"
            data-order-detail-close="1"
            onClick={onClose}
            aria-label="Close order details"
          >
            Close
          </button>
        </div>

        {loading ? (
          <div data-order-detail-loading="1" style={{ padding: "24px 0", color: "#666", fontSize: 13 }}>
            Loading order…
          </div>
        ) : null}

        {failed ? (
          <div
            role="alert"
            data-order-detail-error="1"
            style={{
              padding: "10px 14px",
              borderRadius: 10,
              fontSize: 13,
              background: "rgba(220,38,38,0.08)",
              border: "1px solid rgba(220,38,38,0.25)",
              color: "#DC2626",
              display: "flex",
              gap: 12,
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span>{result?.error || "Could not load order."}</span>
            <button
              type="button"
              className="action-btn btn-view"
              data-order-detail-retry="1"
              onClick={() => setAttempt((n) => n + 1)}
              style={{ marginRight: 0 }}
            >
              Retry
            </button>
          </div>
        ) : null}

        {order ? (
          <>
            <div style={{ marginBottom: 12 }}>
              <span className={`status-badge status-${status}`} data-order-status={status}>
                {status}
              </span>
            </div>

            <Row label="Placed (PKT)" value={text(order.created_at_pkt)} />
            <Row label="Customer" value={text(order.customer_name)} />
            <Row label="Email" value={text(order.customer_email)} />
            <Row label="Phone / WhatsApp" value={text(order.customer_phone)} />
            <Row label="Delivery address" value={text(address)} />
            <Row label="Payment method" value={paymentLabel(order.payment_method)} />
            {order.payment_reference && String(order.payment_reference).trim() ? (
              <Row label="Payment reference" value={String(order.payment_reference)} mono />
            ) : null}
            <Row label="Coupon" value={text(order.coupon_code)} mono />
            <Row label="Notes" value={text(order.notes)} />
            {isCancelled ? (
              <div data-cancel-reason-display="1">
                <Row
                  label="Cancellation reason"
                  value={
                    order.cancel_reason && String(order.cancel_reason).trim()
                      ? String(order.cancel_reason)
                      : "No reason recorded"
                  }
                />
              </div>
            ) : null}

            <div style={{ margin: "16px 0 6px", fontSize: 12, fontWeight: 700, color: "#666" }}>
              Items
            </div>
            <div className="table-wrap">
              <table data-order-detail-items="1">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Price</th>
                    <th>Qty</th>
                    <th>Line total</th>
                  </tr>
                </thead>
                <tbody>
                  {items.length === 0 ? (
                    <tr>
                      <td colSpan={4} style={{ textAlign: "center", color: "#999" }}>
                        No items recorded.
                      </td>
                    </tr>
                  ) : (
                    items.map((it, i) => (
                      <tr key={it.id ?? i}>
                        <td>{text(it.product_name)}</td>
                        <td>{money(it.price)}</td>
                        <td>{text(it.quantity)}</td>
                        <td>{money(it.line_total ?? Number(it.price || 0) * Number(it.quantity || 0))}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <div style={{ marginTop: 12 }}>
              {discountNum > 0 ? (
                <Row label="Discount" value={`− ${money(discountNum)}`} />
              ) : null}
              <Row label={taxLabel} value={money(taxAmount)} />
              <Row label="Total" value={money(order.total)} />
            </div>

            <div style={{ marginTop: 12 }}>
              {receiptUrl ? (
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <a
                    href={receiptUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-order-detail-receipt="1"
                    style={{ fontSize: 13, color: "#5B21B6" }}
                  >
                    Open receipt
                  </a>
                  <button
                    type="button"
                    className="action-btn btn-view"
                    onClick={() => onViewReceipt(orderId, receiptUrl)}
                  >
                    Preview / verify
                  </button>
                </div>
              ) : (
                <div style={{ fontSize: 12, color: "#999" }}>No receipt uploaded.</div>
              )}
            </div>

            <div className="modal-field" style={{ marginTop: 16 }}>
              <label htmlFor="order-detail-status">Update Status</label>
              {isCancelled ? (
                <select
                  id="order-detail-status"
                  key={`status-${orderId}-cancelled`}
                  value="cancelled"
                  disabled
                  data-status-terminal="1"
                >
                  <option value="cancelled">Cancelled</option>
                </select>
              ) : (
                <select
                  id="order-detail-status"
                  key={`status-${orderId}-${status}`}
                  defaultValue={status}
                  data-status-select="1"
                  onChange={(e) => onStatusChange(orderId, e.target.value as OrderStatus)}
                >
                  <option value="pending">Pending</option>
                  <option value="confirmed">Confirmed</option>
                  <option value="dispatched">Dispatched</option>
                  <option value="delivered">Delivered</option>
                  <option value="cancelled">Cancelled</option>
                </select>
              )}
            </div>

            <div style={{ marginTop: 8 }}>
              <button
                type="button"
                className="modal-cancel"
                data-order-detail-delete="1"
                style={{
                  background: "rgba(220,38,38,0.1)",
                  color: "#DC2626",
                  border: "1px solid rgba(220,38,38,0.25)",
                }}
                onClick={() => onDelete(orderId, money(order.total), status)}
              >
                Delete Order
              </button>
            </div>
          </>
        ) : null}
      </aside>
    </div>
  );
}
