"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { adminRequest } from "@/lib/adminRequest";
import { normaliseText } from "@/lib/shippingNormalise";
import { PK_CITIES } from "@/lib/pkLocations";
import AdminBanner from "./AdminBanner";

/**
 * Delivery operations (SANDY-BATCH-17, super_admin only; every API enforces settings:shipping).
 * Rendered by ShippingSettingsPanel. Holds: the three delivery-ops flag toggles (with confirm text),
 * the delivery-areas tree manager, riders CRUD and pickup-points CRUD. Everything is native, labelled
 * form controls (keyboard accessible) and reuses the existing admin CSS classes.
 */

export type DeliveryOpsFlags = { areas: boolean; restrict: boolean; pickup: boolean };

export type DeliveryOpsInfo = {
  schema?: boolean;
  activeZones?: number;
  listed_coverage?: boolean;
  active_pickup_points?: number;
};

export type ZoneLite = { id: number; name: string; active: boolean };

type Area = {
  id: number;
  city: string;
  name: string;
  parent_id: number | null;
  zone_id: number | null;
  active: boolean;
  sort_order: number;
};

type Rider = { id: number; name: string; phone: string; active: boolean; sort_order: number };

type Point = {
  id: number;
  name: string;
  city: string;
  address: string;
  hours_text: string;
  map_url: string;
  active: boolean;
  sort_order: number;
};

type AreaForm = {
  id: number | null;
  name: string;
  parent_id: string;
  zone_id: string;
  active: boolean;
  sort_order: string;
};

type RiderForm = { id: number | null; name: string; phone: string; active: boolean; sort_order: string };

type PointForm = {
  id: number | null;
  name: string;
  city: string;
  address: string;
  hours_text: string;
  map_url: string;
  active: boolean;
  sort_order: string;
};

const EMPTY_AREA: AreaForm = { id: null, name: "", parent_id: "", zone_id: "", active: true, sort_order: "0" };
const EMPTY_RIDER: RiderForm = { id: null, name: "", phone: "", active: true, sort_order: "0" };
const EMPTY_POINT: PointForm = {
  id: null,
  name: "",
  city: "",
  address: "",
  hours_text: "",
  map_url: "",
  active: true,
  sort_order: "0",
};

const inputStyle: React.CSSProperties = {
  padding: "8px 10px",
  border: "1px solid #E5E5E5",
  borderRadius: 8,
  fontSize: 13,
  background: "#fff",
  color: "#111",
};

const FLAG_CONFIRM: Record<keyof DeliveryOpsFlags, string> = {
  areas:
    "Turn on delivery areas?\n\nCustomers whose city has areas will have to pick one at checkout, and shipping zones will be matched by area first. Existing orders are not changed.",
  restrict:
    "Turn on restrict to zones?\n\nCustomers whose destination no active zone covers will NOT be able to place an order, and the default zone stops catching unmatched destinations.",
  pickup:
    "Turn on store pickup?\n\nCustomers will see a Pickup option at checkout. Pickup orders have no shipping charge and are never dispatched.",
};

const FLAG_KEY: Record<keyof DeliveryOpsFlags, string> = {
  areas: "shipping_areas_enabled",
  restrict: "shipping_restrict_to_zones",
  pickup: "pickup_enabled",
};

const SORT_RE = /^\d*$/;

/** Areas of one city flattened depth-first (parents first) with their depth. */
function flattenTree(areas: Area[]): Array<{ area: Area; depth: number }> {
  const ids = new Set(areas.map((a) => a.id));
  const byParent = new Map<number | null, Area[]>();
  for (const a of areas) {
    const key = a.parent_id !== null && ids.has(a.parent_id) ? a.parent_id : null;
    const list = byParent.get(key) ?? [];
    list.push(a);
    byParent.set(key, list);
  }
  const out: Array<{ area: Area; depth: number }> = [];
  const seen = new Set<number>();
  const walk = (parent: number | null, depth: number) => {
    for (const a of byParent.get(parent) ?? []) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      out.push({ area: a, depth });
      walk(a.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

function descendantIds(areas: Area[], rootId: number): Set<number> {
  const out = new Set<number>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const a of areas) {
      if (a.parent_id !== null && out.has(a.parent_id) && !out.has(a.id)) {
        out.add(a.id);
        grew = true;
      }
    }
  }
  return out;
}

export default function DeliveryOpsPanel({
  flags,
  info,
  zones,
  shippingEnabled,
  onSettingsChanged,
}: {
  flags: DeliveryOpsFlags;
  info: DeliveryOpsInfo | null;
  zones: ZoneLite[];
  shippingEnabled: boolean;
  /** Called after any change that can affect readiness / flags (parent reloads /api/admin-shipping-settings). */
  onSettingsChanged: () => void | Promise<void>;
}) {
  const [areas, setAreas] = useState<Area[]>([]);
  const [riders, setRiders] = useState<Rider[]>([]);
  const [points, setPoints] = useState<Point[]>([]);
  const [areasLoaded, setAreasLoaded] = useState(false);
  const [ridersLoaded, setRidersLoaded] = useState(false);
  const [pointsLoaded, setPointsLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [banner, setBanner] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const [areaCity, setAreaCity] = useState("");
  const [areaForm, setAreaForm] = useState<AreaForm>(EMPTY_AREA);
  const [bulkText, setBulkText] = useState("");
  const [bulkParent, setBulkParent] = useState("");
  const [riderForm, setRiderForm] = useState<RiderForm>(EMPTY_RIDER);
  const [pointForm, setPointForm] = useState<PointForm>(EMPTY_POINT);

  const schemaReady = info?.schema !== false;

  const loadAll = useCallback(async (): Promise<string> => {
    const [a, r, p] = await Promise.all([
      adminRequest<{ areas?: Area[] }>("/api/admin-shipping-areas"),
      adminRequest<{ riders?: Rider[] }>("/api/admin-riders"),
      adminRequest<{ pickup_points?: Point[] }>("/api/admin-pickup-points"),
    ]);
    if (a.ok) {
      setAreas(Array.isArray(a.data.areas) ? a.data.areas : []);
      setAreasLoaded(true);
    }
    if (r.ok) {
      setRiders(Array.isArray(r.data.riders) ? r.data.riders : []);
      setRidersLoaded(true);
    }
    if (p.ok) {
      setPoints(Array.isArray(p.data.pickup_points) ? p.data.pickup_points : []);
      setPointsLoaded(true);
    }
    // 503 = migration 0010 not applied yet: the readiness hint explains it, no scary error.
    const failed = [a, r, p].find((x) => !x.ok && x.status !== 503);
    if (failed) return failed.errorMessage || "Could not load delivery settings.";
    return "";
  }, []);

  const reload = useCallback(async () => {
    setLoadError(await loadAll());
  }, [loadAll]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const err = await loadAll();
      if (!cancelled) setLoadError(err);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadAll]);

  const reportError = (message: string) => {
    setNotice("");
    setBanner(message);
  };
  const clearMessages = () => {
    setBanner("");
    setNotice("");
  };

  // ---- Flags -------------------------------------------------------------------------------
  const flagBlockedReason = (key: keyof DeliveryOpsFlags): string => {
    if (!shippingEnabled) return "Turn on shipping first.";
    if (!schemaReady) return "Needs a one-time database update (migration 0010). Ask the owner to apply it.";
    if (key === "pickup" && (info?.active_pickup_points ?? 0) < 1) {
      return "Add at least one active pickup point first.";
    }
    if (key === "restrict" && !flags.areas && info?.listed_coverage !== true) {
      return "Turn on delivery areas, or list cities / provinces on at least one active zone, first.";
    }
    return "";
  };

  const toggleFlag = async (key: keyof DeliveryOpsFlags, next: boolean) => {
    clearMessages();
    if (next) {
      const blocked = flagBlockedReason(key);
      if (blocked) return reportError(blocked);
      if (!confirm(FLAG_CONFIRM[key])) return;
    }
    setBusy(true);
    const res = await adminRequest("/api/site-content", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: FLAG_KEY[key], value: next ? "1" : "0" }),
    });
    setBusy(false);
    if (!res.ok) return reportError(res.errorMessage || "Could not update the setting.");
    setNotice(next ? "Setting turned on." : "Setting turned off.");
    await onSettingsChanged();
  };

  // ---- Areas -------------------------------------------------------------------------------
  const cityChoices = useMemo(() => {
    const set = new Set<string>(areas.map((a) => a.city));
    for (const c of PK_CITIES) set.add(c.name);
    return Array.from(set).sort((x, y) => x.localeCompare(y));
  }, [areas]);

  const cityKey = normaliseText(areaCity);
  const cityAreas = useMemo(
    () => (cityKey ? areas.filter((a) => normaliseText(a.city) === cityKey) : []),
    [areas, cityKey]
  );
  const tree = useMemo(() => flattenTree(cityAreas), [cityAreas]);
  const blockedParents = useMemo(
    () => (areaForm.id !== null ? descendantIds(cityAreas, areaForm.id) : new Set<number>()),
    [cityAreas, areaForm.id]
  );
  const zoneName = (id: number | null) => (id === null ? "Inherit" : zones.find((z) => z.id === id)?.name ?? `#${id}`);

  const saveArea = async () => {
    clearMessages();
    const f = areaForm;
    if (!areaCity.trim()) return reportError("Choose a city first.");
    if (!f.name.trim()) return reportError("Area name is required.");
    if (!SORT_RE.test(f.sort_order.trim())) return reportError("Sort order must be a whole number.");
    const body: Record<string, unknown> = {
      name: f.name.trim(),
      parent_id: f.parent_id === "" ? null : Number(f.parent_id),
      zone_id: f.zone_id === "" ? null : Number(f.zone_id),
      active: f.active,
      sort_order: f.sort_order.trim() || "0",
    };
    if (f.id === null) body.city = areaCity.trim();
    else body.id = f.id;
    setBusy(true);
    const res = await adminRequest("/api/admin-shipping-areas", {
      method: f.id === null ? "POST" : "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!res.ok) return reportError(res.errorMessage || "Could not save area.");
    setNotice(f.id === null ? "Area added." : "Area updated.");
    setAreaForm(EMPTY_AREA);
    await reload();
  };

  const bulkAddAreas = async () => {
    clearMessages();
    if (!areaCity.trim()) return reportError("Choose a city first.");
    const names = bulkText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (names.length === 0) return reportError("Enter at least one area name (one per line).");
    setBusy(true);
    const res = await adminRequest<{ created?: number[]; skipped?: string[] }>("/api/admin-shipping-areas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "bulk",
        city: areaCity.trim(),
        parent_id: bulkParent === "" ? null : Number(bulkParent),
        names,
      }),
    });
    setBusy(false);
    if (!res.ok) return reportError(res.errorMessage || "Could not add areas.");
    const created = Array.isArray(res.data.created) ? res.data.created.length : 0;
    const skipped = Array.isArray(res.data.skipped) ? res.data.skipped.length : 0;
    setNotice(`${created} area${created === 1 ? "" : "s"} added${skipped ? `, ${skipped} skipped (duplicate or invalid)` : ""}.`);
    setBulkText("");
    await reload();
  };

  const patchAreaActive = async (a: Area, active: boolean) => {
    clearMessages();
    setBusy(true);
    const res = await adminRequest("/api/admin-shipping-areas", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: a.id, active }),
    });
    setBusy(false);
    if (!res.ok) return reportError(res.errorMessage || "Could not update area.");
    setNotice(active ? "Area activated." : "Area deactivated.");
    await reload();
  };

  const deleteArea = async (a: Area) => {
    if (!confirm(`Delete area "${a.name}"? An area used by existing orders is only deactivated.`)) return;
    clearMessages();
    setBusy(true);
    const res = await adminRequest<{ deactivated?: boolean }>("/api/admin-shipping-areas", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: a.id }),
    });
    setBusy(false);
    if (!res.ok) return reportError(res.errorMessage || "Could not delete area.");
    setNotice(res.data.deactivated ? "Area is used by orders, so it was deactivated instead." : "Area deleted.");
    if (areaForm.id === a.id) setAreaForm(EMPTY_AREA);
    await reload();
  };

  const editArea = (a: Area) => {
    clearMessages();
    setAreaCity(a.city);
    setAreaForm({
      id: a.id,
      name: a.name,
      parent_id: a.parent_id === null ? "" : String(a.parent_id),
      zone_id: a.zone_id === null ? "" : String(a.zone_id),
      active: a.active,
      sort_order: String(a.sort_order),
    });
  };

  // ---- Riders ------------------------------------------------------------------------------
  const saveRider = async () => {
    clearMessages();
    const f = riderForm;
    if (!f.name.trim()) return reportError("Rider name is required.");
    if (!f.phone.trim()) return reportError("Rider phone is required.");
    if (!SORT_RE.test(f.sort_order.trim())) return reportError("Sort order must be a whole number.");
    const body: Record<string, unknown> = {
      name: f.name.trim(),
      phone: f.phone.trim(),
      active: f.active,
      sort_order: f.sort_order.trim() || "0",
    };
    if (f.id !== null) body.id = f.id;
    setBusy(true);
    const res = await adminRequest("/api/admin-riders", {
      method: f.id === null ? "POST" : "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!res.ok) return reportError(res.errorMessage || "Could not save rider.");
    setNotice(f.id === null ? "Rider added." : "Rider updated.");
    setRiderForm(EMPTY_RIDER);
    await reload();
  };

  const patchRiderActive = async (r: Rider, active: boolean) => {
    clearMessages();
    setBusy(true);
    const res = await adminRequest("/api/admin-riders", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: r.id, active }),
    });
    setBusy(false);
    if (!res.ok) return reportError(res.errorMessage || "Could not update rider.");
    setNotice(active ? "Rider activated." : "Rider deactivated.");
    await reload();
  };

  const deleteRider = async (r: Rider) => {
    if (!confirm(`Delete rider "${r.name}"? A rider used by existing orders is only deactivated.`)) return;
    clearMessages();
    setBusy(true);
    const res = await adminRequest<{ deactivated?: boolean }>("/api/admin-riders", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: r.id }),
    });
    setBusy(false);
    if (!res.ok) return reportError(res.errorMessage || "Could not delete rider.");
    setNotice(res.data.deactivated ? "Rider is used by orders, so it was deactivated instead." : "Rider deleted.");
    if (riderForm.id === r.id) setRiderForm(EMPTY_RIDER);
    await reload();
  };

  // ---- Pickup points -----------------------------------------------------------------------
  const savePoint = async () => {
    clearMessages();
    const f = pointForm;
    if (!f.name.trim()) return reportError("Pickup point name is required.");
    if (!f.city.trim()) return reportError("City is required.");
    if (!f.address.trim()) return reportError("Address is required.");
    if (f.map_url.trim() && !/^https:\/\//i.test(f.map_url.trim())) {
      return reportError("Map link must start with https://");
    }
    if (!SORT_RE.test(f.sort_order.trim())) return reportError("Sort order must be a whole number.");
    const body: Record<string, unknown> = {
      name: f.name.trim(),
      city: f.city.trim(),
      address: f.address.trim(),
      hours_text: f.hours_text.trim(),
      map_url: f.map_url.trim(),
      active: f.active,
      sort_order: f.sort_order.trim() || "0",
    };
    if (f.id !== null) body.id = f.id;
    setBusy(true);
    const res = await adminRequest("/api/admin-pickup-points", {
      method: f.id === null ? "POST" : "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!res.ok) return reportError(res.errorMessage || "Could not save pickup point.");
    setNotice(f.id === null ? "Pickup point added." : "Pickup point updated.");
    setPointForm(EMPTY_POINT);
    await reload();
    await onSettingsChanged();
  };

  const patchPointActive = async (p: Point, active: boolean) => {
    clearMessages();
    setBusy(true);
    const res = await adminRequest("/api/admin-pickup-points", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: p.id, active }),
    });
    setBusy(false);
    if (!res.ok) return reportError(res.errorMessage || "Could not update pickup point.");
    setNotice(active ? "Pickup point activated." : "Pickup point deactivated.");
    await reload();
    await onSettingsChanged();
  };

  const deletePoint = async (p: Point) => {
    if (!confirm(`Delete pickup point "${p.name}"? A point used by existing orders is only deactivated.`)) return;
    clearMessages();
    setBusy(true);
    const res = await adminRequest<{ deactivated?: boolean }>("/api/admin-pickup-points", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: p.id }),
    });
    setBusy(false);
    if (!res.ok) return reportError(res.errorMessage || "Could not delete pickup point.");
    setNotice(res.data.deactivated ? "Pickup point is used by orders, so it was deactivated instead." : "Pickup point deleted.");
    if (pointForm.id === p.id) setPointForm(EMPTY_POINT);
    await reload();
    await onSettingsChanged();
  };

  const setA = <K extends keyof AreaForm>(k: K, v: AreaForm[K]) => setAreaForm((f) => ({ ...f, [k]: v }));
  const setR = <K extends keyof RiderForm>(k: K, v: RiderForm[K]) => setRiderForm((f) => ({ ...f, [k]: v }));
  const setP = <K extends keyof PointForm>(k: K, v: PointForm[K]) => setPointForm((f) => ({ ...f, [k]: v }));

  const flagRows: Array<{ key: keyof DeliveryOpsFlags; label: string; hint: string }> = [
    { key: "areas", label: "Delivery areas", hint: "Customers pick an area inside their city; areas can pin a shipping zone." },
    { key: "restrict", label: "Restrict to zones", hint: "Refuse orders to destinations no active zone covers." },
    { key: "pickup", label: "Store pickup", hint: "Offer Pickup at checkout (no shipping charge, never dispatched)." },
  ];

  return (
    <div data-delivery-ops-panel="1" style={{ marginTop: 26, borderTop: "1px solid #E5E5E5", paddingTop: 18 }}>
      <h4 style={{ fontSize: 14, margin: "0 0 8px" }}>Delivery operations</h4>
      {loadError && <AdminBanner message={loadError} tone="error" onRetry={() => { void reload(); }} />}
      {banner && <AdminBanner message={banner} tone="error" />}
      {notice && <AdminBanner message={notice} tone="success" />}

      <p style={{ fontSize: 12, color: "#888", marginBottom: 12, lineHeight: 1.6 }}>
        All three settings are off by default. While they are off, checkout looks and behaves exactly as before.
      </p>

      {/* Flag toggles */}
      <div style={{ marginBottom: 20 }} data-delivery-flags="1">
        {flagRows.map((row) => {
          const on = flags[row.key];
          const blocked = !on ? flagBlockedReason(row.key) : "";
          return (
            <div key={row.key} style={{ marginBottom: 10 }}>
              <label style={{ fontSize: 13, display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  type="checkbox"
                  data-delivery-flag={row.key}
                  checked={on}
                  disabled={busy || (!on && blocked !== "")}
                  onChange={(e) => { void toggleFlag(row.key, e.target.checked); }}
                />
                {row.label}
              </label>
              <div style={{ fontSize: 11, color: "#888", marginLeft: 24 }}>{row.hint}</div>
              {blocked ? (
                <div data-delivery-flag-hint={row.key} style={{ fontSize: 12, color: "#B45309", marginLeft: 24, marginTop: 2 }}>
                  {blocked}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {/* Areas */}
      <h4 style={{ fontSize: 13, margin: "0 0 8px" }}>Delivery areas</h4>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginBottom: 10, alignItems: "flex-end" }}>
        <label style={{ fontSize: 12 }}>City<br />
          <input
            style={{ ...inputStyle, width: 220 }}
            list="delivery-ops-city-list"
            data-area-city="1"
            maxLength={100}
            placeholder="Search a city, e.g. Lahore"
            value={areaCity}
            onChange={(e) => { setAreaCity(e.target.value); setAreaForm(EMPTY_AREA); setBulkParent(""); }}
          />
          <datalist id="delivery-ops-city-list">
            {cityChoices.map((c) => (<option key={c} value={c} />))}
          </datalist>
        </label>
      </div>

      <div className="table-wrap" style={{ marginBottom: 14 }}>
        <table data-delivery-areas="1">
          <thead>
            <tr><th>Area</th><th>Zone</th><th>Active</th><th>Sort</th><th /></tr>
          </thead>
          <tbody>
            {!cityKey && (
              <tr><td colSpan={5} style={{ textAlign: "center", color: "#888", padding: 20 }}>
                Choose a city to manage its areas.
              </td></tr>
            )}
            {cityKey && areasLoaded && tree.length === 0 && (
              <tr><td colSpan={5} style={{ textAlign: "center", color: "#888", padding: 20 }}>
                No areas for this city yet.
              </td></tr>
            )}
            {tree.map(({ area, depth }) => (
              <tr key={area.id} data-area-row={area.id}>
                <td style={{ fontWeight: depth === 0 ? 600 : 400, paddingLeft: 12 + depth * 18 }}>
                  {depth > 0 ? "– " : ""}{area.name}
                </td>
                <td style={{ fontSize: 12 }}>{zoneName(area.zone_id)}</td>
                <td>
                  <input type="checkbox" aria-label={`Active: ${area.name}`} checked={area.active} disabled={busy}
                    onChange={(e) => { void patchAreaActive(area, e.target.checked); }} />
                </td>
                <td>{area.sort_order}</td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <button className="action-btn btn-edit" disabled={busy} onClick={() => editArea(area)}>Edit</button>{" "}
                  <button className="action-btn btn-delete" disabled={busy} onClick={() => { void deleteArea(area); }}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ border: "1px solid #E5E5E5", borderRadius: 10, padding: 14, marginBottom: 14 }} data-area-form="1">
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>
          {areaForm.id === null ? "Add area" : `Edit area #${areaForm.id}`}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginBottom: 12 }}>
          <label style={{ fontSize: 12 }}>Name<br />
            <input style={{ ...inputStyle, width: 200 }} maxLength={120} value={areaForm.name}
              onChange={(e) => setA("name", e.target.value)} />
          </label>
          <label style={{ fontSize: 12 }}>Parent area<br />
            <select style={{ ...inputStyle, width: 200 }} value={areaForm.parent_id}
              onChange={(e) => setA("parent_id", e.target.value)}>
              <option value="">None (top level)</option>
              {tree.filter(({ area }) => !blockedParents.has(area.id)).map(({ area, depth }) => (
                <option key={area.id} value={area.id}>{`${"\u00A0\u00A0".repeat(depth)}${area.name}`}</option>
              ))}
            </select>
          </label>
          <label style={{ fontSize: 12 }}>Shipping zone<br />
            <select style={{ ...inputStyle, width: 200 }} value={areaForm.zone_id}
              onChange={(e) => setA("zone_id", e.target.value)}>
              <option value="">Inherit from parent / city</option>
              {zones.map((z) => (
                <option key={z.id} value={z.id}>{z.name}{z.active ? "" : " (inactive)"}</option>
              ))}
            </select>
          </label>
          <label style={{ fontSize: 12 }}>Sort order<br />
            <input style={{ ...inputStyle, width: 80 }} inputMode="numeric" value={areaForm.sort_order}
              onChange={(e) => setA("sort_order", e.target.value)} />
          </label>
          <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center", alignSelf: "flex-end" }}>
            <input type="checkbox" checked={areaForm.active} onChange={(e) => setA("active", e.target.checked)} />
            Active
          </label>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="add-btn" disabled={busy || !cityKey} onClick={() => { void saveArea(); }}>
            {busy ? "Saving…" : areaForm.id === null ? "Add area" : "Save area"}
          </button>
          {areaForm.id !== null && (
            <button className="modal-cancel" disabled={busy} onClick={() => setAreaForm(EMPTY_AREA)}>Cancel edit</button>
          )}
        </div>
      </div>

      <div style={{ border: "1px solid #E5E5E5", borderRadius: 10, padding: 14, marginBottom: 24 }} data-area-bulk="1">
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>Bulk add areas</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginBottom: 12 }}>
          <label style={{ fontSize: 12 }}>Parent area<br />
            <select style={{ ...inputStyle, width: 220 }} value={bulkParent}
              onChange={(e) => setBulkParent(e.target.value)}>
              <option value="">None (top level)</option>
              {tree.map(({ area, depth }) => (
                <option key={area.id} value={area.id}>{`${"\u00A0\u00A0".repeat(depth)}${area.name}`}</option>
              ))}
            </select>
          </label>
          <label style={{ fontSize: 12 }}>Names (one per line)<br />
            <textarea style={{ ...inputStyle, width: 280, height: 90 }} value={bulkText}
              onChange={(e) => setBulkText(e.target.value)} />
          </label>
        </div>
        <div style={{ fontSize: 11, color: "#888", marginBottom: 10 }}>
          Blank lines are ignored. Names that already exist under the same parent are skipped.
        </div>
        <button className="add-btn" disabled={busy || !cityKey} onClick={() => { void bulkAddAreas(); }}>
          {busy ? "Adding…" : "Add areas"}
        </button>
      </div>

      {/* Riders */}
      <h4 style={{ fontSize: 13, margin: "0 0 8px" }}>Riders (own delivery)</h4>
      <div className="table-wrap" style={{ marginBottom: 14 }}>
        <table data-delivery-riders="1">
          <thead>
            <tr><th>Rider</th><th>Phone</th><th>Active</th><th>Sort</th><th /></tr>
          </thead>
          <tbody>
            {ridersLoaded && riders.length === 0 && (
              <tr><td colSpan={5} style={{ textAlign: "center", color: "#888", padding: 20 }}>No riders yet.</td></tr>
            )}
            {riders.map((r) => (
              <tr key={r.id} data-rider-row={r.id}>
                <td style={{ fontWeight: 600 }}>{r.name}</td>
                <td style={{ fontSize: 12 }}>{r.phone}</td>
                <td>
                  <input type="checkbox" aria-label={`Active: ${r.name}`} checked={r.active} disabled={busy}
                    onChange={(e) => { void patchRiderActive(r, e.target.checked); }} />
                </td>
                <td>{r.sort_order}</td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <button className="action-btn btn-edit" disabled={busy}
                    onClick={() => { clearMessages(); setRiderForm({ id: r.id, name: r.name, phone: r.phone, active: r.active, sort_order: String(r.sort_order) }); }}>Edit</button>{" "}
                  <button className="action-btn btn-delete" disabled={busy} onClick={() => { void deleteRider(r); }}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ border: "1px solid #E5E5E5", borderRadius: 10, padding: 14, marginBottom: 24 }} data-rider-form="1">
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>
          {riderForm.id === null ? "Add rider" : `Edit rider #${riderForm.id}`}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginBottom: 12 }}>
          <label style={{ fontSize: 12 }}>Name<br />
            <input style={{ ...inputStyle, width: 180 }} maxLength={100} value={riderForm.name}
              onChange={(e) => setR("name", e.target.value)} />
          </label>
          <label style={{ fontSize: 12 }}>Mobile (03XXXXXXXXX)<br />
            <input style={{ ...inputStyle, width: 180 }} inputMode="tel" maxLength={20} placeholder="03001234567"
              value={riderForm.phone} onChange={(e) => setR("phone", e.target.value)} />
          </label>
          <label style={{ fontSize: 12 }}>Sort order<br />
            <input style={{ ...inputStyle, width: 80 }} inputMode="numeric" value={riderForm.sort_order}
              onChange={(e) => setR("sort_order", e.target.value)} />
          </label>
          <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center", alignSelf: "flex-end" }}>
            <input type="checkbox" checked={riderForm.active} onChange={(e) => setR("active", e.target.checked)} />
            Active
          </label>
        </div>
        <div style={{ fontSize: 11, color: "#888", marginBottom: 10 }}>
          Customers only ever see the rider&apos;s first name, never the phone number.
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="add-btn" disabled={busy} onClick={() => { void saveRider(); }}>
            {busy ? "Saving…" : riderForm.id === null ? "Add rider" : "Save rider"}
          </button>
          {riderForm.id !== null && (
            <button className="modal-cancel" disabled={busy} onClick={() => setRiderForm(EMPTY_RIDER)}>Cancel edit</button>
          )}
        </div>
      </div>

      {/* Pickup points */}
      <h4 style={{ fontSize: 13, margin: "0 0 8px" }}>Pickup points</h4>
      <div className="table-wrap" style={{ marginBottom: 14 }}>
        <table data-delivery-pickup-points="1">
          <thead>
            <tr><th>Name</th><th>City</th><th>Address</th><th>Hours</th><th>Active</th><th>Sort</th><th /></tr>
          </thead>
          <tbody>
            {pointsLoaded && points.length === 0 && (
              <tr><td colSpan={7} style={{ textAlign: "center", color: "#888", padding: 20 }}>No pickup points yet.</td></tr>
            )}
            {points.map((p) => (
              <tr key={p.id} data-pickup-row={p.id}>
                <td style={{ fontWeight: 600 }}>{p.name}</td>
                <td style={{ fontSize: 12 }}>{p.city}</td>
                <td style={{ fontSize: 12 }}>{p.address}</td>
                <td style={{ fontSize: 12 }}>{p.hours_text || "—"}</td>
                <td>
                  <input type="checkbox" aria-label={`Active: ${p.name}`} checked={p.active} disabled={busy}
                    onChange={(e) => { void patchPointActive(p, e.target.checked); }} />
                </td>
                <td>{p.sort_order}</td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <button className="action-btn btn-edit" disabled={busy}
                    onClick={() => { clearMessages(); setPointForm({ id: p.id, name: p.name, city: p.city, address: p.address, hours_text: p.hours_text, map_url: p.map_url, active: p.active, sort_order: String(p.sort_order) }); }}>Edit</button>{" "}
                  <button className="action-btn btn-delete" disabled={busy} onClick={() => { void deletePoint(p); }}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ border: "1px solid #E5E5E5", borderRadius: 10, padding: 14 }} data-pickup-form="1">
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>
          {pointForm.id === null ? "Add pickup point" : `Edit pickup point #${pointForm.id}`}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginBottom: 12 }}>
          <label style={{ fontSize: 12 }}>Name<br />
            <input style={{ ...inputStyle, width: 180 }} maxLength={120} value={pointForm.name}
              onChange={(e) => setP("name", e.target.value)} />
          </label>
          <label style={{ fontSize: 12 }}>City<br />
            <input style={{ ...inputStyle, width: 140 }} maxLength={100} value={pointForm.city}
              onChange={(e) => setP("city", e.target.value)} />
          </label>
          <label style={{ fontSize: 12 }}>Address<br />
            <input style={{ ...inputStyle, width: 280 }} maxLength={300} value={pointForm.address}
              onChange={(e) => setP("address", e.target.value)} />
          </label>
          <label style={{ fontSize: 12 }}>Opening hours<br />
            <input style={{ ...inputStyle, width: 200 }} maxLength={120} placeholder="e.g. Mon-Sat 10am-7pm"
              value={pointForm.hours_text} onChange={(e) => setP("hours_text", e.target.value)} />
          </label>
          <label style={{ fontSize: 12 }}>Map link (https, optional)<br />
            <input style={{ ...inputStyle, width: 280 }} maxLength={500} placeholder="https://maps.google.com/…"
              value={pointForm.map_url} onChange={(e) => setP("map_url", e.target.value)} />
          </label>
          <label style={{ fontSize: 12 }}>Sort order<br />
            <input style={{ ...inputStyle, width: 80 }} inputMode="numeric" value={pointForm.sort_order}
              onChange={(e) => setP("sort_order", e.target.value)} />
          </label>
          <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center", alignSelf: "flex-end" }}>
            <input type="checkbox" checked={pointForm.active} onChange={(e) => setP("active", e.target.checked)} />
            Active
          </label>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="add-btn" disabled={busy} onClick={() => { void savePoint(); }}>
            {busy ? "Saving…" : pointForm.id === null ? "Add pickup point" : "Save pickup point"}
          </button>
          {pointForm.id !== null && (
            <button className="modal-cancel" disabled={busy} onClick={() => setPointForm(EMPTY_POINT)}>Cancel edit</button>
          )}
        </div>
      </div>
    </div>
  );
}
