"use client";

import { useCallback, useEffect, useState } from "react";
import { CUSTOMER_TEXTS } from "@/lib/customerTexts";
import AccountShell from "../AccountShell";
import { accountFetch } from "../accountClient";

type Address = {
  id: number;
  label: string | null;
  full_name: string;
  phone: string;
  line1: string;
  line2: string | null;
  city: string;
  province: string | null;
  postcode: string | null;
  is_default: number | boolean;
};

type FormState = {
  label: string;
  full_name: string;
  phone: string;
  line1: string;
  line2: string;
  city: string;
  province: string;
  postcode: string;
  is_default: boolean;
};

const EMPTY: FormState = {
  label: "",
  full_name: "",
  phone: "",
  line1: "",
  line2: "",
  city: "",
  province: "",
  postcode: "",
  is_default: false,
};

function AddressesManager({ defaultName, defaultPhone }: { defaultName: string; defaultPhone: string }) {
  const [addresses, setAddresses] = useState<Address[] | null>(null);
  const [error, setError] = useState("");
  // null = form closed; "new" = creating; number = editing that address id
  const [editing, setEditing] = useState<null | "new" | number>(null);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const r = await accountFetch<{ addresses: Address[] }>("/api/account/addresses");
    if (r.ok) setAddresses(r.data?.addresses ?? []);
    else setError(r.error);
  }, []);

  useEffect(() => {
    let cancelled = false;
    accountFetch<{ addresses: Address[] }>("/api/account/addresses").then((r) => {
      if (cancelled) return;
      if (r.ok) setAddresses(r.data?.addresses ?? []);
      else setError(r.error);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const set = (key: keyof FormState, value: string | boolean) =>
    setForm((f) => ({ ...f, [key]: value }));

  const openNew = () => {
    setForm({ ...EMPTY, full_name: defaultName, phone: defaultPhone });
    setEditing("new");
    setError("");
  };

  const openEdit = (a: Address) => {
    setForm({
      label: a.label || "",
      full_name: a.full_name,
      phone: a.phone,
      line1: a.line1,
      line2: a.line2 || "",
      city: a.city,
      province: a.province || "",
      postcode: a.postcode || "",
      is_default: Number(a.is_default) === 1,
    });
    setEditing(a.id);
    setError("");
  };

  const save = async () => {
    if (editing === null) return;
    setSaving(true);
    setError("");
    const payload = { ...form, is_default: form.is_default ? 1 : 0 };
    const r =
      editing === "new"
        ? await accountFetch("/api/account/addresses", { method: "POST", body: payload })
        : await accountFetch("/api/account/addresses", {
            method: "PATCH",
            body: { id: editing, ...payload },
          });
    setSaving(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setEditing(null);
    await load();
  };

  const remove = async (id: number) => {
    if (!window.confirm(`${CUSTOMER_TEXTS.ACCOUNT_ADDRESS_DELETE}?`)) return;
    setError("");
    const r = await accountFetch(`/api/account/addresses?id=${id}`, { method: "DELETE" });
    if (!r.ok) setError(r.error);
    await load();
  };

  const makeDefault = async (id: number) => {
    setError("");
    const r = await accountFetch("/api/account/addresses", {
      method: "PATCH",
      body: { id, is_default: 1 },
    });
    if (!r.ok) setError(r.error);
    await load();
  };

  const canSave =
    form.full_name.trim() && form.phone.trim() && form.line1.trim() && form.city.trim();

  const field = (
    key: keyof FormState,
    label: string,
    opts: { required?: boolean; type?: string } = {}
  ) => (
    <div className="acc-field">
      <label className="acc-label" htmlFor={`addr-${key}`}>
        {label}
        {opts.required ? " *" : ""}
      </label>
      <input
        id={`addr-${key}`}
        className="acc-input"
        type={opts.type || "text"}
        value={String(form[key])}
        onChange={(e) => set(key, e.target.value)}
      />
    </div>
  );

  if (addresses === null && !error) return <div className="acc-center">Loading…</div>;

  return (
    <>
      {error ? <p className="acc-error" role="alert" style={{ marginBottom: 12 }}>{error}</p> : null}

      {editing === null ? (
        <div style={{ marginBottom: 16 }}>
          <button type="button" className="acc-btn small" onClick={openNew}>
            {CUSTOMER_TEXTS.ACCOUNT_ADDRESS_ADD}
          </button>
        </div>
      ) : (
        <form
          className="acc-card"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSave) save();
          }}
        >
          <h3>
            {editing === "new" ? CUSTOMER_TEXTS.ACCOUNT_ADDRESS_ADD : CUSTOMER_TEXTS.ACCOUNT_ADDRESS_EDIT}
          </h3>
          {field("label", "Label (Home, Office…)")}
          <div className="acc-row2">
            {field("full_name", "Full name", { required: true })}
            {field("phone", CUSTOMER_TEXTS.ACCOUNT_PHONE_LABEL, { required: true, type: "tel" })}
          </div>
          {field("line1", "Address", { required: true })}
          {field("line2", "Apartment, area (optional)")}
          <div className="acc-row2">
            {field("city", "City", { required: true })}
            {field("province", "Province")}
          </div>
          {field("postcode", "Postcode")}
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14, marginBottom: 14 }}>
            <input
              type="checkbox"
              checked={form.is_default}
              onChange={(e) => set("is_default", e.target.checked)}
            />
            {CUSTOMER_TEXTS.ACCOUNT_ADDRESS_SET_DEFAULT}
          </label>
          <div className="acc-actions" style={{ marginTop: 0 }}>
            <button type="submit" className="acc-btn small" disabled={saving || !canSave}>
              {CUSTOMER_TEXTS.ACCOUNT_PROFILE_SAVE}
            </button>
            <button type="button" className="acc-btn small ghost" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {addresses && addresses.length === 0 && editing === null ? (
        <div className="acc-center">{CUSTOMER_TEXTS.ACCOUNT_ADDRESS_EMPTY}</div>
      ) : null}

      {(addresses ?? []).map((a) => {
        const isDefault = Number(a.is_default) === 1;
        return (
          <div className="acc-card" key={a.id}>
            <h3>
              {a.label || a.full_name}
              {isDefault ? <span className="acc-badge default">{CUSTOMER_TEXTS.ACCOUNT_ADDRESS_DEFAULT}</span> : null}
            </h3>
            <p className="acc-muted">
              {a.full_name} · {a.phone}
              <br />
              {[a.line1, a.line2, a.city, a.province, a.postcode].filter(Boolean).join(", ")}
            </p>
            <div className="acc-actions">
              <button type="button" className="acc-btn small ghost" onClick={() => openEdit(a)}>
                {CUSTOMER_TEXTS.ACCOUNT_ADDRESS_EDIT}
              </button>
              {!isDefault ? (
                <button type="button" className="acc-btn small ghost" onClick={() => makeDefault(a.id)}>
                  {CUSTOMER_TEXTS.ACCOUNT_ADDRESS_SET_DEFAULT}
                </button>
              ) : null}
              <button type="button" className="acc-btn small danger" onClick={() => remove(a.id)}>
                {CUSTOMER_TEXTS.ACCOUNT_ADDRESS_DELETE}
              </button>
            </div>
          </div>
        );
      })}
    </>
  );
}

export default function AccountAddressesPage() {
  return (
    <AccountShell title={CUSTOMER_TEXTS.ACCOUNT_ADDRESSES_TITLE}>
      {(me) => <AddressesManager defaultName={me.name || ""} defaultPhone={me.phone_norm} />}
    </AccountShell>
  );
}
