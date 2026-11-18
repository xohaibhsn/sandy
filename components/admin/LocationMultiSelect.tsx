"use client";

import { useId, useMemo, useRef, useState } from "react";
import { normaliseCity } from "@/lib/shippingNormalise";

export type LocationOption = {
  value: string;
  label: string;
  /** Optional secondary text (e.g. province for a city). */
  group?: string;
  custom?: boolean;
};

type Props = {
  label: string;
  values: string[];
  options: LocationOption[];
  /** Normalised keys already taken by OTHER active zones — hidden from the list. */
  blockedKeys: ReadonlySet<string>;
  onChange: (next: string[]) => void;
  /** Allow typing a value not in the list (legacy / missing cities). */
  allowCustom?: boolean;
  customPlaceholder?: string;
  disabled?: boolean;
  /** data-* attribute for Playwright. */
  testId?: string;
};

const boxStyle: React.CSSProperties = {
  padding: "8px 10px",
  border: "1px solid #E5E5E5",
  borderRadius: 8,
  fontSize: 13,
  background: "#fff",
  color: "#111",
  minWidth: 260,
  maxWidth: 360,
};

const chipStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "2px 8px",
  borderRadius: 6,
  background: "#F3F4F6",
  border: "1px solid #E5E5E5",
  fontSize: 12,
  margin: "0 4px 4px 0",
};

function keyOf(v: string): string {
  return normaliseCity(v);
}

export default function LocationMultiSelect({
  label,
  values,
  options,
  blockedKeys,
  onChange,
  allowCustom = true,
  customPlaceholder = "Add other…",
  disabled = false,
  testId,
}: Props) {
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);

  const selectedKeys = useMemo(() => new Set(values.map(keyOf).filter(Boolean)), [values]);

  const optionByKey = useMemo(() => {
    const m = new Map<string, LocationOption>();
    for (const o of options) {
      const k = keyOf(o.value);
      if (k && !m.has(k)) m.set(k, o);
    }
    return m;
  }, [options]);

  const chips = useMemo(() => {
    return values
      .map((v) => {
        const k = keyOf(v);
        if (!k) return null;
        const known = optionByKey.get(k);
        return {
          value: v,
          key: k,
          label: known?.label || v,
          custom: !known || known.custom === true,
        };
      })
      .filter(Boolean) as { value: string; key: string; label: string; custom: boolean }[];
  }, [values, optionByKey]);

  const filtered = useMemo(() => {
    const q = keyOf(query);
    const out: LocationOption[] = [];
    for (const o of options) {
      const k = keyOf(o.value);
      if (!k) continue;
      if (selectedKeys.has(k)) continue;
      if (blockedKeys.has(k)) continue;
      if (q && !keyOf(o.label).includes(q) && !k.includes(q) && !(o.group && keyOf(o.group).includes(q))) {
        continue;
      }
      out.push(o);
    }
    return out.slice(0, 80);
  }, [options, selectedKeys, blockedKeys, query]);

  const canAddCustom = (() => {
    if (!allowCustom) return false;
    const t = query.trim();
    if (!t) return false;
    const k = keyOf(t);
    if (!k) return false;
    if (selectedKeys.has(k) || blockedKeys.has(k)) return false;
    if (optionByKey.has(k) && filtered.some((o) => keyOf(o.value) === k)) return false;
    // Offer custom when no exact option match remains visible
    return !filtered.some((o) => keyOf(o.value) === k);
  })();

  const menuItems: Array<{ kind: "option" | "custom"; option?: LocationOption; custom?: string }> = [
    ...filtered.map((o) => ({ kind: "option" as const, option: o })),
    ...(canAddCustom ? [{ kind: "custom" as const, custom: query.trim() }] : []),
  ];

  const addValue = (raw: string) => {
    const t = raw.trim();
    const k = keyOf(t);
    if (!k || selectedKeys.has(k) || blockedKeys.has(k)) return;
    // Prefer canonical spelling from the list when keys match
    const known = optionByKey.get(k);
    onChange([...values, known?.value || t]);
    setQuery("");
    setOpen(true);
    inputRef.current?.focus();
  };

  const removeKey = (k: string) => {
    onChange(values.filter((v) => keyOf(v) !== k));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" && !query && chips.length) {
      e.preventDefault();
      removeKey(chips[chips.length - 1].key);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActiveIdx((i) => Math.min(i + 1, Math.max(menuItems.length - 1, 0)));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const item = menuItems[activeIdx];
      if (!item) return;
      if (item.kind === "custom" && item.custom) addValue(item.custom);
      else if (item.option) addValue(item.option.value);
      return;
    }
    if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div style={{ fontSize: 12 }} data-location-multiselect={testId || "1"}>
      <div style={{ marginBottom: 4 }}>{label}</div>
      <div
        style={{ ...boxStyle, cursor: disabled ? "not-allowed" : "text" }}
        onClick={() => {
          if (!disabled) {
            setOpen(true);
            inputRef.current?.focus();
          }
        }}
      >
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center" }}>
          {chips.map((c) => (
            <span key={c.key} style={chipStyle} data-location-chip={c.key} data-custom={c.custom ? "1" : "0"}>
              <span>
                {c.label}
                {c.custom ? <span style={{ color: "#6B7280" }}> (custom)</span> : null}
              </span>
              <button
                type="button"
                aria-label={`Remove ${c.label}`}
                disabled={disabled}
                onClick={(e) => {
                  e.stopPropagation();
                  removeKey(c.key);
                }}
                style={{
                  border: "none",
                  background: "transparent",
                  cursor: disabled ? "not-allowed" : "pointer",
                  padding: 0,
                  lineHeight: 1,
                  color: "#6B7280",
                  fontSize: 14,
                }}
              >
                ×
              </button>
            </span>
          ))}
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-label={label}
            disabled={disabled}
            value={query}
            placeholder={chips.length ? "Search…" : customPlaceholder}
            data-location-search={testId || "1"}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIdx(0);
              setOpen(true);
            }}
            onFocus={() => {
              setActiveIdx(0);
              setOpen(true);
            }}
            onBlur={() => {
              // Delay so option mousedown can fire first
              window.setTimeout(() => setOpen(false), 150);
            }}
            onKeyDown={onKeyDown}
            style={{
              flex: 1,
              minWidth: 100,
              border: "none",
              outline: "none",
              fontSize: 13,
              padding: "2px 0",
              background: "transparent",
              color: "#111",
            }}
          />
        </div>
        {open && menuItems.length > 0 ? (
          <ul
            id={listId}
            role="listbox"
            data-location-options={testId || "1"}
            style={{
              listStyle: "none",
              margin: "8px 0 0",
              padding: 0,
              maxHeight: 200,
              overflowY: "auto",
              borderTop: "1px solid #F3F4F6",
            }}
          >
            {menuItems.map((item, idx) => {
              const selected = idx === activeIdx;
              if (item.kind === "custom" && item.custom) {
                return (
                  <li
                    key={`custom:${item.custom}`}
                    role="option"
                    aria-selected={selected}
                    data-location-option-custom="1"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      addValue(item.custom!);
                    }}
                    style={{
                      padding: "6px 4px",
                      cursor: "pointer",
                      background: selected ? "#F3F4F6" : "transparent",
                      fontStyle: "italic",
                    }}
                  >
                    Add &quot;{item.custom}&quot;
                  </li>
                );
              }
              const o = item.option!;
              return (
                <li
                  key={o.value}
                  role="option"
                  aria-selected={selected}
                  data-location-option={keyOf(o.value)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    addValue(o.value);
                  }}
                  style={{
                    padding: "6px 4px",
                    cursor: "pointer",
                    background: selected ? "#F3F4F6" : "transparent",
                  }}
                >
                  {o.label}
                  {o.group ? <span style={{ color: "#9CA3AF", marginLeft: 6 }}>{o.group}</span> : null}
                </li>
              );
            })}
          </ul>
        ) : null}
        {open && menuItems.length === 0 ? (
          <div style={{ marginTop: 8, color: "#9CA3AF", fontSize: 12 }} data-location-empty="1">
            No matches
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Split stored newline/comma list into display values (trim, keep first casing, de-dupe by key). */
export function splitLocationList(raw: string): string[] {
  const parts = String(raw || "").split(/[\r\n,;|]+/);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of parts) {
    const t = p.trim();
    if (!t) continue;
    const k = keyOf(t);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

export function joinLocationList(values: string[]): string {
  return values.map((v) => v.trim()).filter(Boolean).join("\n");
}
