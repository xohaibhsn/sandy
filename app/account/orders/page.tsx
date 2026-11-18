"use client";

import { useEffect, useState } from "react";
import { useCart } from "../../lib/cartContext";
import { CUSTOMER_TEXTS } from "@/lib/customerTexts";
import { formatPrice } from "@/lib/site";
import AccountShell from "../AccountShell";
import { accountFetch, formatDate, statusLabel } from "../accountClient";

type OrderRow = {
  order_id: string;
  status: string | null;
  total: number | string;
  created_at: string;
  item_count: number;
};

type OrderDetailItems = {
  order: { items: { product_id: number | null; product_name: string; price: number | string; quantity: number }[] };
};

function OrdersList() {
  const { addToCart } = useCart();
  const [orders, setOrders] = useState<OrderRow[] | null>(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [addedId, setAddedId] = useState("");

  useEffect(() => {
    let cancelled = false;
    accountFetch<{ orders: OrderRow[] }>("/api/account/orders").then((r) => {
      if (cancelled) return;
      if (r.ok) setOrders(r.data?.orders ?? []);
      else setError(r.error);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const reorder = async (orderId: string) => {
    setBusyId(orderId);
    setError("");
    setAddedId("");
    const r = await accountFetch<OrderDetailItems>(
      `/api/account/orders/${encodeURIComponent(orderId)}`
    );
    setBusyId("");
    if (!r.ok || !r.data) {
      setError(r.error);
      return;
    }
    for (const item of r.data.order.items) {
      const id = Number(item.product_id);
      if (!Number.isFinite(id) || id <= 0) continue;
      // addToCart adds one unit per call (existing lines increment).
      for (let i = 0; i < Math.max(1, item.quantity); i++) {
        addToCart({ id, name: item.product_name, price: Number(item.price), qty: 1 });
      }
    }
    setAddedId(orderId);
  };

  if (orders === null && !error) return <div className="acc-center">Loading…</div>;

  return (
    <>
      {error ? <p className="acc-error" role="alert">{error}</p> : null}
      {orders && orders.length === 0 ? (
        <div className="acc-center">{CUSTOMER_TEXTS.ACCOUNT_ORDERS_EMPTY}</div>
      ) : null}
      {(orders ?? []).map((o) => (
        <div className="acc-card" key={o.order_id}>
          <div className="acc-list-row">
            <div>
              <a className="acc-order-id" href={`/account/orders/${encodeURIComponent(o.order_id)}`}>
                {o.order_id}
              </a>
              <p className="acc-muted">
                {formatDate(o.created_at)} · {o.item_count} item{o.item_count === 1 ? "" : "s"}
              </p>
            </div>
            <div style={{ textAlign: "right" }}>
              <span className={`acc-badge ${o.status || "pending"}`}>{statusLabel(o.status)}</span>
              <p className="acc-price" style={{ marginTop: 6 }}>{formatPrice(o.total)}</p>
            </div>
          </div>
          <div className="acc-actions">
            <a className="acc-btn small ghost" href={`/account/orders/${encodeURIComponent(o.order_id)}`} style={{ textDecoration: "none" }}>
              {CUSTOMER_TEXTS.ACCOUNT_ORDER_DETAIL_TITLE}
            </a>
            <button
              type="button"
              className="acc-btn small"
              onClick={() => reorder(o.order_id)}
              disabled={busyId === o.order_id}
            >
              {CUSTOMER_TEXTS.ACCOUNT_REORDER}
            </button>
          </div>
          {addedId === o.order_id ? (
            <p className="acc-ok">
              Added to your cart. <a href="/cart" style={{ color: "#5B21B6" }}>View cart →</a>
            </p>
          ) : null}
        </div>
      ))}
    </>
  );
}

export default function AccountOrdersPage() {
  return (
    <AccountShell title={CUSTOMER_TEXTS.ACCOUNT_ORDERS_TITLE}>
      <OrdersList />
    </AccountShell>
  );
}
