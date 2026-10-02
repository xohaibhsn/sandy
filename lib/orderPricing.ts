/**
 * Pure server-side order pricing primitives.
 * No DB, network, env, or side effects — financial authority helpers for Phase B.
 */

export const MAX_REQUEST_ITEM_ROWS = 100;
export const MAX_LINE_QTY = 99;
export const MIN_LINE_QTY = 1;

export type RequestLineItem = {
  id: number;
  qty: number;
};

export type PricedLineItem = {
  product_id: number;
  product_name: string;
  price: number;
  quantity: number;
};

export type NormalizeItemsResult =
  | { ok: true; items: RequestLineItem[] }
  | { ok: false; error: string };

export type MoneyResult =
  | { ok: true; amount: number }
  | { ok: false; error: string };

export type CouponType = "percentage" | "fixed";

export type CouponDiscountResult =
  | { ok: true; discount_amount: number }
  | { ok: false; error: string };

export type OrderTotals = {
  subtotal: number;
  shipping: number;
  vat_amount: number;
  discount_amount: number;
  total: number;
};

export type OrderTotalsResult =
  | { ok: true; totals: OrderTotals }
  | { ok: false; error: string };

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveInt(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value > 0;
}

function isQtyInt(value: unknown): value is number {
  return (
    isFiniteNumber(value) &&
    Number.isInteger(value) &&
    value >= MIN_LINE_QTY &&
    value <= MAX_LINE_QTY
  );
}

/** Round to 2 decimal places using project-compatible half-up semantics. */
export function roundMoney(value: unknown): MoneyResult {
  if (!isFiniteNumber(value)) {
    return { ok: false, error: "Invalid money amount" };
  }
  return { ok: true, amount: Math.round(value * 100) / 100 };
}

/**
 * Normalize untrusted request items to positive integer id + qty.
 * Aggregates duplicate ids; rejects oversized arrays and post-aggregate qty > 99.
 */
export function normalizeRequestItems(input: unknown): NormalizeItemsResult {
  if (!Array.isArray(input)) {
    return { ok: false, error: "Items must be a non-empty array" };
  }
  if (input.length === 0) {
    return { ok: false, error: "Items must be a non-empty array" };
  }
  if (input.length > MAX_REQUEST_ITEM_ROWS) {
    return { ok: false, error: "Too many items" };
  }

  const order: number[] = [];
  const qtyById = new Map<number, number>();

  for (const row of input) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      return { ok: false, error: "Invalid item" };
    }
    const rec = row as Record<string, unknown>;
    const id = rec.id;
    const qty = rec.qty;

    // Strict: numbers only — no Number("1") coercion
    if (!isPositiveInt(id)) {
      return { ok: false, error: "Invalid product id" };
    }
    if (!isQtyInt(qty)) {
      return { ok: false, error: "Invalid quantity" };
    }

    if (!qtyById.has(id)) {
      order.push(id);
      qtyById.set(id, qty);
    } else {
      const combined = (qtyById.get(id) as number) + qty;
      if (combined > MAX_LINE_QTY) {
        return { ok: false, error: "Quantity exceeds maximum" };
      }
      qtyById.set(id, combined);
    }
  }

  const items: RequestLineItem[] = order.map((id) => ({
    id,
    qty: qtyById.get(id) as number,
  }));

  return { ok: true, items };
}

/**
 * Subtotal from authoritative priced lines (server-resolved prices only).
 */
export function calculateSubtotal(items: unknown): MoneyResult {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, error: "Invalid priced items" };
  }

  let sum = 0;
  for (const row of items) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      return { ok: false, error: "Invalid priced item" };
    }
    const rec = row as Record<string, unknown>;
    const price = rec.price;
    const quantity = rec.quantity;

    if (!isFiniteNumber(price) || price < 0) {
      return { ok: false, error: "Invalid price" };
    }
    if (!isQtyInt(quantity)) {
      return { ok: false, error: "Invalid quantity" };
    }

    sum += price * quantity;
  }

  return roundMoney(sum);
}

/**
 * Pure coupon arithmetic (percentage | fixed). Eligibility is Phase B's job.
 */
export function calculateCouponDiscount(
  baseAmount: unknown,
  type: unknown,
  value: unknown
): CouponDiscountResult {
  if (!isFiniteNumber(baseAmount) || baseAmount < 0) {
    return { ok: false, error: "Invalid coupon base" };
  }
  if (type !== "percentage" && type !== "fixed") {
    return { ok: false, error: "Invalid coupon type" };
  }
  if (!isFiniteNumber(value) || value < 0) {
    return { ok: false, error: "Invalid coupon value" };
  }

  let raw: number;
  if (type === "percentage") {
    raw = (baseAmount * value) / 100;
  } else {
    raw = value;
  }

  const capped = Math.min(raw, baseAmount);
  const rounded = roundMoney(capped);
  if (!rounded.ok) return { ok: false, error: rounded.error };
  return { ok: true, discount_amount: rounded.amount };
}

/**
 * Current checkout semantics:
 * vat = roundMoney(subtotal * taxRate)
 * total = roundMoney(subtotal + shipping + vat - discount)
 * Tax base is subtotal only (shipping not taxed). taxRate is a fraction (0.18 = 18%).
 */
export function calculateOrderTotals(input: {
  subtotal: unknown;
  shipping: unknown;
  taxRate: unknown;
  discountAmount: unknown;
}): OrderTotalsResult {
  const { subtotal, shipping, taxRate, discountAmount } = input;

  if (!isFiniteNumber(subtotal) || subtotal < 0) {
    return { ok: false, error: "Invalid subtotal" };
  }
  if (!isFiniteNumber(shipping) || shipping < 0) {
    return { ok: false, error: "Invalid shipping" };
  }
  if (!isFiniteNumber(taxRate) || taxRate < 0) {
    return { ok: false, error: "Invalid tax rate" };
  }
  if (!isFiniteNumber(discountAmount) || discountAmount < 0) {
    return { ok: false, error: "Invalid discount" };
  }

  const subRounded = roundMoney(subtotal);
  const shipRounded = roundMoney(shipping);
  const discRounded = roundMoney(discountAmount);
  if (!subRounded.ok || !shipRounded.ok || !discRounded.ok) {
    return { ok: false, error: "Invalid money amount" };
  }

  if (discRounded.amount > subRounded.amount + shipRounded.amount) {
    // Discount must not exceed economic base (subtotal+shipping) — prevents negative totals
    return { ok: false, error: "Discount exceeds payable base" };
  }

  const vatRaw = subRounded.amount * taxRate;
  const vatRounded = roundMoney(vatRaw);
  if (!vatRounded.ok) return { ok: false, error: vatRounded.error };

  const totalRaw =
    subRounded.amount + shipRounded.amount + vatRounded.amount - discRounded.amount;
  if (!Number.isFinite(totalRaw) || totalRaw < 0) {
    return { ok: false, error: "Invalid total" };
  }

  const totalRounded = roundMoney(totalRaw);
  if (!totalRounded.ok) return { ok: false, error: totalRounded.error };

  return {
    ok: true,
    totals: {
      subtotal: subRounded.amount,
      shipping: shipRounded.amount,
      vat_amount: vatRounded.amount,
      discount_amount: discRounded.amount,
      total: totalRounded.amount,
    },
  };
}
