"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  SIDEBAR_GROUPS,
  itemVisibleForRole,
  readSidebarOpenState,
  sumBadgeNumbers,
  tabToGroupId,
  writeSidebarOpenState,
  type SidebarOpenState,
} from "@/lib/adminSidebarGroups";

export type SidebarBadges = {
  orders?: string | null;
};

type Props = {
  tab: string;
  adminRole: string;
  badges: SidebarBadges;
  onSelectTab: (id: string) => void;
  onCloseMobile: () => void;
};

export default function AdminSidebarNav({
  tab,
  adminRole,
  badges,
  onSelectTab,
  onCloseMobile,
}: Props) {
  const [openState, setOpenState] = useState<SidebarOpenState>(() =>
    readSidebarOpenState(tab, null)
  );

  useEffect(() => {
    const storage =
      typeof window !== "undefined" ? window.localStorage : null;
    let cancelled = false;
    // Defer so hydration is not a synchronous setState-in-effect (React Compiler lint).
    Promise.resolve().then(() => {
      if (cancelled) return;
      setOpenState(readSidebarOpenState(tab, storage));
    });
    return () => {
      cancelled = true;
    };
  }, [tab]);

  const persist = useCallback((next: SidebarOpenState) => {
    setOpenState(next);
    const storage =
      typeof window !== "undefined" ? window.localStorage : null;
    writeSidebarOpenState(next, storage);
  }, []);

  const toggleGroup = useCallback(
    (groupId: string) => {
      const activeGroup = tabToGroupId(tab);
      if (groupId === activeGroup && openState[groupId]) return;
      const next = { ...openState, [groupId]: !openState[groupId] };
      persist(next);
    },
    [openState, persist, tab]
  );

  const badgeFor = useCallback(
    (id: string): string | null => {
      if (id === "orders") return badges.orders || null;
      return null;
    },
    [badges]
  );

  const groups = useMemo(() => {
    return SIDEBAR_GROUPS.map((g) => {
      const items = g.items.filter((item) =>
        itemVisibleForRole(item, adminRole)
      );
      return { ...g, items };
    }).filter((g) => g.items.length > 0);
  }, [adminRole]);

  return (
    <nav className="sidebar-nav" data-testid="sidhu-sidebar-nav">
      {groups.map((g) => {
        const isSingle = g.label == null;
        const activeGroup = tabToGroupId(tab) === g.id;
        const expanded = isSingle || !!openState[g.id] || activeGroup;
        const panelId = `sidebar-group-${g.id}`;

        const itemBadges = g.items.map((i) => badgeFor(i.id));
        const badgeSum = sumBadgeNumbers(itemBadges);
        const showHeaderBadge = !expanded && badgeSum > 0;

        const renderItems = () =>
          g.items.map((item) => {
            const active = tab === item.id;
            const badge = badgeFor(item.id);
            return (
              <button
                key={item.id}
                type="button"
                className={`nav-item ${active ? "active" : ""}`}
                data-testid={`sidebar-tab-${item.id}`}
                data-sidebar-tab={item.id}
                onClick={() => {
                  onSelectTab(item.id);
                  onCloseMobile();
                }}
              >
                <span className="nav-icon">{item.icon}</span>
                {item.label}
                {badge ? (
                  <span className="nav-badge orange">{badge}</span>
                ) : null}
              </button>
            );
          });

        if (isSingle) {
          return (
            <div key={g.id} data-sidebar-group={g.id}>
              {renderItems()}
            </div>
          );
        }

        return (
          <div
            key={g.id}
            data-sidebar-group={g.id}
            style={{ marginBottom: 4 }}
          >
            <button
              type="button"
              className="nav-item"
              data-testid={`sidebar-group-toggle-${g.id}`}
              aria-expanded={expanded}
              aria-controls={panelId}
              onClick={() => toggleGroup(g.id)}
              style={{
                fontWeight: 700,
                fontSize: 11,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
                opacity: 0.92,
                cursor: activeGroup && expanded ? "default" : "pointer",
              }}
            >
              <span className="nav-icon">{g.icon}</span>
              <span style={{ flex: 1 }}>{g.label}</span>
              <span aria-hidden="true" style={{ fontSize: 14, opacity: 0.8 }}>
                {expanded ? "−" : "+"}
              </span>
              {showHeaderBadge ? (
                <span
                  className="nav-badge orange"
                  data-testid={`sidebar-group-badge-${g.id}`}
                >
                  {String(badgeSum)}
                </span>
              ) : null}
            </button>
            <div
              id={panelId}
              role="region"
              hidden={!expanded}
              style={{
                display: expanded ? "flex" : "none",
                flexDirection: "column",
                gap: 3,
                paddingLeft: 6,
              }}
            >
              {renderItems()}
            </div>
          </div>
        );
      })}
    </nav>
  );
}
