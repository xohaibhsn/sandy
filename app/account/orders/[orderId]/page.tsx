"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCart } from "../../../lib/cartContext";
import { CUSTOMER_TEXTS } from "@/lib/customerTexts";
import { formatPrice } from "@/lib/site";
import AccountShell from "../../AccountShell";
import { accountFetch, formatDate, statusLabel } from "../../accountClient";

type OrderDetail = {
  order_id: string;
  status: string | null;
  total: number | string;
  created_at: string;
  payment_method: string | null;
  coupon_code: string | null;
  discount_amount: number | string | null;
  vat_amount: number | string | null;
  customer_name: string | null;
  customer_phone: string | null;
  delivery_address: string | null;
  city: string | null;
  postcode: string | null;
  items: { product_id: number | null; product_name: string; price: number | string; quantity: number }[];
};

const STEPS = [
  { key: "pending", icon: "🕐", title: "Order Received", desc: "We have received your order." },
  { key: "confirmed", icon: "✅", title: "Confirmed", desc: "Your order has been verified and confirmed." },
  { key: "dispatched", icon: "🚚", title: "Dispatched", desc: "Your order is on its way! Delivery in 2-3 working days." },
  { key: "delivered", icon: "📦", title: "Delivered", desc: "Your order has been delivered. Enjoy!" },
];
const STATUS_ORDER = STEPS.map((s) => s.key);

function OrderDetailView({ orderId }: { orderId: string }) {
  const { addToCart } = useCart();
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [error, setError] = useState("");
  const [added, setAdded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    accountFetch<{ order: OrderDetail }>(`/api/account/orders/${encodeURIComponent(orderId)}`).then(
      (r) => {
        if (cancelled) return;
        if (r.ok && r.data?.order) setOrder(r.data.order);
        else setError(r.status === 404 ? "Order not found." : r.error);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [orderId]);

  if (error) {
    return (
      <div className="acc-center">
        <p>{error}</p>
        <p style={{ marginTop: 12 }}>
          <Link href="/account/orders" style={{ color: "#5B21B6" }}>← {CUSTOMER_TEXTS.ACCOUNT_ORDERS_TITLE}</Link>
        </p>
      </div>
    );
  }
  if (!order) return <div className="acc-center">Loading…</div>;

  const reorder = () => {
    for (const item of order.items) {
      const id = Number(item.product_id);
      if (!Number.isFinite(id) || id <= 0) continue;
      for (let i = 0; i < Math.max(1, item.quantity); i++) {
        addToCart({ id, name: item.product_name, price: Number(item.price), qty: 1 });
      }
    }
    setAdded(true);
  };

  const current = STATUS_ORDER.indexOf(order.status || "");
  const cancelled = order.status === "cancelled";
  const vat = Number(order.vat_amount);
  const discount = Number(order.discount_amount);
  const address = [order.delivery_address, order.city, order.postcode].filter(Boolean).join(", ");

  return (
    <>
      <p style={{ marginBottom: 16 }}>
        <Link href="/account/orders" style={{ color: "#5B21B6", textDecoration: "none", fontSize: 14 }}>
          ← {CUSTOMER_TEXTS.ACCOUNT_ORDERS_TITLE}
        </Link>
      </p>

      <div className="acc-card">
        <div className="acc-list-row" style={{ marginBottom: 16 }}>
          <div>
            <span className="acc-label">Order ID</span>
            <div className="acc-order-id">{order.order_id}</div>
            <p className="acc-muted">{formatDate(order.created_at)}</p>
          </div>
          <span className={`acc-badge ${order.status || "pending"}`}>{statusLabel(order.status)}</span>
        </div>

        <span className="acc-label">Items</span>
        {order.items.map((item, i) => (
          <div className="acc-item-row" key={i}>
            <span>{item.product_name} × {item.quantity}</span>
            <span className="acc-price">{formatPrice(Number(item.price) * item.quantity)}</span>
          </div>
        ))}
        {discount > 0 ? (
          <div className="acc-item-row">
            <span>Discount{order.coupon_code ? ` (${order.coupon_code})` : ""}</span>
            <span className="acc-price">-{formatPrice(discount)}</span>
          </div>
        ) : null}
        {vat > 0 ? (
          <div className="acc-item-row">
            <span>Tax</span>
            <span className="acc-price">{formatPrice(vat)}</span>
          </div>
        ) : null}
        <div className="acc-total-row">
          <span>Total</span>
          <span>{formatPrice(order.total)}</span>
        </div>

        <div className="acc-actions">
          <button type="button" className="acc-btn small" onClick={reorder}>
            {CUSTOMER_TEXTS.ACCOUNT_REORDER}
          </button>
        </div>
        {added ? (
          <p className="acc-ok">
            Added to your cart. <a href="/cart" style={{ color: "#5B21B6" }}>View cart →</a>
          </p>
        ) : null}
      </div>

      <div className="acc-card">
        <h3>Order Progress</h3>
        {cancelled ? (
          <p className="acc-muted">This order was cancelled.</p>
        ) : (
          <div className="acc-steps">
            {STEPS.map((step, i) => {
              const done = i < current;
              const active = i === current;
              const inactive = i > current;
              const last = i === STEPS.length - 1;
              return (
                <div className="acc-step" key={step.key}>
                  <div className="acc-step-left">
                    <div className={`acc-dot ${done ? "done" : active ? "active" : "inactive"}`}>{step.icon}</div>
                    {!last && <div className={`acc-line ${done ? "done" : ""}`} />}
                  </div>
                  <div className="acc-step-content">
                    <div className={`acc-step-title ${inactive ? "inactive" : ""}`}>{step.title}</div>
                    <div className="acc-step-desc">{step.desc}</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="acc-card">
        <h3>Delivery</h3>
        {order.customer_name ? <div className="acc-info-row"><span>Name</span><span>{order.customer_name}</span></div> : null}
        {order.customer_phone ? <div className="acc-info-row"><span>Phone</span><span>{order.customer_phone}</span></div> : null}
        {address ? <div className="acc-info-row"><span>Address</span><span>{address}</span></div> : null}
        {order.payment_method ? <div className="acc-info-row"><span>Payment</span><span>{order.payment_method}</span></div> : null}
      </div>
    </>
  );
}

export default function AccountOrderDetailPage() {
  const params = useParams<{ orderId: string }>();
  const raw = params?.orderId;
  const rawId = Array.isArray(raw) ? raw[0] : raw || "";
  let orderId = rawId;
  try {
    orderId = decodeURIComponent(rawId);
  } catch {
    /* keep raw value */
  }

  return (
    <AccountShell title={CUSTOMER_TEXTS.ACCOUNT_ORDER_DETAIL_TITLE}>
      {orderId ? <OrderDetailView orderId={orderId} /> : <div className="acc-center">Order not found.</div>}
    </AccountShell>
  );
}
