"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { adminRequest } from "@/lib/adminRequest";
import { normaliseCity } from "@/lib/shippingNormalise";
import { PK_CITIES, PK_PROVINCES } from "@/lib/pkLocations";
import AdminBanner from "./AdminBanner";
import DeliveryOpsPanel, { type DeliveryOpsInfo } from "./DeliveryOpsPanel";
import LocationMultiSelect, {
  joinLocationList,
  splitLocationList,
  type LocationOption,
} from "./LocationMultiSelect";

/**
 * Shipping settings (SANDY-BATCH-12, super_admin only — the parent gates rendering and every API
 * enforces settings:shipping). Self-contained: loads the flag + readiness from
 * GET /api/admin-shipping-settings, toggles the flag through POST /api/site-content, and manages
 * zones (/api/admin-shipping-zones) and couriers (/api/admin-couriers).
 */

type Readiness = {
  tables?: boolean;
  orderColumns?: boolean;
  requiresShippingColumn?: boolean;
  activeDefaultZones?: number;
  ready?: boolean;
};

type SettingsResponse = {
  shipping_enabled?: boolean;
  shipping_areas_enabled?: boolean;
  shipping_restrict_to_zones?: boolean;
  pickup_enabled?: boolean;
  settings?: {
    shipping_enabled?: boolean;
    shipping_areas_enabled?: boolean;
    shipping_restrict_to_zones?: boolean;
    pickup_enabled?: boolean;
  };
  readiness?: Readiness;
  /** SANDY-BATCH-17 readiness for the delivery-ops flags. */
  delivery_ops?: DeliveryOpsInfo;
};

type Zone = {
  id: number;
  name: string;
  cities: string;
  provinces: string;
  is_default: boolean;
  rate: number;
  free_min: number | null;
  estimate_text: string;
  active: boolean;
  sort_order: number;
  /** Present only once migration 0010 is applied. */
  delivery_method?: "courier" | "own_rider";
  same_day_cutoff?: string | null;
};

type Courier = {
  id: number;
  name: string;
  tracking_url_template: string;
  active: boolean;
  sort_order: number;
};

type ZoneForm = {
  id: number | null;
  name: string;
  cities: string;
  provinces: string;
  is_default: boolean;
  rate: string;
  free_min: string;
  estimate_text: string;
  active: boolean;
  sort_order: string;
  delivery_method: "courier" | "own_rider";
  /** HH:MM (empty = none). */
  same_day_cutoff: string;
};

type CourierForm = {
  id: number | null;
  name: string;
  tracking_url_template: string;
  active: boolean;
  sort_order: string;
};

const EMPTY_ZONE: ZoneForm = {
  id: null,
  name: "",
  cities: "",
  provinces: "",
  is_default: false,
  rate: "0",
  free_min: "",
  estimate_text: "",
  active: true,
  sort_order: "0",
  delivery_method: "courier",
  same_day_cutoff: "",
};

const EMPTY_COURIER: CourierForm = {
  id: null,
  name: "",
  tracking_url_template: "",
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

const MONEY_RE = /^\d+(\.\d{1,2})?$/;

/** One entry per line (the API also accepts commas / semicolons, but the UI is one-per-line). */
function listPreview(raw: string): string {
  const parts = String(raw || "").split(/[\r\n]+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return "—";
  const shown = parts.slice(0, 3).join(", ");
  return parts.length > 3 ? `${shown} +${parts.length - 3} more` : shown;
}

export default function ShippingSettingsPanel({
  onFlagChange,
}: {
  /** Called after the flag is saved so the parent (e.g. the product form) can follow it. */
  onFlagChange?: (enabled: boolean) => void;
}) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [zones, setZones] = useState<Zone[]>([]);
  const [couriers, setCouriers] = useState<Courier[]>([]);
  const [zonesLoaded, setZonesLoaded] = useState(false);
  const [couriersLoaded, setCouriersLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [banner, setBanner] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [zoneForm, setZoneForm] = useState<ZoneForm>(EMPTY_ZONE);
  const [courierForm, setCourierForm] = useState<CourierForm>(EMPTY_COURIER);
  const [opsFlags, setOpsFlags] = useState({ areas: false, restrict: false, pickup: false });
  const [opsInfo, setOpsInfo] = useState<DeliveryOpsInfo | null>(null);

  const loadAll = useCallback(async (): Promise<string> => {
    const [s, z, c] = await Promise.all([
      adminRequest<SettingsResponse>("/api/admin-shipping-settings"),
      adminRequest<{ zones?: Zone[] }>("/api/admin-shipping-zones"),
      adminRequest<{ couriers?: Courier[] }>("/api/admin-couriers"),
    ]);
    if (s.ok) {
      setEnabled(s.data.shipping_enabled === true || s.data.settings?.shipping_enabled === true);
      setReadiness(s.data.readiness ?? null);
      setOpsFlags({
        areas: s.data.shipping_areas_enabled === true || s.data.settings?.shipping_areas_enabled === true,
        restrict:
          s.data.shipping_restrict_to_zones === true || s.data.settings?.shipping_restrict_to_zones === true,
        pickup: s.data.pickup_enabled === true || s.data.settings?.pickup_enabled === true,
      });
      setOpsInfo(s.data.delivery_ops ?? null);
    }
    if (z.ok) {
      setZones(Array.isArray(z.data.zones) ? z.data.zones : []);
      setZonesLoaded(true);
    }
    if (c.ok) {
      setCouriers(Array.isArray(c.data.couriers) ? c.data.couriers : []);
      setCouriersLoaded(true);
    }
    if (!s.ok) return s.errorMessage || "Could not load shipping settings.";
    if (!z.ok) return z.errorMessage || "Could not load shipping zones.";
    if (!c.ok) return c.errorMessage || "Could not load couriers.";
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

  // One active default zone, OR restrict-to-zones is on with at least one active zone (BATCH-17).
  const defaultZoneReady =
    (readiness?.activeDefaultZones ?? 0) === 1 || (opsFlags.restrict && (opsInfo?.activeZones ?? 0) >= 1);
  const schemaReady = readiness
    ? readiness.tables !== false && readiness.orderColumns !== false && readiness.requiresShippingColumn !== false
    : true;
  const canEnable = defaultZoneReady && schemaReady;
  // Delivery-method / cut-off fields exist only once migration 0010 is applied.
  const zoneOpsFields = opsInfo?.schema === true;

  const reportError = (message: string) => {
    setNotice("");
    setBanner(message);
  };

  const toggleFlag = async (next: boolean) => {
    setBanner("");
    setNotice("");
    if (next && !canEnable) {
      reportError(
        schemaReady
          ? "Add exactly one active default zone before enabling shipping."
          : "Shipping needs a one-time database update (migration 0009). Ask the owner to apply it."
      );
      return;
    }
    setBusy(true);
    const res = await adminRequest("/api/site-content", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "shipping_enabled", value: next ? "1" : "0" }),
    });
    setBusy(false);
    if (!res.ok) {
      reportError(res.errorMessage || "Could not update shipping.");
      return;
    }
    setEnabled(next);
    onFlagChange?.(next);
    setNotice(next ? "Shipping enabled." : "Shipping disabled.");
    await reload();
  };

  // ---- Zones -------------------------------------------------------------------------------
  const saveZone = async () => {
    setBanner("");
    setNotice("");
    const f = zoneForm;
    if (!f.name.trim()) return reportError("Zone name is required.");
    if (!MONEY_RE.test(f.rate.trim())) return reportError("Rate must be a number of 0 or greater (max 2 decimals).");
    if (f.free_min.trim() && !MONEY_RE.test(f.free_min.trim())) {
      return reportError("Free-shipping minimum must be empty or a number of 0 or greater.");
    }
    if (!/^\d*$/.test(f.sort_order.trim())) return reportError("Sort order must be a whole number.");

    const body: Record<string, unknown> = {
      name: f.name.trim(),
      cities: f.cities,
      provinces: f.provinces,
      is_default: f.is_default,
      rate: f.rate.trim(),
      free_min: f.free_min.trim(),
      estimate_text: f.estimate_text.trim(),
      active: f.active,
      sort_order: f.sort_order.trim() || "0",
    };
    if (zoneOpsFields) {
      if (f.same_day_cutoff.trim() && !/^([01]\d|2[0-3]):[0-5]\d$/.test(f.same_day_cutoff.trim())) {
        return reportError("Same-day cut-off must be a time like 14:00.");
      }
      body.delivery_method = f.delivery_method;
      body.same_day_cutoff = f.same_day_cutoff.trim();
    }
    if (f.id !== null) body.id = f.id;

    setBusy(true);
    const res = await adminRequest("/api/admin-shipping-zones", {
      method: f.id === null ? "POST" : "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!res.ok) return reportError(res.errorMessage || "Could not save zone.");
    setNotice(f.id === null ? "Zone added." : "Zone updated.");
    setZoneForm(EMPTY_ZONE);
    await reload();
  };

  const patchZoneActive = async (z: Zone, active: boolean) => {
    setBanner("");
    setNotice("");
    setBusy(true);
    const res = await adminRequest("/api/admin-shipping-zones", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: z.id, active }),
    });
    setBusy(false);
    if (!res.ok) return reportError(res.errorMessage || "Could not update zone.");
    setNotice(active ? "Zone activated." : "Zone deactivated.");
    await reload();
  };

  const deleteZone = async (z: Zone) => {
    if (!confirm(`Delete zone "${z.name}"? A zone used by existing orders is only deactivated.`)) return;
    setBanner("");
    setNotice("");
    setBusy(true);
    const res = await adminRequest<{ deactivated?: boolean }>("/api/admin-shipping-zones", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: z.id }),
    });
    setBusy(false);
    if (!res.ok) return reportError(res.errorMessage || "Could not delete zone.");
    setNotice(res.data.deactivated ? "Zone is used by orders, so it was deactivated instead." : "Zone deleted.");
    if (zoneForm.id === z.id) setZoneForm(EMPTY_ZONE);
    await reload();
  };

  const editZone = (z: Zone) => {
    setBanner("");
    setNotice("");
    setZoneForm({
      id: z.id,
      name: z.name,
      cities: z.cities,
      provinces: z.provinces,
      is_default: z.is_default,
      rate: String(z.rate),
      free_min: z.free_min === null ? "" : String(z.free_min),
      estimate_text: z.estimate_text,
      active: z.active,
      sort_order: String(z.sort_order),
      delivery_method: z.delivery_method === "own_rider" ? "own_rider" : "courier",
      same_day_cutoff: z.same_day_cutoff ? String(z.same_day_cutoff).slice(0, 5) : "",
    });
  };

  // ---- Couriers  ----------------------------------------------------------------------------
  const saveCourier = async () => {
    setBanner("");
    setNotice("");
    const f = courierForm;
    if (!f.name.trim()) return reportError("Courier name is required.");
    const tpl = f.tracking_url_template.trim();
    if (tpl && !tpl.includes("{tracking}")) return reportError("Tracking link must contain {tracking}.");
    if (!/^\d*$/.test(f.sort_order.trim())) return reportError("Sort order must be a whole number.");

    const body: Record<string, unknown> = {
      name: f.name.trim(),
      tracking_url_template: tpl,
      active: f.active,
      sort_order: f.sort_order.trim() || "0",
    };
    if (f.id !== null) body.id = f.id;

    setBusy(true);
    const res = await adminRequest("/api/admin-couriers", {
      method: f.id === null ? "POST" : "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!res.ok) return reportError(res.errorMessage || "Could not save courier.");
    setNotice(f.id === null ? "Courier added." : "Courier updated.");
    setCourierForm(EMPTY_COURIER);
    await reload();
  };

  const patchCourierActive = async (c: Courier, active: boolean) => {
    setBanner("");
    setNotice("");
    setBusy(true);
    const res = await adminRequest("/api/admin-couriers", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: c.id, active }),
    });
    setBusy(false);
    if (!res.ok) return reportError(res.errorMessage || "Could not update courier.");
    setNotice(active ? "Courier activated." : "Courier deactivated.");
    await reload();
  };

  const deleteCourier = async (c: Courier) => {
    if (!confirm(`Delete courier "${c.name}"? A courier used by existing orders is only deactivated.`)) return;
    setBanner("");
    setNotice("");
    setBusy(true);
    const res = await adminRequest<{ deactivated?: boolean }>("/api/admin-couriers", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: c.id }),
    });
    setBusy(false);
    if (!res.ok) return reportError(res.errorMessage || "Could not delete courier.");
    setNotice(res.data.deactivated ? "Courier is used by orders, so it was deactivated instead." : "Courier deleted.");
    if (courierForm.id === c.id) setCourierForm(EMPTY_COURIER);
    await reload();
  };

  const editCourier = (c: Courier) => {
    setBanner("");
    setNotice("");
    setCourierForm({
      id: c.id,
      name: c.name,
      tracking_url_template: c.tracking_url_template,
      active: c.active,
      sort_order: String(c.sort_order),
    });
  };

  const setZ = <K extends keyof ZoneForm>(k: K, v: ZoneForm[K]) => setZoneForm((f) => ({ ...f, [k]: v }));
  const setC = <K extends keyof CourierForm>(k: K, v: CourierForm[K]) => setCourierForm((f) => ({ ...f, [k]: v }));

  const cityOptions: LocationOption[] = useMemo(
    () => PK_CITIES.map((c) => ({ value: c.name, label: c.name, group: c.province })),
    []
  );
  const provinceOptions: LocationOption[] = useMemo(
    () => PK_PROVINCES.map((p) => ({ value: p, label: p })),
    []
  );

  /** Cities/provinces claimed by OTHER active zones (hidden in this form's controls). */
  const { blockedCityKeys, blockedProvinceKeys } = useMemo(() => {
    const cities = new Set<string>();
    const provinces = new Set<string>();
    const editingId = zoneForm.id;
    for (const z of zones) {
      if (!z.active) continue;
      if (editingId !== null && z.id === editingId) continue;
      for (const c of splitLocationList(z.cities)) {
        const k = normaliseCity(c);
        if (k) cities.add(k);
      }
      for (const p of splitLocationList(z.provinces)) {
        const k = normaliseCity(p);
        if (k) provinces.add(k);
      }
    }
    return { blockedCityKeys: cities, blockedProvinceKeys: provinces };
  }, [zones, zoneForm.id]);

  const selectedCities = useMemo(() => splitLocationList(zoneForm.cities), [zoneForm.cities]);
  const selectedProvinces = useMemo(() => splitLocationList(zoneForm.provinces), [zoneForm.provinces]);

  const toggleDisabled = busy || enabled === null || (enabled === false && !canEnable);

  return (
    <div className="section-card" style={{ marginBottom: 20 }} data-shipping-panel="1">
      <div className="section-header"><h3>Shipping</h3></div>
      <div style={{ padding: "16px 20px" }}>
        {loadError && <AdminBanner message={loadError} tone="error" onRetry={() => { void reload(); }} />}
        {banner && <AdminBanner message={banner} tone="error" />}
        {notice && <AdminBanner message={notice} tone="success" />}

        <p style={{ fontSize: 12, color: "#888", marginBottom: 14, lineHeight: 1.6 }}>
          While shipping is off, checkout charges no delivery fee and nothing shipping-related is shown to customers.
          Rates apply to new orders only.
        </p>

        <div style={{ marginBottom: 18 }}>
          <label style={{ fontSize: 13, display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="checkbox"
              data-shipping-enabled-toggle="1"
              checked={enabled === true}
              disabled={toggleDisabled}
              onChange={(e) => { void toggleFlag(e.target.checked); }}
            />
            Enable shipping charges &amp; couriers
          </label>
          {enabled === false && !canEnable && readiness ? (
            <div data-shipping-readiness-hint="1" style={{ fontSize: 12, color: "#B45309", marginTop: 6 }}>
              {schemaReady
                ? `Create exactly one active default zone to enable shipping (currently ${readiness.activeDefaultZones ?? 0}).`
                : "Shipping needs a one-time database update (migration 0009). Ask the owner to apply it."}
            </div>
          ) : null}
        </div>

        {/* Zones */}
        <h4 style={{ fontSize: 13, margin: "0 0 8px" }}>Zones</h4>
        <div className="table-wrap" style={{ marginBottom: 14 }}>
          <table data-shipping-zones="1">
            <thead>
              <tr>
                <th>Zone</th><th>Cities</th><th>Provinces</th><th>Default</th><th>Rate</th>
                <th>Free over</th><th>Estimate</th>{zoneOpsFields && <th>Delivery</th>}<th>Active</th><th>Sort</th><th />
              </tr>
            </thead>
            <tbody>
              {zonesLoaded && zones.length === 0 && (
                <tr><td colSpan={zoneOpsFields ? 11 : 10} style={{ textAlign: "center", color: "#888", padding: 20 }}>
                  No zones yet. Add a default zone first.
                </td></tr>
              )}
              {zones.map((z) => (
                <tr key={z.id}>
                  <td style={{ fontWeight: 600 }}>{z.name}</td>
                  <td style={{ fontSize: 12 }}>{listPreview(z.cities)}</td>
                  <td style={{ fontSize: 12 }}>{listPreview(z.provinces)}</td>
                  <td>{z.is_default ? <span className="status-badge status-delivered">Default</span> : "—"}</td>
                  <td>{z.rate}</td>
                  <td>{z.free_min === null ? "—" : z.free_min}</td>
                  <td style={{ fontSize: 12 }}>{z.estimate_text || "—"}</td>
                  {zoneOpsFields && (
                    <td style={{ fontSize: 12 }} data-zone-delivery-method={z.delivery_method ?? "courier"}>
                      {z.delivery_method === "own_rider"
                        ? `Own rider${z.same_day_cutoff ? ` (before ${String(z.same_day_cutoff).slice(0, 5)})` : ""}`
                        : "Courier"}
                    </td>
                  )}
                  <td>
                    <input type="checkbox" checked={z.active} disabled={busy}
                      onChange={(e) => { void patchZoneActive(z, e.target.checked); }} />
                  </td>
                  <td>{z.sort_order}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button className="action-btn btn-edit" disabled={busy} onClick={() => editZone(z)}>Edit</button>{" "}
                    <button className="action-btn btn-delete" disabled={busy} onClick={() => { void deleteZone(z); }}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div style={{ border: "1px solid #E5E5E5", borderRadius: 10, padding: 14, marginBottom: 22 }} data-shipping-zone-form="1">
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>
            {zoneForm.id === null ? "Add zone" : `Edit zone #${zoneForm.id}`}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginBottom: 12 }}>
            <label style={{ fontSize: 12 }}>Name<br />
              <input style={{ ...inputStyle, width: 180 }} maxLength={120} value={zoneForm.name}
                onChange={(e) => setZ("name", e.target.value)} />
            </label>
            <label style={{ fontSize: 12 }}>Rate (Rs.)<br />
              <input style={{ ...inputStyle, width: 100 }} inputMode="decimal" value={zoneForm.rate}
                onChange={(e) => setZ("rate", e.target.value)} />
            </label>
            <label style={{ fontSize: 12 }}>Free over (Rs., optional)<br />
              <input style={{ ...inputStyle, width: 140 }} inputMode="decimal" value={zoneForm.free_min}
                onChange={(e) => setZ("free_min", e.target.value)} />
            </label>
            <label style={{ fontSize: 12 }}>Delivery estimate<br />
              <input style={{ ...inputStyle, width: 200 }} maxLength={120} placeholder="e.g. 2-3 working days"
                value={zoneForm.estimate_text} onChange={(e) => setZ("estimate_text", e.target.value)} />
            </label>
            <label style={{ fontSize: 12 }}>Sort order<br />
              <input style={{ ...inputStyle, width: 80 }} inputMode="numeric" value={zoneForm.sort_order}
                onChange={(e) => setZ("sort_order", e.target.value)} />
            </label>
          </div>
          {zoneOpsFields && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginBottom: 12 }} data-zone-delivery-fields="1">
              <label style={{ fontSize: 12 }}>Delivery method<br />
                <select style={{ ...inputStyle, width: 180 }} data-zone-delivery-method-select="1"
                  value={zoneForm.delivery_method}
                  onChange={(e) => setZ("delivery_method", e.target.value === "own_rider" ? "own_rider" : "courier")}>
                  <option value="courier">Courier (tracking number)</option>
                  <option value="own_rider">Own rider</option>
                </select>
              </label>
              <label style={{ fontSize: 12 }}>Same-day cut-off (optional)<br />
                <input style={{ ...inputStyle, width: 130 }} type="time" data-zone-cutoff="1"
                  value={zoneForm.same_day_cutoff}
                  disabled={zoneForm.delivery_method !== "own_rider"}
                  onChange={(e) => setZ("same_day_cutoff", e.target.value)} />
              </label>
              <div style={{ fontSize: 11, color: "#888", alignSelf: "flex-end", maxWidth: 320 }}>
                Cut-off is a Pakistan wall-clock time. Customers see &ldquo;Same-day delivery for orders before HH:MM&rdquo; for own-rider zones.
              </div>
            </div>
          )}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginBottom: 12 }}>
            <LocationMultiSelect
              label="Cities"
              testId="cities"
              values={selectedCities}
              options={cityOptions}
              blockedKeys={blockedCityKeys}
              disabled={busy}
              allowCustom
              customPlaceholder="Search or add a city…"
              onChange={(next) => setZ("cities", joinLocationList(next))}
            />
            <LocationMultiSelect
              label="Provinces"
              testId="provinces"
              values={selectedProvinces}
              options={provinceOptions}
              blockedKeys={blockedProvinceKeys}
              disabled={busy}
              allowCustom
              customPlaceholder="Search or add a province…"
              onChange={(next) => setZ("provinces", joinLocationList(next))}
            />
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 18, alignItems: "center", marginBottom: 12 }}>
            <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
              <input type="checkbox" checked={zoneForm.is_default}
                onChange={(e) => setZ("is_default", e.target.checked)} />
              Default zone (used when no city / province matches)
            </label>
            <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
              <input type="checkbox" checked={zoneForm.active}
                onChange={(e) => setZ("active", e.target.checked)} />
              Active
            </label>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="add-btn" disabled={busy} onClick={() => { void saveZone(); }}>
              {busy ? "Saving…" : zoneForm.id === null ? "Add zone" : "Save zone"}
            </button>
            {zoneForm.id !== null && (
              <button className="modal-cancel" disabled={busy} onClick={() => setZoneForm(EMPTY_ZONE)}>Cancel edit</button>
            )}
          </div>
        </div>

        {/* Couriers */}
        <h4 style={{ fontSize: 13, margin: "0 0 8px" }}>Couriers</h4>
        <div className="table-wrap" style={{ marginBottom: 14 }}>
          <table data-shipping-couriers="1">
            <thead>
              <tr><th>Courier</th><th>Tracking link</th><th>Active</th><th>Sort</th><th /></tr>
            </thead>
            <tbody>
              {couriersLoaded && couriers.length === 0 && (
                <tr><td colSpan={5} style={{ textAlign: "center", color: "#888", padding: 20 }}>No couriers yet.</td></tr>
              )}
              {couriers.map((c) => (
                <tr key={c.id}>
                  <td style={{ fontWeight: 600 }}>{c.name}</td>
                  <td style={{ fontSize: 12, wordBreak: "break-all" }}>{c.tracking_url_template || "—"}</td>
                  <td>
                    <input type="checkbox" checked={c.active} disabled={busy}
                      onChange={(e) => { void patchCourierActive(c, e.target.checked); }} />
                  </td>
                  <td>{c.sort_order}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button className="action-btn btn-edit" disabled={busy} onClick={() => editCourier(c)}>Edit</button>{" "}
                    <button className="action-btn btn-delete" disabled={busy} onClick={() => { void deleteCourier(c); }}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div style={{ border: "1px solid #E5E5E5", borderRadius: 10, padding: 14 }} data-shipping-courier-form="1">
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>
            {courierForm.id === null ? "Add courier" : `Edit courier #${courierForm.id}`}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginBottom: 12 }}>
            <label style={{ fontSize: 12 }}>Name<br />
              <input style={{ ...inputStyle, width: 180 }} maxLength={100} value={courierForm.name}
                onChange={(e) => setC("name", e.target.value)} />
            </label>
            <label style={{ fontSize: 12 }}>Tracking link template<br />
              <input style={{ ...inputStyle, width: 360 }} maxLength={500}
                placeholder="https://courier.example/track/{tracking}"
                value={courierForm.tracking_url_template}
                onChange={(e) => setC("tracking_url_template", e.target.value)} />
            </label>
            <label style={{ fontSize: 12 }}>Sort order<br />
              <input style={{ ...inputStyle, width: 80 }} inputMode="numeric" value={courierForm.sort_order}
                onChange={(e) => setC("sort_order", e.target.value)} />
            </label>
            <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center", alignSelf: "flex-end" }}>
              <input type="checkbox" checked={courierForm.active}
                onChange={(e) => setC("active", e.target.checked)} />
              Active
            </label>
          </div>
          <div style={{ fontSize: 11, color: "#888", marginBottom: 10 }}>
            Optional. Must be an https link containing <code>{"{tracking}"}</code>, which is replaced by the tracking number.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="add-btn" disabled={busy} onClick={() => { void saveCourier(); }}>
              {busy ? "Saving…" : courierForm.id === null ? "Add courier" : "Save courier"}
            </button>
            {courierForm.id !== null && (
              <button className="modal-cancel" disabled={busy} onClick={() => setCourierForm(EMPTY_COURIER)}>Cancel edit</button>
            )}
          </div>
        </div>

        <DeliveryOpsPanel
          flags={opsFlags}
          info={opsInfo}
          zones={zones.map((z) => ({ id: z.id, name: z.name, active: z.active }))}
          shippingEnabled={enabled === true}
          onSettingsChanged={reload}
        />
      </div>
    </div>
  );
}
