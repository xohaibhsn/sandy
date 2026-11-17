"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { tabsForRole } from "../../lib/adminSidebarGroups";

/**
 * ADMIN-SEARCH-01 — global admin search palette (Ctrl+K / Cmd+K).
 *
 * Controlled: the page owns `open`. The hotkey listener lives here, so it only exists while the
 * admin page (and this component) is mounted. All server text is rendered as plain React text.
 * Role filtering is done by the server; this component additionally ignores groups the role
 * must never see (defence in depth) and disables hits whose tab is not in the role's sidebar.
 */

export type AdminSearchTarget =
  | { kind: "order"; tab: "orders"; orderId: string }
  | { kind: "customer"; tab: "orders"; email: string }
  | { kind: "product"; tab: "products"; id: number; name: string }
  | { kind: "blog"; tab: "blog"; id: number; title: string }
  | { kind: "faq"; tab: "faqadmin"; id: number };

export type AdminGlobalSearchProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate: (target: AdminSearchTarget) => void;
  role: string;
};

type OrderHit = {
  order_id?: string;
  status?: string;
  customer_name?: string;
  customer_email?: string;
};
type CustomerHit = {
  customer_email?: string;
  customer_name?: string;
  order_count?: number;
};
type ProductHit = { id?: number; name?: string; slug?: string };
type BlogHit = { id?: number; title?: string; status?: string };
type FaqHit = { id?: number; question?: string };

type Groups = {
  orders?: OrderHit[];
  customers?: CustomerHit[];
  products?: ProductHit[];
  blog?: BlogHit[];
  faqs?: FaqHit[];
};

type Row = {
  key: string;
  group: string;
  title: string;
  meta: string;
  target: AdminSearchTarget;
};

type Outcome = { key: string; groups: Groups | null; error: string };

const MIN_CHARS = 2;
const MAX_CHARS = 80;
const DEBOUNCE_MS = 250;
const ACCENT = "#5B21B6";

const MANAGER_GROUPS = ["orders", "customers", "products", "blog", "faqs"] as const;
const WRITER_GROUPS = ["blog", "faqs"] as const;

/** True for Ctrl+K / Cmd+K without Alt/Shift. */
export function isAdminSearchHotkey(e: KeyboardEvent): boolean {
  return (
    (e.ctrlKey || e.metaKey) &&
    !e.altKey &&
    !e.shiftKey &&
    typeof e.key === "string" &&
    e.key.toLowerCase() === "k"
  );
}

/** Another modal (page modal overlay or ARIA dialog/drawer) is already capturing input. */
function otherModalOpen(): boolean {
  if (typeof document === "undefined") return false;
  return !!document.querySelector(
    '.modal-overlay, [role="dialog"][aria-modal="true"]:not([data-admin-global-search-dialog])'
  );
}

function arr<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function s(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function joinMeta(parts: Array<string | undefined>): string {
  return parts.filter((p) => p && p.trim()).join(" · ");
}

function buildRows(groups: Groups | null, role: string): Row[] {
  if (!groups) return [];
  const allowed: readonly string[] =
    role === "super_admin" || role === "manager" ? MANAGER_GROUPS : WRITER_GROUPS;
  const rows: Row[] = [];

  if (allowed.includes("orders")) {
    arr<OrderHit>(groups.orders).forEach((o, i) => {
      const id = s(o?.order_id);
      if (!id) return;
      rows.push({
        key: `order:${id}:${i}`,
        group: "Orders",
        title: `#${id}`,
        meta: joinMeta([s(o.status), s(o.customer_name) || s(o.customer_email)]),
        target: { kind: "order", tab: "orders", orderId: id },
      });
    });
  }
  if (allowed.includes("customers")) {
    arr<CustomerHit>(groups.customers).forEach((c, i) => {
      const email = s(c?.customer_email);
      if (!email) return;
      const n = Number(c.order_count) || 0;
      rows.push({
        key: `customer:${email}:${i}`,
        group: "Customers",
        title: s(c.customer_name) || email,
        meta: joinMeta([s(c.customer_name) ? email : "", n > 0 ? `${n} order${n === 1 ? "" : "s"}` : ""]),
        target: { kind: "customer", tab: "orders", email },
      });
    });
  }
  if (allowed.includes("products")) {
    arr<ProductHit>(groups.products).forEach((p, i) => {
      const id = Number(p?.id);
      if (!Number.isFinite(id)) return;
      rows.push({
        key: `product:${id}:${i}`,
        group: "Products",
        title: s(p.name) || `Product ${id}`,
        meta: s(p.slug),
        target: { kind: "product", tab: "products", id, name: s(p.name) },
      });
    });
  }
  if (allowed.includes("blog")) {
    arr<BlogHit>(groups.blog).forEach((b, i) => {
      const id = Number(b?.id);
      if (!Number.isFinite(id)) return;
      rows.push({
        key: `blog:${id}:${i}`,
        group: "Blog posts",
        title: s(b.title) || `Post ${id}`,
        meta: s(b.status),
        target: { kind: "blog", tab: "blog", id, title: s(b.title) },
      });
    });
  }
  if (allowed.includes("faqs")) {
    arr<FaqHit>(groups.faqs).forEach((f, i) => {
      const id = Number(f?.id);
      if (!Number.isFinite(id)) return;
      rows.push({
        key: `faq:${id}:${i}`,
        group: "FAQs",
        title: s(f.question) || `FAQ ${id}`,
        meta: "",
        target: { kind: "faq", tab: "faqadmin", id },
      });
    });
  }
  return rows;
}

function errorMessage(status: number): string {
  if (status === 401 || status === 403) return "Your session expired. Please sign in again.";
  if (status === 429) return "Too many searches. Wait a moment and try again.";
  return "Search failed. Please try again.";
}

type PaletteProps = {
  onClose: () => void;
  onNavigate: (target: AdminSearchTarget) => void;
  role: string;
};

/** Mounted only while open, so its state (query, results, highlight) resets on every open. */
function Palette({ onClose, onNavigate, role }: PaletteProps) {
  const uid = useId();
  const listId = `${uid}-list`;
  const titleId = `${uid}-title`;
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const [q, setQ] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [active, setActive] = useState(0);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const trimmed = q.trim();
  const searchable = trimmed.length >= MIN_CHARS;
  const requestKey = `${trimmed}#${attempt}`;

  // Focus the input on open; restore previous focus on close.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => {
      const target =
        previous && previous !== document.body && document.contains(previous)
          ? previous
          : document.querySelector<HTMLElement>("[data-admin-global-search-btn]");
      target?.focus();
    };
  }, []);

  // Debounced fetch; the previous request is aborted whenever the query changes or on unmount.
  useEffect(() => {
    if (!searchable) return;
    const ctrl = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/admin-search?q=${encodeURIComponent(trimmed)}`, {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          signal: ctrl.signal,
        });
        if (!res.ok) {
          if (!ctrl.signal.aborted) {
            setOutcome({ key: requestKey, groups: null, error: errorMessage(res.status) });
          }
          return;
        }
        const body = (await res.json()) as { groups?: Groups };
        if (ctrl.signal.aborted) return;
        setOutcome({ key: requestKey, groups: body && body.groups ? body.groups : {}, error: "" });
      } catch {
        if (ctrl.signal.aborted) return;
        setOutcome({ key: requestKey, groups: null, error: errorMessage(0) });
      }
    }, DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
    };
  }, [trimmed, searchable, requestKey]);

  const current = searchable && outcome && outcome.key === requestKey ? outcome : null;
  const loading = searchable && !current;
  const rows = useMemo(() => buildRows(current ? current.groups : null, role), [current, role]);
  const allowedTabs = useMemo(() => new Set<string>(tabsForRole(role)), [role]);
  const activeIdx = rows.length ? Math.min(active, rows.length - 1) : -1;

  const canOpen = useCallback((row: Row) => allowedTabs.has(row.target.tab), [allowedTabs]);

  const choose = useCallback(
    (row: Row) => {
      if (!canOpen(row)) return;
      onClose();
      onNavigate(row.target);
    },
    [canOpen, onClose, onNavigate]
  );

  useEffect(() => {
    if (activeIdx < 0) return;
    const el = dialogRef.current?.querySelector<HTMLElement>(`[data-admin-search-index="${activeIdx}"]`);
    if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
  }, [activeIdx, rows]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key === "Tab") {
      const nodes = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>("input, button:not([disabled])") ?? []
      );
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const at = document.activeElement;
      if (e.shiftKey && (at === first || !dialogRef.current?.contains(at))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (at === last || !dialogRef.current?.contains(at))) {
        e.preventDefault();
        first.focus();
      }
      return;
    }
    if (rows.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((activeIdx + 1) % rows.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((activeIdx - 1 + rows.length) % rows.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[activeIdx];
      if (row) choose(row);
    }
  };

  return (
    <div
      data-admin-global-search-overlay="1"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 400,
        background: "rgba(17,17,17,0.45)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "10vh 16px 16px",
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-admin-global-search-dialog="1"
        data-testid="admin-global-search"
        onKeyDown={onKeyDown}
        style={{
          width: "min(560px, 100%)",
          maxHeight: "70vh",
          display: "flex",
          flexDirection: "column",
          background: "#fff",
          borderRadius: 12,
          boxShadow: "0 18px 50px rgba(0,0,0,0.28)",
          overflow: "hidden",
          fontSize: 13,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 14px", borderBottom: "1px solid #EDE9FE" }}>
          <span id={titleId} style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
            Search admin
          </span>
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeIdx >= 0 ? `${uid}-opt-${activeIdx}` : undefined}
            aria-label="Search orders, customers, products, blog posts and FAQs"
            placeholder="Search orders, customers, products, blog, FAQs…"
            autoComplete="off"
            spellCheck={false}
            maxLength={MAX_CHARS}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            style={{
              flex: 1,
              minWidth: 0,
              padding: "9px 12px",
              border: "1px solid #DDD6FE",
              borderRadius: 8,
              fontSize: 14,
              outlineColor: ACCENT,
            }}
          />
          <button
            type="button"
            aria-label="Close search"
            data-admin-search-close="1"
            onClick={onClose}
            style={{ border: "1px solid #E5E5E5", background: "#F5F5F5", borderRadius: 8, padding: "6px 10px", cursor: "pointer", fontSize: 12 }}
          >
            Esc
          </button>
        </div>

        <div id={listId} role="listbox" aria-label="Search results" style={{ overflowY: "auto", minHeight: 0 }}>
          {!searchable ? (
            <div data-admin-search-hint="1" style={{ padding: "14px 16px", color: "#666" }}>
              Type at least {MIN_CHARS} characters to search.
            </div>
          ) : null}
          {loading ? (
            <div data-admin-search-loading="1" role="status" style={{ padding: "14px 16px", color: "#666" }}>
              Searching…
            </div>
          ) : null}
          {current && current.error ? (
            <div data-admin-search-error="1" role="alert" style={{ padding: "14px 16px", color: "#B91C1C", display: "flex", gap: 12, alignItems: "center" }}>
              <span>{current.error}</span>
              <button
                type="button"
                data-admin-search-retry="1"
                onClick={() => setAttempt((n) => n + 1)}
                style={{ border: "1px solid #FCA5A5", background: "#fff", color: "#B91C1C", borderRadius: 6, padding: "3px 10px", cursor: "pointer", fontSize: 12 }}
              >
                Retry
              </button>
            </div>
          ) : null}
          {current && !current.error && rows.length === 0 ? (
            <div data-admin-search-empty="1" role="status" style={{ padding: "14px 16px", color: "#666" }}>
              No results found.
            </div>
          ) : null}

          {rows.map((row, idx) => {
            const header = idx === 0 || rows[idx - 1].group !== row.group ? row.group : null;
            const isActive = idx === activeIdx;
            const disabled = !canOpen(row);
            return (
              <div key={row.key} role="presentation">
                {header ? (
                  <div
                    role="presentation"
                    data-admin-search-group={header}
                    style={{ padding: "8px 16px 3px", fontSize: 10, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", color: ACCENT }}
                  >
                    {header}
                  </div>
                ) : null}
                <div
                  id={`${uid}-opt-${idx}`}
                  role="option"
                  aria-selected={isActive}
                  aria-disabled={disabled || undefined}
                  data-admin-search-item={row.target.kind}
                  data-admin-search-index={idx}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseMove={() => {
                    if (idx !== activeIdx) setActive(idx);
                  }}
                  onClick={() => choose(row)}
                  style={{
                    display: "flex",
                    gap: 10,
                    alignItems: "baseline",
                    padding: "7px 16px",
                    cursor: disabled ? "not-allowed" : "pointer",
                    opacity: disabled ? 0.55 : 1,
                    background: isActive ? "#F5F3FF" : "transparent",
                    borderLeft: `3px solid ${isActive ? ACCENT : "transparent"}`,
                    color: "#111",
                  }}
                >
                  <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600 }}>
                    {row.title}
                  </span>
                  {row.meta || disabled ? (
                    <span style={{ marginLeft: "auto", flexShrink: 0, color: "#777", fontSize: 12, maxWidth: "50%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {disabled ? "Not available for your role" : row.meta}
                    </span>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ padding: "8px 14px", borderTop: "1px solid #EDE9FE", color: "#888", fontSize: 11 }}>
          ↑↓ navigate · Enter open · Esc close
        </div>
      </div>
    </div>
  );
}

export default function AdminGlobalSearch({ open, onOpenChange, onNavigate, role }: AdminGlobalSearchProps) {
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  // Ctrl/Cmd+K — only captured while this component is mounted (admin page) and no other modal is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isAdminSearchHotkey(e) || e.defaultPrevented) return;
      if (openRef.current) {
        e.preventDefault();
        return;
      }
      if (otherModalOpen()) return;
      e.preventDefault();
      onOpenChange(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onOpenChange]);

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  if (!open) return null;
  return <Palette onClose={close} onNavigate={onNavigate} role={role} />;
}
