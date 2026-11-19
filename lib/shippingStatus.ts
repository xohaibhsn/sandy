/**
 * Order status rules for delivery ops (SANDY-BATCH-17). Pure, no database, client-safe.
 *
 * Delivery orders keep today's behaviour (any status can be set by an admin, RTO only from
 * dispatched); the only new refusal is ready_for_pickup, which belongs to pickup orders.
 * Pickup orders follow pending -> confirmed -> ready_for_pickup -> delivered ("Picked up") and can
 * never be dispatched or marked RTO (nothing ships). Cancelling is allowed for both.
 *
 * Callers translate a refusal to HTTP `status` (409) with the stable `code`; messages are generic.
 */

export const ORDER_STATUSES = [
  "pending",
  "confirmed",
  "ready_for_pickup",
  "dispatched",
  "delivered",
  "cancelled",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export type StatusTransitionAction = "rto" | "dispatch";

export const STATUS_ERROR_CODES = {
  PICKUP_NO_DISPATCH: "PICKUP_NO_DISPATCH",
  PICKUP_NO_RTO: "PICKUP_NO_RTO",
  DELIVERY_NO_READY_FOR_PICKUP: "DELIVERY_NO_READY_FOR_PICKUP",
  RTO_REQUIRES_DISPATCHED: "RTO_REQUIRES_DISPATCHED",
  INVALID_STATUS: "INVALID_STATUS",
} as const;

export type StatusErrorCode = (typeof STATUS_ERROR_CODES)[keyof typeof STATUS_ERROR_CODES];

export type StatusTransitionResult =
  | { ok: true; nextStatus: OrderStatus }
  | { ok: false; status: 400 | 409; code: StatusErrorCode; error: string };

export function isOrderStatus(value: unknown): value is OrderStatus {
  return typeof value === "string" && (ORDER_STATUSES as readonly string[]).includes(value);
}

/** orders.fulfilment: 'pickup' = collect at a pickup point. NULL / 'delivery' / anything else = delivery. */
export function isPickupOrder(fulfilment: unknown): boolean {
  return typeof fulfilment === "string" && fulfilment.trim().toLowerCase() === "pickup";
}

function refuse(
  code: StatusErrorCode,
  error: string,
  status: 400 | 409 = 409
): StatusTransitionResult {
  return { ok: false, status, code, error };
}

export function assertStatusTransition(input: {
  fulfilment: unknown;
  from: unknown;
  to: unknown;
  action?: StatusTransitionAction;
}): StatusTransitionResult {
  const { to, action } = input;
  if (!isOrderStatus(to)) {
    return refuse(STATUS_ERROR_CODES.INVALID_STATUS, "Invalid status", 400);
  }
  const from = isOrderStatus(input.from) ? input.from : null;

  if (isPickupOrder(input.fulfilment)) {
    if (to === "dispatched" || action === "dispatch") {
      return refuse(
        STATUS_ERROR_CODES.PICKUP_NO_DISPATCH,
        "Pickup orders cannot be dispatched"
      );
    }
    if (action === "rto") {
      return refuse(
        STATUS_ERROR_CODES.PICKUP_NO_RTO,
        "Pickup orders cannot be marked as returned to origin"
      );
    }
    return { ok: true, nextStatus: to };
  }

  // Delivery orders.
  if (to === "ready_for_pickup") {
    return refuse(
      STATUS_ERROR_CODES.DELIVERY_NO_READY_FOR_PICKUP,
      "Only pickup orders can be marked ready for pickup"
    );
  }
  if (action === "rto" && from !== "dispatched") {
    return refuse(
      STATUS_ERROR_CODES.RTO_REQUIRES_DISPATCHED,
      "Only dispatched orders can be marked as returned to origin"
    );
  }
  return { ok: true, nextStatus: to };
}

// ---------------------------------------------------------------------------
// Public tracking text (never exposes a rider phone number)
// ---------------------------------------------------------------------------

const FIRST_NAME_MAX = 30;

/** First whitespace-separated word of the rider's name, control characters removed. "" when none. */
export function riderFirstName(name: unknown): string {
  if (name === null || name === undefined) return "";
  const cleaned = String(name)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim();
  const first = cleaned.split(/\s+/)[0] ?? "";
  return first.length > FIRST_NAME_MAX ? first.slice(0, FIRST_NAME_MAX) : first;
}

/** "Out for delivery with our rider (Ali)"; without a usable name just "Out for delivery with our rider". */
export function ownRiderTrackingLabel(riderName: unknown): string {
  const first = riderFirstName(riderName);
  return first
    ? `Out for delivery with our rider (${first})`
    : "Out for delivery with our rider";
}

/** "Ready for pickup at <point>"; without a point name just "Ready for pickup". */
export function readyForPickupLabel(pointName: unknown): string {
  const name = pointName === null || pointName === undefined ? "" : String(pointName).trim();
  return name ? `Ready for pickup at ${name}` : "Ready for pickup";
}

/** Customer-facing label for the final status: pickup orders read "Picked up". */
export function deliveredLabel(fulfilment: unknown): string {
  return isPickupOrder(fulfilment) ? "Picked up" : "Delivered";
}
