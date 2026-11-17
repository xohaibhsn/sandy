"use client";

export type OrderDatePreset = "all" | "today" | "7d" | "30d" | "this_month" | "custom";

export type OrderFilterDraft = {
  q: string;
  status: string;
  payment_method: string;
  preset: OrderDatePreset;
  from: string;
  to: string;
};

export const EMPTY_ORDER_FILTERS: OrderFilterDraft = {
  q: "",
  status: "all",
  payment_method: "all",
  preset: "all",
  from: "",
  to: "",
};

export const ORDER_SEARCH_MIN = 2;
export const ORDER_SEARCH_MAX = 80;

const PAYMENT_LABELS: Record<string, string> = {
  cod: "COD",
  jazzcash: "JazzCash",
  easypaisa: "Easypaisa",
  bank: "Bank",
};

/** Human label for a stored payment_method value (plain text). */
export function paymentLabel(value: unknown): string {
  const key = String(value ?? "").trim().toLowerCase();
  if (!key) return "—";
  return PAYMENT_LABELS[key] || key;
}

const PRESETS: Array<{ id: OrderDatePreset; label: string }> = [
  { id: "today", label: "Today" },
  { id: "7d", label: "7d" },
  { id: "30d", label: "30d" },
  { id: "this_month", label: "This month" },
  { id: "all", label: "All" },
];

/** Returns an error message for the draft, or "" when it can be applied. */
export function validateOrderFilters(f: OrderFilterDraft): string {
  const q = f.q.trim();
  if (q && (q.length < ORDER_SEARCH_MIN || q.length > ORDER_SEARCH_MAX)) {
    return `Search must be ${ORDER_SEARCH_MIN}-${ORDER_SEARCH_MAX} characters.`;
  }
  if (f.preset === "custom") {
    if (!f.from || !f.to) return "Choose both a from and to date.";
    if (f.from > f.to) return "The from date must not be after the to date.";
  }
  return "";
}

export type OrdersToolbarProps = {
  draft: OrderFilterDraft;
  onDraftChange: (next: OrderFilterDraft) => void;
  onApply: () => void;
  onClear: () => void;
  onExport: () => void;
  exporting?: boolean;
  disabled?: boolean;
};

const labelStyle = { fontSize: 11, color: "#666", fontWeight: 600 } as const;
const fieldStyle = { display: "flex", flexDirection: "column", gap: 4 } as const;

/**
 * Filter bar for the admin Orders tab. All values are controlled by the parent
 * (draft state) and only sent to the server when Apply is pressed.
 */
export default function OrdersToolbar({
  draft,
  onDraftChange,
  onApply,
  onClear,
  onExport,
  exporting = false,
  disabled = false,
}: OrdersToolbarProps) {
  const validationError = validateOrderFilters(draft);
  const set = (patch: Partial<OrderFilterDraft>) => onDraftChange({ ...draft, ...patch });

  return (
    <form
      data-orders-toolbar="1"
      aria-label="Order filters"
      onSubmit={(e) => {
        e.preventDefault();
        if (!validationError && !disabled) onApply();
      }}
      style={{
        padding: "14px 20px",
        borderBottom: "1px solid #F0F0F0",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
        <div style={{ ...fieldStyle, flex: "1 1 220px" }}>
          <label htmlFor="orders-filter-q" style={labelStyle}>
            Search
          </label>
          <input
            id="orders-filter-q"
            type="search"
            className="filter-select"
            data-orders-filter="q"
            placeholder="Order ID, name, email or phone"
            maxLength={ORDER_SEARCH_MAX}
            value={draft.q}
            onChange={(e) => set({ q: e.target.value })}
            style={{ width: "100%", cursor: "text" }}
          />
        </div>
        <div style={fieldStyle}>
          <label htmlFor="orders-filter-status" style={labelStyle}>
            Status
          </label>
          <select
            id="orders-filter-status"
            className="filter-select"
            data-orders-filter="status"
            value={draft.status}
            onChange={(e) => set({ status: e.target.value })}
          >
            <option value="all">All Status</option>
            <option value="pending">Pending</option>
            <option value="confirmed">Confirmed</option>
            <option value="dispatched">Dispatched</option>
            <option value="delivered">Delivered</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>
        <div style={fieldStyle}>
          <label htmlFor="orders-filter-payment" style={labelStyle}>
            Payment
          </label>
          <select
            id="orders-filter-payment"
            className="filter-select"
            data-orders-filter="payment_method"
            value={draft.payment_method}
            onChange={(e) => set({ payment_method: e.target.value })}
          >
            <option value="all">All Payments</option>
            <option value="cod">COD</option>
            <option value="jazzcash">JazzCash</option>
            <option value="easypaisa">Easypaisa</option>
            <option value="bank">Bank</option>
          </select>
        </div>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
        <div style={fieldStyle} role="group" aria-label="Date range presets">
          <span style={labelStyle}>Date (Asia/Karachi)</span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {PRESETS.map((p) => {
              const active = draft.preset === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  className={`action-btn ${active ? "btn-verify" : "btn-view"}`}
                  data-orders-preset={p.id}
                  aria-pressed={active}
                  onClick={() => set({ preset: p.id, from: "", to: "" })}
                  style={{ marginRight: 0 }}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
        </div>
        <div style={fieldStyle}>
          <label htmlFor="orders-filter-from" style={labelStyle}>
            From
          </label>
          <input
            id="orders-filter-from"
            type="date"
            className="filter-select"
            data-orders-filter="from"
            value={draft.from}
            onChange={(e) => set({ preset: "custom", from: e.target.value })}
          />
        </div>
        <div style={fieldStyle}>
          <label htmlFor="orders-filter-to" style={labelStyle}>
            To
          </label>
          <input
            id="orders-filter-to"
            type="date"
            className="filter-select"
            data-orders-filter="to"
            value={draft.to}
            onChange={(e) => set({ preset: "custom", to: e.target.value })}
          />
        </div>
        <div style={{ display: "flex", gap: 8, marginLeft: "auto", flexWrap: "wrap" }}>
          <button
            type="submit"
            className="add-btn"
            data-orders-apply="1"
            disabled={disabled || !!validationError}
          >
            Apply
          </button>
          <button
            type="button"
            className="action-btn btn-view"
            data-orders-clear="1"
            onClick={onClear}
            disabled={disabled}
            style={{ marginRight: 0 }}
          >
            Clear
          </button>
          <button
            type="button"
            className="action-btn btn-view"
            data-export-csv="1"
            onClick={onExport}
            disabled={disabled || exporting}
            style={{ marginRight: 0 }}
          >
            {exporting ? "Exporting…" : "Export CSV"}
          </button>
        </div>
      </div>

      {validationError ? (
        <div
          role="alert"
          data-orders-filter-error="1"
          style={{ fontSize: 12, color: "#DC2626" }}
        >
          {validationError}
        </div>
      ) : null}
    </form>
  );
}
