/**
 * Fire-and-forget customer order email: flag gate, address check, send, audit.
 * Never throws and never affects the caller's HTTP response. Callers use `void sendCustomerOrderEmail(...)`.
 */
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import pool from "./db";
import { recordAudit } from "./auditLog";
import { loadCustomerEmailSettings } from "./customerEmailSettings";
import {
  buildOrderConfirmedEmail,
  buildOrderReceivedEmail,
  isValidCustomerEmail,
  type CustomerEmailOrder,
} from "./customerEmails";
import { isMailConfigured, sendMailSafe, type MailTransport } from "./mailer";
import { CONTACT_EMAIL } from "./site";

export type CustomerEmailKind = "received" | "confirmed";

export async function sendCustomerOrderEmail(opts: {
  kind: CustomerEmailKind;
  order: CustomerEmailOrder;
  transport?: MailTransport;
  db?: Pool | PoolConnection;
}): Promise<void> {
  try {
    const { kind, order } = opts;
    const settings = await loadCustomerEmailSettings();
    if (kind === "received" ? !settings.received : !settings.confirmed) return;
    if (!isValidCustomerEmail(order.customerEmail)) return;
    if (!opts.transport && !isMailConfigured()) return;

    const msg = kind === "received" ? buildOrderReceivedEmail(order) : buildOrderConfirmedEmail(order);
    const result = await sendMailSafe(msg, { kind: `customer_${kind}`, orderId: order.orderId }, opts.transport);

    await recordAudit(opts.db ?? pool, {
      actor: { actorType: "system" },
      action: result.ok ? "customer_email_sent" : "customer_email_failed",
      entityType: "order",
      entityId: order.orderId,
      summary: result.ok
        ? `Customer ${kind} email sent for order ${order.orderId}`
        : `Customer ${kind} email failed for order ${order.orderId}`,
      detail: { kind },
    });
  } catch {
    // Best-effort: customer email must never break order flow. No payload is logged.
    console.error("[mail] customer email dispatch failed");
  }
}

type OrderSnapshotRow = RowDataPacket & {
  order_id: string;
  customer_name: string | null;
  customer_email: string | null;
  payment_method: string | null;
  total: unknown;
  coupon_code: string | null;
  discount_amount: unknown;
  vat_amount: unknown;
  shipping_amount?: unknown;
  shipping_zone?: string | null;
};

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Loads an order from the DB (server-side truth) and sends the customer email.
 * Used by admin-orders after a real transition to confirmed. Never throws.
 */
export async function sendCustomerOrderEmailForStoredOrder(opts: {
  kind: CustomerEmailKind;
  orderId: string;
  transport?: MailTransport;
  db?: Pool | PoolConnection;
}): Promise<void> {
  try {
    const settings = await loadCustomerEmailSettings();
    if (opts.kind === "received" ? !settings.received : !settings.confirmed) return;

    const db = opts.db ?? pool;
    let rows: OrderSnapshotRow[];
    let hasShipping = true;
    try {
      const [r] = await db.query<OrderSnapshotRow[]>(
        `SELECT order_id, customer_name, customer_email, payment_method, total, coupon_code,
                discount_amount, vat_amount, shipping_amount, shipping_zone
         FROM orders WHERE order_id = ? LIMIT 1`,
        [opts.orderId]
      );
      rows = Array.isArray(r) ? r : [];
    } catch {
      // Shipping columns (migration 0009) not applied: retry without them.
      hasShipping = false;
      const [r] = await db.query<OrderSnapshotRow[]>(
        `SELECT order_id, customer_name, customer_email, payment_method, total, coupon_code,
                discount_amount, vat_amount
         FROM orders WHERE order_id = ? LIMIT 1`,
        [opts.orderId]
      );
      rows = Array.isArray(r) ? r : [];
    }
    const row = rows[0];
    if (!row) return;
    if (!isValidCustomerEmail(String(row.customer_email ?? ""))) return;

    const [itemRows] = await db.query<RowDataPacket[]>(
      `SELECT product_name, price, quantity FROM order_items WHERE order_id = ? ORDER BY id ASC`,
      [opts.orderId]
    );

    let taxLabel = "";
    try {
      const [snap] = await db.query<RowDataPacket[]>(
        `SELECT tax_label FROM order_tax_snapshots WHERE order_id = ? LIMIT 1`,
        [opts.orderId]
      );
      const label = snap?.[0]?.tax_label;
      taxLabel = typeof label === "string" ? label.trim() : "";
    } catch {
      taxLabel = "";
    }

    // Store contact address (Reply-To). Same source as getContactConfig(), read directly so this module
    // stays free of the "@/" alias chain; falls back to the static default.
    let contactEmail: string | null = CONTACT_EMAIL;
    try {
      const [contactRows] = await db.query<RowDataPacket[]>(
        `SELECT content_value FROM site_content WHERE content_key = 'contact_email' LIMIT 1`
      );
      const v = contactRows?.[0]?.content_value;
      if (typeof v === "string" && v.trim()) contactEmail = v.trim();
    } catch {
      /* keep fallback */
    }

    const zone = hasShipping && typeof row.shipping_zone === "string" && row.shipping_zone.trim()
      ? row.shipping_zone.trim()
      : null;
    const coupon = typeof row.coupon_code === "string" ? row.coupon_code.trim() : "";

    await sendCustomerOrderEmail({
      kind: opts.kind,
      transport: opts.transport,
      db: opts.db,
      order: {
        orderId: String(row.order_id),
        customerName: String(row.customer_name ?? ""),
        customerEmail: String(row.customer_email ?? ""),
        items: (Array.isArray(itemRows) ? itemRows : []).map((i) => ({
          name: String(i.product_name ?? ""),
          qty: num(i.quantity),
          lineTotal: num(i.price) * num(i.quantity),
        })),
        shipping: hasShipping ? num(row.shipping_amount) : 0,
        shippingZoneName: zone,
        shippingOn: !!zone,
        taxLabel: taxLabel || undefined,
        taxAmount: num(row.vat_amount),
        discountAmount: num(row.discount_amount),
        discountLabel: coupon || undefined,
        grandTotal: num(row.total),
        paymentMethod: String(row.payment_method ?? ""),
        contactEmail,
      },
    });
  } catch {
    console.error("[mail] customer email snapshot failed");
  }
}
