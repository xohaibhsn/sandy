/**
 * Checkout inputs for delivery ops (SANDY-BATCH-17), shared by /api/tax-quote, /api/orders and
 * /api/checkout/eligibility so all three accept exactly the same shapes. Fields are only read when the
 * matching flag is on; with every flag off the parser returns the delivery defaults without touching
 * the body (no new validation errors, no new reads).
 */
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import type { ShippingFulfilment } from "./shipping";

type Queryable = Pick<Pool | PoolConnection, "query">;

export type DeliveryOpsInput = {
  fulfilment: ShippingFulfilment;
  /** Set only for fulfilment = pickup. */
  pickupPointId: number | null;
  /** Client-selected area id (validated later against the area tree). Null = none / other area. */
  areaId: number | null;
  /** "Other area in this city": the customer explicitly chose no listed area. */
  otherArea: boolean;
};

export const DELIVERY_DEFAULTS: DeliveryOpsInput = {
  fulfilment: "delivery",
  pickupPointId: null,
  areaId: null,
  otherArea: false,
};

function parsePositiveId(raw: unknown): number | null | undefined {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw === "number") return Number.isInteger(raw) && raw > 0 ? raw : undefined;
  if (typeof raw === "string" && /^\d{1,10}$/.test(raw.trim())) {
    const n = Number(raw.trim());
    return n > 0 ? n : undefined;
  }
  return undefined;
}

/** undefined => the body is malformed (callers answer 400 "Invalid request"). */
export function parseDeliveryOpsInput(
  body: Record<string, unknown>,
  flags: { areasOn: boolean; pickupOn: boolean }
): DeliveryOpsInput | undefined {
  const out: DeliveryOpsInput = { ...DELIVERY_DEFAULTS };

  if (flags.pickupOn) {
    const f = body.fulfilment;
    if (f === undefined || f === null || f === "") out.fulfilment = "delivery";
    else if (f === "delivery" || f === "pickup") out.fulfilment = f;
    else return undefined;

    if (out.fulfilment === "pickup") {
      const id = parsePositiveId(body.pickup_point_id);
      if (id === undefined) return undefined;
      out.pickupPointId = id;
    }
  }

  if (flags.areasOn) {
    const id = parsePositiveId(body.area_id);
    if (id === undefined) return undefined;
    const other = body.other_area;
    if (other !== undefined && other !== null && typeof other !== "boolean") return undefined;
    out.otherArea = other === true;
    out.areaId = out.otherArea ? null : id;
  }

  return out;
}

export type ActivePickupPoint = {
  id: number;
  name: string;
  city: string;
  address: string;
  hours_text: string | null;
  map_url: string | null;
};

/** Active pickup point by id, or null. Throws on DB errors (pickup_points is a migration 0010 table). */
export async function loadActivePickupPoint(
  db: Queryable,
  id: number
): Promise<ActivePickupPoint | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, name, city, address, hours_text, map_url
     FROM pickup_points WHERE id = ? AND active = 1 LIMIT 1`,
    [id]
  );
  const r = Array.isArray(rows) ? rows[0] : undefined;
  if (!r) return null;
  return {
    id: Number(r.id),
    name: String(r.name ?? ""),
    city: String(r.city ?? ""),
    address: String(r.address ?? ""),
    hours_text: r.hours_text == null ? null : String(r.hours_text),
    map_url: r.map_url == null ? null : String(r.map_url),
  };
}
