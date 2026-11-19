"use client";

import { useEffect, useState } from "react";
import { adminRequest } from "../../lib/adminRequest";
import { formatPrice } from "../../lib/site";
import { paymentLabel } from "./OrdersToolbar";

type OrderStatus = "pending" | "confirmed" | "ready_for_pickup" | "dispatched" | "delivered" | "cancelled";

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
  risk_score?: number | string | null;
  risk_reason_labels?: string[];
  otp_verified?: boolean | null;
  confirmation_method?: string | null;
  confirmation_note?: string | null;
  confirmed_by?: string | null;
  confirmed_at?: string | null;
  // Shipping / courier / RTO: only present when migration 0009 is applied (BATCH-12).
  shipping_amount?: number | string | null;
  shipping_zone?: string | null;
  courier_id?: number | null;
  courier_name?: string | null;
  tracking_number?: string | null;
  tracking_url?: string | null;
  shipped_at?: string | null;
  delivered_at?: string | null;
  rto?: boolean | null;
  rto_at?: string | null;
  couriers?: Array<{ id: number; name: string }>;
  // Delivery ops: only present once migration 0010 is applied and the order / shipping flag warrants it (BATCH-17).
  fulfilment?: "delivery" | "pickup";
  shipping_area?: string | null;
  rider_id?: number | null;
  rider_name?: string | null;
  pickup_point_id?: number | null;
  pickup_point_name?: string | null;
  pickup_point_address?: string | null;
  pickup_point_hours?: string | null;
  riders?: Array<{ id: number; name: string }>;
};

/** Courier + tracking number sent with a status change to "dispatched" (shipping enabled only). */
export type DispatchShipping = { courier_id?: number; tracking_number?: string; rider_id?: number };

const TRACKING_NUMBER_RE = /^[A-Za-z0-9-]{3,100}$/;

function formatWhen(v: unknown): string {
  if (v == null || v === "") return "";
  const d = new Date(String(v));
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Karachi",
  });
}

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
  onStatusChange: (orderId: string, status: OrderStatus, shipping?: DispatchShipping) => void;
  onDelete: (orderId: string, total: string, status: string) => void;
  /** Order delete is super_admin only server-side; hide the control for other roles. Defaults to true. */
  canDelete?: boolean;
  onViewReceipt: (orderId: string, receiptUrl: string) => void;
  /** Show "Block customer" (super_admin | manager; the API enforces customers:block). Defaults to false. */
  canBlock?: boolean;
  /** Called after a COD order is confirmed from the drawer so the parent can refresh its lists. */
  onConfirmed?: () => void;
  /**
   * shipping_enabled flag as known by the parent. Dispatch courier fields and the RTO action only
   * appear when this is true; with it off the drawer is exactly as before. Defaults to false.
   */
  shippingEnabled?: boolean;
  /** Called after an order is marked returned-to-origin (it is cancelled + restocked server-side). */
  onReturned?: () => void;
};

type ProtectionDialog = { orderId: string; kind: "confirm" | "block" | "rto" | "dispatch" };

const fieldStyle: React.CSSProperties = {
  padding: "8px 10px",
  border: "1px solid #E5E5E5",
  borderRadius: 8,
  fontSize: 13,
  background: "#fff",
  color: "#111",
  width: "100%",
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
  canDelete = true,
  onViewReceipt,
  canBlock = false,
  onConfirmed,
  shippingEnabled = false,
  onReturned,
}: OrderDetailDrawerProps) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<FetchState | null>(null);
  const [dialog, setDialog] = useState<ProtectionDialog | null>(null);
  const [confirmMethod, setConfirmMethod] = useState<"call" | "whatsapp">("call");
  const [confirmNote, setConfirmNote] = useState("");
  const [blockReason, setBlockReason] = useState("");
  const [dispatchCourier, setDispatchCourier] = useState("");
  const [dispatchTracking, setDispatchTracking] = useState("");
  const [dispatchRider, setDispatchRider] = useState("");
  const [statusSelectNonce, setStatusSelectNonce] = useState(0);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionMsg, setActionMsg] = useState<{ orderId: string; tone: "ok" | "error"; text: string } | null>(null);

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

  const riskScore =
    order?.risk_score != null && order.risk_score !== "" && Number.isFinite(Number(order.risk_score))
      ? Number(order.risk_score)
      : null;
  const riskLabels = Array.isArray(order?.risk_reason_labels) ? order.risk_reason_labels : [];
  const isCod = String(order?.payment_method || "") === "cod";
  const canConfirmCod = isCod && status === "pending" && !order?.confirmed_at;
  const activeDialog = dialog && dialog.orderId === orderId ? dialog.kind : null;
  const msg = actionMsg && actionMsg.orderId === orderId ? actionMsg : null;

  // Shipping (BATCH-12). Everything below stays inert while the flag is off / columns are absent.
  const shippingUi = shippingEnabled && Array.isArray(order?.couriers);
  const courierOptions = Array.isArray(order?.couriers) ? order.couriers : [];
  const isRto = order?.rto === true;
  // Delivery ops (BATCH-17): pickup orders never dispatch / RTO; own-rider dispatch picks an active rider.
  const isPickup = order?.fulfilment === "pickup";
  const opsShown = order?.fulfilment !== undefined;
  const riderOptions = Array.isArray(order?.riders) ? order.riders : [];
  const canRto = shippingUi && status === "dispatched" && !isRto && !isPickup;
  const shipZone = order?.shipping_zone && String(order.shipping_zone).trim() ? String(order.shipping_zone).trim() : "";
  const shipAmountNum = Number(order?.shipping_amount || 0);
  const showShipping = !!shipZone || shipAmountNum > 0;
  const shippedAt = formatWhen(order?.shipped_at);
  const deliveredAt = formatWhen(order?.delivered_at);
  const rtoAt = formatWhen(order?.rto_at);
  const courierName = order?.courier_name && String(order.courier_name).trim() ? String(order.courier_name).trim() : "";
  const trackingNumber =
    order?.tracking_number && String(order.tracking_number).trim() ? String(order.tracking_number).trim() : "";
  const trackingUrl = order?.tracking_url && /^https:\/\//i.test(String(order.tracking_url)) ? String(order.tracking_url) : "";

  const handleStatusSelect = (next: OrderStatus) => {
    if (next === "dispatched" && shippingUi) {
      setActionMsg(null);
      setDispatchCourier(order?.courier_id != null ? String(order.courier_id) : "");
      setDispatchTracking(trackingNumber);
      setDispatchRider(order?.rider_id != null ? String(order.rider_id) : "");
      setDialog({ orderId, kind: "dispatch" });
      return;
    }
    onStatusChange(orderId, next);
  };

  const cancelDispatch = () => {
    setDialog(null);
    // The status <select> is uncontrolled: remount it so it shows the real status again.
    setStatusSelectNonce((n) => n + 1);
  };

  const submitDispatch = () => {
    const tracking = dispatchTracking.trim();
    if (tracking && !TRACKING_NUMBER_RE.test(tracking)) {
      setActionMsg({ orderId, tone: "error", text: "Tracking number must be 3-100 letters, numbers or dashes." });
      return;
    }
    const shipping: DispatchShipping = {};
    if (dispatchCourier) shipping.courier_id = Number(dispatchCourier);
    if (dispatchRider) shipping.rider_id = Number(dispatchRider);
    if (tracking) shipping.tracking_number = tracking;
    setDialog(null);
    onStatusChange(orderId, "dispatched", shipping);
  };

  const submitRto = async () => {
    setActionBusy(true);
    setActionMsg(null);
    const res = await adminRequest("/api/admin-orders", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order_id: orderId, action: "rto" }),
    });
    setActionBusy(false);
    if (!res.ok) {
      setActionMsg({ orderId, tone: "error", text: res.errorMessage || "Could not mark order as returned." });
      return;
    }
    setDialog(null);
    setActionMsg({ orderId, tone: "ok", text: "Order marked as returned to origin and cancelled." });
    setAttempt((n) => n + 1);
    onReturned?.();
  };

  const submitConfirm = async () => {
    setActionBusy(true);
    setActionMsg(null);
    const res = await adminRequest("/api/admin-orders", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        order_id: orderId,
        status: "confirmed",
        confirmation_method: confirmMethod,
        confirmation_note: confirmNote.trim(),
      }),
    });
    setActionBusy(false);
    if (!res.ok) {
      setActionMsg({ orderId, tone: "error", text: res.errorMessage || "Could not confirm order." });
      return;
    }
    setDialog(null);
    setConfirmNote("");
    setActionMsg({ orderId, tone: "ok", text: "COD order confirmed." });
    setAttempt((n) => n + 1);
    onConfirmed?.();
  };

  const submitBlock = async () => {
    const reason = blockReason.trim();
    if (!reason) {
      setActionMsg({ orderId, tone: "error", text: "A reason is required to block this customer." });
      return;
    }
    setActionBusy(true);
    setActionMsg(null);
    const res = await adminRequest("/api/admin-blacklist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId, reason }),
    });
    setActionBusy(false);
    if (!res.ok) {
      setActionMsg({ orderId, tone: "error", text: res.errorMessage || "Could not block customer." });
      return;
    }
    setDialog(null);
    setBlockReason("");
    setActionMsg({ orderId, tone: "ok", text: "Customer blocked." });
  };

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
              {isRto ? (
                <span className="status-badge status-cancelled" data-order-rto="1" style={{ marginLeft: 8 }}>
                  RTO
                </span>
              ) : null}
            </div>

            {riskScore !== null || order.otp_verified === true ? (
              <div style={{ marginBottom: 12 }} data-order-protection-info="1">
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  {riskScore !== null ? (
                    <span
                      className={`status-badge ${riskScore >= 50 ? "status-cancelled" : riskScore >= 25 ? "status-pending" : "status-delivered"}`}
                      data-risk-score={riskScore}
                    >
                      Risk {riskScore}
                    </span>
                  ) : null}
                  {order.otp_verified === true ? (
                    <span className="status-badge status-delivered" data-otp-verified="1">OTP verified</span>
                  ) : null}
                </div>
                {riskLabels.length > 0 ? (
                  <ul style={{ margin: "8px 0 0 18px", padding: 0, fontSize: 12, color: "#666" }}>
                    {riskLabels.map((l, i) => (
                      <li key={`${l}-${i}`}>{l}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}

            <Row label="Placed (PKT)" value={text(order.created_at_pkt)} />
            <Row label="Customer" value={text(order.customer_name)} />
            <Row label="Email" value={text(order.customer_email)} />
            <Row label="Phone / WhatsApp" value={text(order.customer_phone)} />
            {opsShown ? (
              <div data-order-fulfilment={isPickup ? "pickup" : "delivery"}>
                <Row label="Fulfilment" value={isPickup ? "Pickup" : "Delivery"} />
              </div>
            ) : null}
            {isPickup ? (
              <div data-order-pickup="1">
                <Row label="Pickup point" value={text(order.pickup_point_name)} />
                {order.pickup_point_address ? <Row label="Pickup address" value={String(order.pickup_point_address)} /> : null}
                {order.pickup_point_hours ? <Row label="Pickup hours" value={String(order.pickup_point_hours)} /> : null}
              </div>
            ) : (
              <>
                <Row label="Delivery address" value={text(address)} />
                {order.shipping_area && String(order.shipping_area).trim() ? (
                  <div data-order-area="1"><Row label="Delivery area" value={String(order.shipping_area)} /></div>
                ) : null}
                {order.rider_name && String(order.rider_name).trim() ? (
                  <div data-order-rider="1"><Row label="Rider" value={String(order.rider_name)} /></div>
                ) : null}
              </>
            )}
            <Row label="Payment method" value={paymentLabel(order.payment_method)} />
            {order.payment_reference && String(order.payment_reference).trim() ? (
              <Row label="Payment reference" value={String(order.payment_reference)} mono />
            ) : null}
            <Row label="Coupon" value={text(order.coupon_code)} mono />
            <Row label="Notes" value={text(order.notes)} />
            {order.confirmation_method ? (
              <Row
                label="COD confirmed"
                value={[
                  order.confirmation_method === "whatsapp" ? "WhatsApp" : "Call",
                  order.confirmed_by ? `by ${order.confirmed_by}` : "",
                  order.confirmation_note ? `— ${order.confirmation_note}` : "",
                ].filter(Boolean).join(" ")}
              />
            ) : null}
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
              {showShipping ? (
                <div data-order-shipping="1">
                  <Row
                    label="Shipping"
                    value={`${money(shipAmountNum)}${shipZone ? ` (${shipZone})` : ""}`}
                  />
                </div>
              ) : null}
              <Row label={taxLabel} value={money(taxAmount)} />
              <Row label="Total" value={money(order.total)} />
            </div>

            {courierName || trackingNumber || shippedAt || deliveredAt || rtoAt ? (
              <div style={{ marginTop: 12 }} data-order-shipment="1">
                {courierName ? <Row label="Courier" value={courierName} /> : null}
                {trackingNumber ? <Row label="Tracking number" value={trackingNumber} mono /> : null}
                {trackingUrl ? (
                  <div style={{ padding: "6px 0", fontSize: 13 }}>
                    <a href={trackingUrl} target="_blank" rel="noopener noreferrer" style={{ color: "#5B21B6" }}>
                      Track shipment
                    </a>
                  </div>
                ) : null}
                {shippedAt ? <Row label="Shipped at" value={shippedAt} /> : null}
                {deliveredAt ? <Row label="Delivered at" value={deliveredAt} /> : null}
                {rtoAt ? <Row label="Returned at" value={rtoAt} /> : null}
              </div>
            ) : null}

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
                  key={`status-${orderId}-${status}-${statusSelectNonce}`}
                  defaultValue={status}
                  data-status-select="1"
                  onChange={(e) => handleStatusSelect(e.target.value as OrderStatus)}
                >
                  <option value="pending">Pending</option>
                  <option value="confirmed">Confirmed</option>
                  {isPickup ? (
                    <option value="ready_for_pickup">Ready for pickup</option>
                  ) : (
                    <option value="dispatched">Dispatched</option>
                  )}
                  <option value="delivered">{isPickup ? "Picked up" : "Delivered"}</option>
                  <option value="cancelled">Cancelled</option>
                </select>
              )}
            </div>

            {msg ? (
              <div
                role={msg.tone === "error" ? "alert" : "status"}
                style={{ marginTop: 12, fontSize: 13, color: msg.tone === "error" ? "#DC2626" : "#15803D" }}
              >
                {msg.text}
              </div>
            ) : null}

            {activeDialog === "dispatch" ? (
              <div
                data-dispatch-dialog="1"
                style={{ marginTop: 12, padding: 14, border: "1px solid #E5E5E5", borderRadius: 10, background: "#FAFAFA" }}
              >
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Dispatch order</div>
                <div className="modal-field">
                  <label htmlFor="dispatch-courier">Courier</label>
                  <select
                    id="dispatch-courier"
                    value={dispatchCourier}
                    onChange={(e) => setDispatchCourier(e.target.value)}
                  >
                    <option value="">No courier</option>
                    {courierOptions.map((c) => (
                      <option key={c.id} value={String(c.id)}>{c.name}</option>
                    ))}
                  </select>
                </div>
                {riderOptions.length > 0 ? (
                  <div className="modal-field" data-dispatch-rider="1">
                    <label htmlFor="dispatch-rider">Own rider (optional)</label>
                    <select
                      id="dispatch-rider"
                      value={dispatchRider}
                      onChange={(e) => setDispatchRider(e.target.value)}
                    >
                      <option value="">No rider</option>
                      {riderOptions.map((r) => (
                        <option key={r.id} value={String(r.id)}>{r.name}</option>
                      ))}
                    </select>
                  </div>
                ) : null}
                <div className="modal-field">
                  <label htmlFor="dispatch-tracking">Tracking number (optional)</label>
                  <input
                    id="dispatch-tracking"
                    style={fieldStyle}
                    maxLength={100}
                    value={dispatchTracking}
                    onChange={(e) => setDispatchTracking(e.target.value)}
                  />
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button type="button" className="modal-cancel" onClick={cancelDispatch}>Cancel</button>
                  <button type="button" className="modal-save" data-dispatch-confirm="1" onClick={submitDispatch}>
                    Mark dispatched
                  </button>
                </div>
              </div>
            ) : null}

            {canRto ? (
              <div style={{ marginTop: 12 }}>
                <button
                  type="button"
                  className="action-btn btn-delete"
                  data-order-detail-rto="1"
                  onClick={() => { setActionMsg(null); setDialog({ orderId, kind: "rto" }); }}
                >
                  Returned to origin (RTO)
                </button>
              </div>
            ) : null}

            {activeDialog === "rto" ? (
              <div
                data-rto-dialog="1"
                style={{ marginTop: 12, padding: 14, border: "1px solid #E5E5E5", borderRadius: 10, background: "#FAFAFA" }}
              >
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Mark as returned to origin?</div>
                <p style={{ fontSize: 12, color: "#666", margin: "0 0 10px", lineHeight: 1.5 }}>
                  The courier brought this parcel back. The order will be cancelled, stock restored and any coupon use
                  released. This cannot be undone.
                </p>
                <div style={{ display: "flex", gap: 8 }}>
                  <button type="button" className="modal-cancel" disabled={actionBusy} onClick={() => setDialog(null)}>Cancel</button>
                  <button type="button" className="modal-save" data-rto-confirm="1" disabled={actionBusy} onClick={() => { void submitRto(); }}>
                    {actionBusy ? "Saving…" : "Confirm return"}
                  </button>
                </div>
              </div>
            ) : null}

            {canConfirmCod || canBlock ? (
              <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
                {canConfirmCod ? (
                  <button
                    type="button"
                    className="action-btn btn-verify"
                    data-order-detail-confirm-cod="1"
                    onClick={() => { setActionMsg(null); setDialog({ orderId, kind: "confirm" }); }}
                  >
                    Confirm COD
                  </button>
                ) : null}
                {canBlock ? (
                  <button
                    type="button"
                    className="action-btn btn-delete"
                    data-order-detail-block="1"
                    onClick={() => { setActionMsg(null); setDialog({ orderId, kind: "block" }); }}
                  >
                    Block customer
                  </button>
                ) : null}
              </div>
            ) : null}

            {activeDialog === "confirm" ? (
              <div
                data-confirm-cod-dialog="1"
                style={{ marginTop: 12, padding: 14, border: "1px solid #E5E5E5", borderRadius: 10, background: "#FAFAFA" }}
              >
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Confirm COD order</div>
                <div className="modal-field">
                  <label htmlFor="confirm-cod-method">Confirmed via</label>
                  <select
                    id="confirm-cod-method"
                    value={confirmMethod}
                    onChange={(e) => setConfirmMethod(e.target.value === "whatsapp" ? "whatsapp" : "call")}
                  >
                    <option value="call">Phone call</option>
                    <option value="whatsapp">WhatsApp</option>
                  </select>
                </div>
                <div className="modal-field">
                  <label htmlFor="confirm-cod-note">Note (optional)</label>
                  <textarea
                    id="confirm-cod-note"
                    rows={2}
                    maxLength={500}
                    style={fieldStyle}
                    value={confirmNote}
                    onChange={(e) => setConfirmNote(e.target.value)}
                  />
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button type="button" className="modal-cancel" disabled={actionBusy} onClick={() => setDialog(null)}>Cancel</button>
                  <button type="button" className="modal-save" disabled={actionBusy} onClick={() => { void submitConfirm(); }}>
                    {actionBusy ? "Confirming…" : "Confirm order"}
                  </button>
                </div>
              </div>
            ) : null}

            {activeDialog === "block" ? (
              <div
                data-block-customer-dialog="1"
                style={{ marginTop: 12, padding: 14, border: "1px solid #E5E5E5", borderRadius: 10, background: "#FAFAFA" }}
              >
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Block this customer</div>
                <div className="modal-field">
                  <label htmlFor="block-customer-reason">Reason</label>
                  <textarea
                    id="block-customer-reason"
                    rows={2}
                    maxLength={500}
                    style={fieldStyle}
                    value={blockReason}
                    onChange={(e) => setBlockReason(e.target.value)}
                  />
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button type="button" className="modal-cancel" disabled={actionBusy} onClick={() => setDialog(null)}>Cancel</button>
                  <button type="button" className="modal-save" disabled={actionBusy} onClick={() => { void submitBlock(); }}>
                    {actionBusy ? "Blocking…" : "Block customer"}
                  </button>
                </div>
              </div>
            ) : null}

            {canDelete && (
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
            )}
          </>
        ) : null}
      </aside>
    </div>
  );
}
