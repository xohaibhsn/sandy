export type PublicAvailabilityLabel =
  | "In stock"
  | "Out of stock"
  | "Available"
  | "Availability unavailable";

export type PublicAvailability = {
  label: PublicAvailabilityLabel;
  available: boolean;
  tracked: boolean;
};

type InventoryFields = {
  track_inventory?: unknown;
  stock_quantity?: unknown;
};

function parseTrackFlag(value: unknown): 0 | 1 | null {
  if (value === true || value === 1 || value === "1") return 1;
  if (value === false || value === 0 || value === "0") return 0;
  return null;
}

function parseStockQuantity(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) return null;
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const n = Number(trimmed);
    if (!Number.isInteger(n) || n < 0) return null;
    return n;
  }
  return null;
}

/**
 * Public availability from canonical inventory fields only.
 * Does not read legacy `stock` and does not expose exact quantity.
 */
export function getPublicAvailability(product: InventoryFields): PublicAvailability {
  const track = parseTrackFlag(product.track_inventory);

  if (track === null) {
    return { label: "Availability unavailable", available: false, tracked: false };
  }

  if (track === 0) {
    return { label: "Available", available: true, tracked: false };
  }

  const qty = parseStockQuantity(product.stock_quantity);
  if (qty === null) {
    return { label: "Availability unavailable", available: false, tracked: true };
  }

  if (qty === 0) {
    return { label: "Out of stock", available: false, tracked: true };
  }

  return { label: "In stock", available: true, tracked: true };
}

export function schemaAvailabilityUrl(availability: PublicAvailability): string {
  return availability.available
    ? "https://schema.org/InStock"
    : "https://schema.org/OutOfStock";
}
