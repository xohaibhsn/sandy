/**
 * Sandy admin sidebar groups (ADMIN-NAV-01).
 * Pure data + helpers — role filtering uses the same per-tab role lists as before.
 */

export type SidhuNavTabId =
  | "dashboard"
  | "orders"
  | "products"
  | "categories"
  | "customers"
  | "blog"
  | "coupons"
  | "builder"
  | "faqadmin"
  | "pages"
  | "redirects"
  | "staff"
  | "tax"
  | "settings";

export type AdminRoleName = "super_admin" | "manager" | "writer";

export type SidebarNavItemDef = {
  id: SidhuNavTabId;
  icon: string;
  label: string;
  /** Same role gate as the former flat sidebar list. */
  roles: readonly AdminRoleName[];
};

export type SidebarGroupDef = {
  id: string;
  /** null = single item, no group header (Dashboard). */
  label: string | null;
  icon: string;
  items: SidebarNavItemDef[];
};

/** Only tabs that exist today — no coming-soon items. */
export const SIDEBAR_GROUPS: SidebarGroupDef[] = [
  {
    id: "dashboard",
    label: null,
    icon: "📊",
    items: [
      {
        id: "dashboard",
        icon: "📊",
        label: "Dashboard",
        roles: ["super_admin", "manager", "writer"],
      },
    ],
  },
  {
    id: "sales",
    label: "Sales",
    icon: "🛒",
    items: [
      {
        id: "orders",
        icon: "🛒",
        label: "Orders",
        roles: ["super_admin", "manager"],
      },
      {
        id: "customers",
        icon: "👥",
        label: "Customers",
        roles: ["super_admin", "manager"],
      },
      {
        id: "coupons",
        icon: "🎟️",
        label: "Coupons",
        roles: ["super_admin"],
      },
    ],
  },
  {
    id: "catalog",
    label: "Catalog",
    icon: "📦",
    items: [
      {
        id: "products",
        icon: "📦",
        label: "Products",
        roles: ["super_admin", "manager"],
      },
      {
        id: "categories",
        icon: "🗂️",
        label: "Categories",
        roles: ["super_admin", "manager"],
      },
    ],
  },
  {
    id: "content",
    label: "Content",
    icon: "✍️",
    items: [
      {
        id: "pages",
        icon: "✏️",
        label: "Content Editor",
        roles: ["super_admin", "manager"],
      },
      {
        id: "builder",
        icon: "🎨",
        label: "Page Builder",
        roles: ["super_admin"],
      },
      {
        id: "blog",
        icon: "📝",
        label: "Blog",
        roles: ["super_admin", "manager", "writer"],
      },
      {
        id: "faqadmin",
        icon: "❓",
        label: "FAQs",
        roles: ["super_admin", "manager"],
      },
    ],
  },
  {
    id: "seo_marketing",
    label: "SEO & Marketing",
    icon: "🔀",
    items: [
      {
        id: "redirects",
        icon: "🔀",
        label: "Redirects",
        roles: ["super_admin", "manager"],
      },
    ],
  },
  {
    id: "settings_team",
    label: "Settings & Team",
    icon: "⚙️",
    items: [
      {
        id: "settings",
        icon: "⚙️",
        label: "Site Settings",
        roles: ["super_admin"],
      },
      {
        id: "staff",
        icon: "👤",
        label: "Staff Users",
        roles: ["super_admin"],
      },
      {
        id: "tax",
        icon: "🧾",
        label: "Tax",
        roles: ["super_admin"],
      },
    ],
  },
];

export const ALL_SIDEBAR_TAB_IDS: SidhuNavTabId[] = [
  "dashboard",
  "orders",
  "customers",
  "coupons",
  "products",
  "categories",
  "pages",
  "builder",
  "blog",
  "faqadmin",
  "redirects",
  "settings",
  "staff",
  "tax",
];

export const SIDEBAR_GROUP_STORAGE_KEY = "sandy-sidhu-sidebar-groups-v1";

export function tabToGroupId(tabId: string): string | null {
  for (const g of SIDEBAR_GROUPS) {
    for (const item of g.items) {
      if (item.id === tabId) return g.id;
    }
  }
  return null;
}

export function itemVisibleForRole(
  item: SidebarNavItemDef,
  adminRole: string
): boolean {
  return (item.roles as readonly string[]).includes(adminRole);
}

export function tabsForRole(adminRole: string): SidhuNavTabId[] {
  const out: SidhuNavTabId[] = [];
  for (const g of SIDEBAR_GROUPS) {
    for (const item of g.items) {
      if (itemVisibleForRole(item, adminRole)) out.push(item.id);
    }
  }
  return out;
}

export function sumBadgeNumbers(
  badges: Array<string | number | null | undefined>
): number {
  let sum = 0;
  for (const b of badges) {
    if (b == null || b === "") continue;
    const n = Number(b);
    if (Number.isFinite(n)) sum += n;
  }
  return sum;
}

export type SidebarOpenState = Record<string, boolean>;

export function defaultSidebarOpenState(activeTab: string): SidebarOpenState {
  const activeGroup = tabToGroupId(activeTab) || "dashboard";
  const out: SidebarOpenState = {};
  for (const g of SIDEBAR_GROUPS) {
    out[g.id] = g.id === activeGroup;
  }
  return out;
}

export function readSidebarOpenState(
  activeTab: string,
  storage: { getItem(key: string): string | null } | null = null
): SidebarOpenState {
  const defaults = defaultSidebarOpenState(activeTab);
  if (!storage) return defaults;
  try {
    const raw = storage.getItem(SIDEBAR_GROUP_STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as SidebarOpenState;
    if (!parsed || typeof parsed !== "object") return defaults;
    const merged: SidebarOpenState = { ...defaults };
    for (const g of SIDEBAR_GROUPS) {
      if (typeof parsed[g.id] === "boolean") merged[g.id] = parsed[g.id];
    }
    const activeGroup = tabToGroupId(activeTab);
    if (activeGroup) merged[activeGroup] = true;
    return merged;
  } catch {
    return defaults;
  }
}

export function writeSidebarOpenState(
  state: SidebarOpenState,
  storage: { setItem(key: string, value: string): void } | null = null
): void {
  if (!storage) return;
  try {
    storage.setItem(SIDEBAR_GROUP_STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* ignore quota / private mode */
  }
}
