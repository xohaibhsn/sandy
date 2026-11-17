"use client";

export type PaginationProps = {
  page: number;
  totalPages: number;
  total: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  pageSizes?: number[];
  disabled?: boolean;
  itemLabel?: string;
};

const DEFAULT_PAGE_SIZES = [10, 25, 50, 100];

export default function Pagination({
  page,
  totalPages,
  total,
  pageSize,
  onPageChange,
  onPageSizeChange,
  pageSizes = DEFAULT_PAGE_SIZES,
  disabled = false,
  itemLabel = "orders",
}: PaginationProps) {
  const safeTotalPages = Math.max(1, totalPages || 1);
  const safePage = Math.min(Math.max(1, page || 1), safeTotalPages);
  const from = total === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const to = Math.min(safePage * pageSize, total);
  const prevDisabled = disabled || safePage <= 1;
  const nextDisabled = disabled || safePage >= safeTotalPages;

  return (
    <nav
      data-orders-pagination="1"
      aria-label="Pagination"
      style={{
        padding: "8px 20px",
        fontSize: 12,
        color: "#888888",
        borderBottom: "1px solid #F0F0F0",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 8,
      }}
    >
      <span data-pagination-summary="1">
        Showing {from}–{to} of {total} {itemLabel}
      </span>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <label htmlFor="orders-page-size" style={{ display: "flex", gap: 6, alignItems: "center" }}>
          Per page
          <select
            id="orders-page-size"
            className="filter-select"
            data-pagination-size="1"
            value={pageSize}
            disabled={disabled}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
          >
            {pageSizes.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="action-btn btn-view"
          data-pagination-prev="1"
          disabled={prevDisabled}
          onClick={() => onPageChange(safePage - 1)}
          style={{ opacity: prevDisabled ? 0.4 : 1, marginRight: 0 }}
        >
          ← Prev
        </button>
        <span aria-live="polite">
          Page {safePage} of {safeTotalPages}
        </span>
        <button
          type="button"
          className="action-btn btn-view"
          data-pagination-next="1"
          disabled={nextDisabled}
          onClick={() => onPageChange(safePage + 1)}
          style={{ opacity: nextDisabled ? 0.4 : 1, marginRight: 0 }}
        >
          Next →
        </button>
      </div>
    </nav>
  );
}
