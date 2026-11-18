import type { NextApiRequest, NextApiResponse } from "next";
import type { RowDataPacket } from "mysql2/promise";
import pool from "../../../../lib/db";
import { requireAccountCustomer } from "../../../../lib/accountApi";
import { hasShippingOrderColumns } from "../../../../lib/shippingSchema";
import { buildTrackingUrl } from "../../../../lib/shipping";

const ORDER_ID_MAX = 50;

function isMissingColumnError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { errno?: number; code?: string };
  return e.errno === 1054 || e.code === "ER_BAD_FIELD_ERROR";
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const me = await requireAccountCustomer(req, res);
  if (!me) return;

  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const raw = req.query.orderId;
  const orderId = typeof raw === "string" ? raw.trim() : "";
  if (!orderId || orderId.length > ORDER_ID_MAX) {
    return res.status(404).json({ error: "Not found" });
  }

  try {
    // Shipping / courier columns exist only after migration 0009; without it the query is unchanged.
    const includeShipping = await hasShippingOrderColumns(pool);
    const [orderRows] = await pool.query<RowDataPacket[]>(
      `SELECT order_id, status, total, created_at, payment_method, coupon_code, discount_amount, vat_amount,
              customer_name, customer_phone, delivery_address, city, postcode${
                includeShipping ? ", shipping_amount, shipping_zone, courier_id, tracking_number" : ""
              }
       FROM orders
       WHERE order_id = ?
         AND (customer_id = ? OR (customer_id IS NULL AND customer_phone_norm = ?))
       LIMIT 1`,
      [orderId, me.id, me.phone_norm]
    );
    const order = Array.isArray(orderRows) ? orderRows[0] : undefined;
    if (!order) {
      return res.status(404).json({ error: "Not found" });
    }

    const [itemRows] = await pool.query<RowDataPacket[]>(
      `SELECT product_id, product_name, price, quantity
       FROM order_items WHERE order_id = ? ORDER BY id ASC`,
      [String(order.order_id)]
    );

    // Courier + tracking (only when present; https-only link with {tracking} URL-encoded).
    const shippingExtras: Record<string, unknown> = {};
    if (includeShipping) {
      const trackingNumber =
        typeof order.tracking_number === "string" && order.tracking_number.trim()
          ? order.tracking_number.trim()
          : "";
      if (order.shipping_amount != null) shippingExtras.shipping_amount = order.shipping_amount;
      if (typeof order.shipping_zone === "string" && order.shipping_zone.trim()) {
        shippingExtras.shipping_zone = order.shipping_zone.trim();
      }
      if (trackingNumber) shippingExtras.tracking_number = trackingNumber;
      if (order.courier_id != null) {
        try {
          const [courierRows] = await pool.query<RowDataPacket[]>(
            `SELECT name, tracking_url_template FROM couriers WHERE id = ? LIMIT 1`,
            [order.courier_id]
          );
          const courier = Array.isArray(courierRows) ? courierRows[0] : undefined;
          if (courier) {
            if (typeof courier.name === "string" && courier.name.trim()) {
              shippingExtras.courier_name = courier.name.trim();
            }
            const url = trackingNumber
              ? buildTrackingUrl(courier.tracking_url_template, trackingNumber)
              : null;
            if (url) shippingExtras.tracking_url = url;
          }
        } catch {
          /* couriers table absent */
        }
      }
    }

    return res.status(200).json({
      order: {
        order_id: String(order.order_id),
        status: order.status != null ? String(order.status) : null,
        total: order.total,
        created_at: order.created_at,
        payment_method: order.payment_method != null ? String(order.payment_method) : null,
        coupon_code: order.coupon_code ?? null,
        discount_amount: order.discount_amount,
        vat_amount: order.vat_amount,
        customer_name: order.customer_name ?? null,
        customer_phone: order.customer_phone ?? null,
        delivery_address: order.delivery_address ?? null,
        city: order.city ?? null,
        postcode: order.postcode ?? null,
        ...shippingExtras,
        items: (Array.isArray(itemRows) ? itemRows : []).map((i) => ({
          product_id: i.product_id,
          product_name: i.product_name != null ? String(i.product_name) : "",
          price: i.price,
          quantity: Number(i.quantity) || 0,
        })),
      },
    });
  } catch (err) {
    if (isMissingColumnError(err)) {
      console.error("[api/account/orders/[orderId]] failed", "MISSING_COLUMN");
      return res.status(503).json({ error: "Service unavailable" });
    }
    console.error("[api/account/orders/[orderId]] failed", (err as { code?: string })?.code || "unknown");
    return res.status(500).json({ error: "Server error" });
  }
}
